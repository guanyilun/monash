import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import type { AgentContext } from "agent-sh/types";
import { STDLIB_CATALOG } from "./stdlib/index.ts";
// LIPS 1.0's ESM build exposes named exports with no default; older builds (and
// the CJS interop path) put everything under `default`. Accept both.
import * as lipsNs from "@jcubic/lips";
const lips: any = (lipsNs as any).default ?? lipsNs;

type ToolResult = {
  content: string; exitCode: number | null; isError: boolean;
  display?: any;
};
type ToolExecutor = (args: Record<string, unknown>) => Promise<ToolResult>;
type Bus = { emit: (event: string, payload: any) => void };

let callCounter = 0;
async function withDisplay(
  bus: Bus, toolName: string, kind: string, rawInput: any, displayDetail: string,
  run: () => Promise<ToolResult>,
): Promise<ToolResult> {
  const toolCallId = `scheme-${toolName}-${++callCounter}`;
  bus.emit("agent:tool-started", {
    title: toolName, toolCallId, kind, rawInput, displayDetail, nested: true,
  });
  const result = await run();
  if (result.content) bus.emit("agent:tool-output-chunk", { toolCallId, chunk: result.content });
  bus.emit("agent:tool-completed", {
    toolCallId,
    exitCode: result.exitCode,
    rawOutput: result.content,
    kind,
    resultDisplay: result.display,
    nested: true,
  });
  return result;
}

const { Pair, nil, LSymbol, LNumber, bootstrap, LString, LCharacter } = lips as any;

// LIPS 1.0 boxes string literals as LString; unbox to a JS primitive so the gap
// shims and host bridge (which assume JS strings) operate on them correctly.
const toJsStr = (x: any): any =>
  x instanceof LString ? x.toString()
  : LCharacter && x instanceof LCharacter ? x.valueOf()
  : x;

// LIPS 1.0 stores a symbol's name in `__name__`; `.name` is undefined (the 0.x
// build used `.name`). Read every symbol name through this so both builds work.
const symName = (x: any): string | undefined =>
  x instanceof LSymbol ? ((x as any).__name__ ?? (x as any).name) : undefined;

const CONFIG_DIR = process.env.AGENT_SH_HOME
  ? path.resolve(process.env.AGENT_SH_HOME)
  : path.join(os.homedir(), ".agent-sh");
const LOG_PATH = path.join(CONFIG_DIR, "scheme-eval.log");
export const MAX_OUTPUT_LEN = 128 * 1024;

// Split a write-style list's inner text into its top-level parts (groups stay
// whole, strings stay whole, atoms split on whitespace, `.` is its own token).
function topLevelParts(s: string): string[] {
  const parts: string[] = [];
  let depth = 0, inStr = false, esc = false, cur = "";
  const flush = () => { if (cur.length) { parts.push(cur); cur = ""; } };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) { cur += ch; if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; cur += ch; continue; }
    if (ch === "(") { depth++; cur += ch; continue; }
    if (ch === ")") { depth--; cur += ch; if (depth === 0) flush(); continue; }
    if (depth === 0 && /\s/.test(ch)) { flush(); continue; }
    cur += ch;
  }
  flush();
  return parts;
}
const innerOf = (g: string): string => (g.startsWith("(") && g.endsWith(")") ? g.slice(1, -1) : g);
const isSymbolToken = (t?: string): boolean =>
  !!t && !t.startsWith("(") && !t.startsWith('"') && t !== "." && !/^[-+]?\d/.test(t);
// A record is a list whose first element is itself a list — distinguishes a list
// of records (papers) from a single nested record `(meta (a . 1) (b . 2))`.
const recordLike = (t: string): boolean =>
  t.startsWith("(") && (topLevelParts(innerOf(t))[0] ?? "").startsWith("(");

export function summarizeResult(content: string, isError: boolean): string {
  if (isError) return "error";
  const c = content;
  if (c === "") return "ok";
  if (c === "true" || c === "false") return c;
  if (/^-?\d+(\.\d+)?$/.test(c)) return c;
  if (c.startsWith('"') && c.endsWith('"')) {
    // Count newlines in string literal content. `format()` JSON-stringifies,
    // so newlines appear as the 2-char escape `\n`.
    const inner = c.slice(1, -1);
    let nl = 0;
    for (let i = 0; i < inner.length - 1; i++) {
      if (inner[i] === "\\" && inner[i + 1] === "n") { nl++; i++; }
    }
    const lines = inner.length === 0 ? 0 : nl + 1;
    return `${lines} line${lines === 1 ? "" : "s"}`;
  }
  if (c.startsWith("(") && c.endsWith(")")) {
    const elems = topLevelParts(innerOf(c));
    const entries = elems.map((e) => topLevelParts(innerOf(e)));
    // An alist: every element is `(symbol …)`. Summarize its record-collection
    // fields by name (3 papers, 2 tables); a plain record falls back to N fields.
    const isAlist = elems.length > 0 && elems.every((e, i) => e.startsWith("(") && isSymbolToken(entries[i]![0]));
    if (isAlist) {
      const collections: string[] = [];
      for (const toks of entries) {
        const value = toks.slice(1);
        if (value[0] === ".") continue;
        if (value.length > 0 && value.every(recordLike)) collections.push(`${value.length} ${toks[0]}`);
      }
      if (collections.length) return collections.join(", ");
      return `${elems.length} field${elems.length === 1 ? "" : "s"}`;
    }
    return `${elems.length} item${elems.length === 1 ? "" : "s"}`;
  }
  if (c.includes("\n")) {
    const lines = c.split("\n").length;
    return `${lines} line${lines === 1 ? "" : "s"}`;
  }
  return c.length > 40 ? `${c.slice(0, 37)}…` : c;
}

function logErr(where: string, err: any, extras?: Record<string, unknown>): void {
  try {
    const stamp = new Date().toISOString();
    const stack = err?.stack || `${err?.message ?? String(err)} (no stack)`;
    const code = Array.isArray(err?.code) ? "\n  scheme-frames:\n    " + err.code.join("\n    ") : "";
    const extra = extras ? "\nextras: " + JSON.stringify(extras, null, 2) : "";
    fs.appendFileSync(LOG_PATH, `\n=== ${stamp} ${where} ===\n${stack}${code}${extra}\n`);
  } catch {}
}

function alist(entries: Array<[string, unknown]>): unknown {
  let tail: any = nil;
  for (let i = entries.length - 1; i >= 0; i--) {
    const [k, v] = entries[i];
    tail = new Pair(new Pair(new LSymbol(k), v), tail);
  }
  return tail;
}

function lookup(result: unknown, key: string): unknown {
  let node: any = result;
  while (node && node instanceof Pair) {
    const entry = node.car;
    if (entry && entry.car && symName(entry.car) === key) return entry.cdr;
    node = node.cdr;
  }
  return undefined;
}

function toSchemeList(items: unknown[]): unknown {
  let tail: any = nil;
  for (let i = items.length - 1; i >= 0; i--) tail = new Pair(items[i], tail);
  return tail;
}

export type OptType = "string" | "number" | "boolean" | "any";
export type OptSpec = { type?: OptType; default?: unknown };
export type ArgSpec = string | { name: string; type?: OptType };

export type PrimitiveSpec = {
  name: string;
  signature?: string;
  doc?: string;
  fn: (...args: any[]) => any;
  raw?: boolean;
  /** Declarative positional params. Providing `args`/`opts` enables auto-parse
   *  + signature generation: `fn` then receives `(...positionals, opts)`. */
  args?: ArgSpec[];
  /** Declarative keyword options; values arrive coerced/defaulted in `opts`. */
  opts?: Record<string, OptType | OptSpec>;
  /** Return-type blurb appended to the generated signature, e.g. "(listof alist)". */
  returns?: string;
  /** Library this primitive belongs to (set automatically by `defineLibrary`). */
  library?: string;
};

export type LibrarySpec = {
  name: string;
  /** One-liner shown always in the system prompt catalog. */
  description: string;
  /** Optional longer instructions, surfaced only on `(load-library name)`. */
  doc?: string;
};
export type LibraryInfo = { name: string; description: string; count: number; builtin: boolean };
/** Handle returned by `defineLibrary`; define a library's primitives through it. */
export interface Library {
  name: string;
  definePrimitive(spec: PrimitiveSpec): void;
}
type ExtPrimitiveRegistry = Map<string, { signature?: string; doc?: string; library: string }>;
type LibraryRegistry = Map<string, { description: string; doc?: string; primitives: string[]; builtin?: boolean }>;
const MISC_LIBRARY = "misc";

function lipsToJs(v: any): any {
  if (v === nil) return [];
  if (v === undefined || v === null) return null;
  if (v instanceof LString) return v.toString();
  if (v instanceof LNumber) return v.valueOf();
  if (v instanceof LSymbol) return symName(v);
  if (v instanceof Pair) {
    const out: any[] = [];
    let node: any = v;
    while (node instanceof Pair) { out.push(lipsToJs(node.car)); node = node.cdr; }
    return node === nil ? out : [...out, lipsToJs(node)];
  }
  return v;
}

function jsToLips(v: any): any {
  if (v === undefined) return undefined;
  if (v === null) return nil;
  if (Array.isArray(v)) return toSchemeList(v.map(jsToLips));
  if (typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto === Object.prototype || proto === null) {
      return alist(Object.entries(v).map(([k, val]) => [k, jsToLips(val)]));
    }
  }
  return v;
}

// Parse ripgrep content-mode lines: "file:line:text" or (for single-file
// invocations) "line:text". When ripgrep omits the filename prefix, the
// caller passes the single-file path explicitly via fallbackFile.
function parseGrepLine(line: string, fallbackFile?: string): unknown | null {
  const i1 = line.indexOf(":");
  if (i1 < 0) return null;
  const head = line.slice(0, i1);
  const headNum = parseInt(head, 10);
  if (fallbackFile && !Number.isNaN(headNum) && String(headNum) === head) {
    return alist([
      ["file", fallbackFile],
      ["line", headNum],
      ["text", line.slice(i1 + 1)],
    ]);
  }
  const i2 = line.indexOf(":", i1 + 1);
  if (i2 < 0) return null;
  const lineNum = parseInt(line.slice(i1 + 1, i2), 10);
  if (Number.isNaN(lineNum)) return null;
  return alist([
    ["file", head],
    ["line", lineNum],
    ["text", line.slice(i2 + 1)],
  ]);
}

function stripPagination(raw: string): string[] {
  return raw.split("\n").filter((l) => l && !l.startsWith("[Showing "));
}

function format(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (v instanceof LString) v = v.toString();
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "boolean") return v ? "#t" : "#f";
  if (typeof v === "number") return String(v);
  if (v && typeof (v as any).toString === "function") {
    try { return (v as any).toString(); } catch {}
  }
  return String(v);
}

// LIPS' string lexer accepts only JSON-style escapes (\" \\ \/ \b \f \n \r \t
// \uXXXX), but models routinely write \s \w \d etc. in regex strings. Promote
// any other \X to \\X so it parses as a literal backslash + X.
function preprocessSchemeSource(source: string): string {
  const JSON_ESC = new Set(["\\", "/", '"', "b", "f", "n", "r", "t"]);
  let out = "";
  let inStr = false;
  let inComment = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\n") {
      out += c;
      inComment = false;
      continue;
    }
    if (inComment) { out += c; continue; }
    if (!inStr) {
      if (c === ";") { inComment = true; out += c; continue; }
      if (c === '"') { inStr = true; out += c; continue; }
      out += c;
      continue;
    }
    if (c === '"') { inStr = false; out += c; continue; }
    if (c !== "\\") { out += c; continue; }
    const next = source[i + 1];
    if (next === undefined) { out += c; continue; }
    if (JSON_ESC.has(next)) { out += c + next; i++; continue; }
    if (next === "u") {
      const hex = source.slice(i + 2, i + 6);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += "\\u" + hex; i += 5; continue; }
      out += "\\\\u";
      i++;
      continue;
    }
    out += "\\\\" + next;
    i++;
  }
  return out;
}

// LIPS has no keyword syntax, so a bare `:foo` evaluates as a variable and
// errors. Bind every `:keyword` token in the source to a self-quoting symbol
// before eval, so option-style args reach the primitive (built-in or extension)
// as a symbol it can read. Tokens inside strings/comments are skipped; a stray
// binding would be harmless anyway since `:`-names are never variables.
function bindKeywordSymbols(env: any, source: string): void {
  let inStr = false, inComment = false, esc = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (inComment) { if (c === "\n") inComment = false; continue; }
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === ";") { inComment = true; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === ":" && /[A-Za-z]/.test(source[i + 1] ?? "")) {
      let j = i + 1;
      while (j < source.length && /[\w-]/.test(source[j]!)) j++;
      const kw = source.slice(i, j);
      if ((env as any).get(kw, { throwError: false }) === undefined) {
        env.set(kw, new LSymbol(kw));
      }
      i = j - 1;
    }
  }
}

function formatStringEscapeDiagnostic(source: string, baseMsg: string): string {
  const JSON_ESC = new Set(["\\", "/", '"', "b", "f", "n", "r", "t"]);
  let line = 1, col = 1;
  let inStr = false, inComment = false;
  const bad: { line: number; col: number; seq: string }[] = [];
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\n") { line++; col = 1; inComment = false; continue; }
    if (inComment) { col++; continue; }
    if (!inStr) {
      if (c === ";") { inComment = true; col++; continue; }
      if (c === '"') { inStr = true; col++; continue; }
      col++;
      continue;
    }
    if (c === '"') { inStr = false; col++; continue; }
    if (c === "\\") {
      const next = source[i + 1];
      if (next === undefined) { col++; continue; }
      let valid = JSON_ESC.has(next);
      if (next === "u") {
        valid = /^[0-9a-fA-F]{4}$/.test(source.slice(i + 2, i + 6));
      }
      if (!valid) bad.push({ line, col, seq: "\\" + next });
      i++; col += 2;
      continue;
    }
    col++;
  }
  if (bad.length === 0) return baseMsg;
  const MAX = 5;
  const shown = bad.slice(0, MAX)
    .map((b) => `line ${b.line} col ${b.col} (${b.seq})`).join(", ");
  const extra = bad.length > MAX ? ` (… ${bad.length - MAX} more)` : "";
  return baseMsg +
    `\n  ${bad.length} invalid string escape(s): ${shown}${extra}` +
    `\n  LIPS strings use JSON escapes: \\\\ \\" \\n \\r \\t \\b \\f \\uXXXX.` +
    ` For a literal backslash write \\\\.`;
}

function analyzeParens(source: string): {
  unmatchedOpens: { line: number; col: number; lead: string }[];
  unmatchedCloses: { line: number; col: number }[];
} {
  const stack: { line: number; col: number; lead: string }[] = [];
  const unmatchedCloses: { line: number; col: number }[] = [];
  let line = 1, col = 1;
  let inStr = false, esc = false, inComment = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\n") { line++; col = 1; inComment = false; continue; }
    if (inComment) { col++; continue; }
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      col++; continue;
    }
    if (c === ";") { inComment = true; col++; continue; }
    if (c === '"') { inStr = true; col++; continue; }
    if (c === "(") {
      let j = i + 1;
      while (j < source.length && /\s/.test(source[j])) j++;
      let k = j;
      while (k < source.length && !/[\s()";]/.test(source[k])) k++;
      stack.push({ line, col, lead: source.slice(j, k) });
      col++; continue;
    }
    if (c === ")") {
      if (stack.length === 0) unmatchedCloses.push({ line, col });
      else stack.pop();
      col++; continue;
    }
    col++;
  }
  return { unmatchedOpens: stack, unmatchedCloses };
}

function formatParenDiagnostic(source: string, baseMsg: string): string {
  const a = analyzeParens(source);
  const parts: string[] = [baseMsg];
  const MAX = 5;
  if (a.unmatchedOpens.length > 0) {
    const shown = a.unmatchedOpens.slice(-MAX).map(
      (o) => `line ${o.line} col ${o.col} (${o.lead || "?"})`
    ).join(", ");
    const extra = a.unmatchedOpens.length > MAX
      ? ` (… ${a.unmatchedOpens.length - MAX} more)` : "";
    parts.push(`  ${a.unmatchedOpens.length} unmatched '(' — opened at ${shown}${extra}`);
  }
  if (a.unmatchedCloses.length > 0) {
    const shown = a.unmatchedCloses.slice(0, MAX).map(
      (o) => `line ${o.line} col ${o.col}`
    ).join(", ");
    const extra = a.unmatchedCloses.length > MAX
      ? ` (… ${a.unmatchedCloses.length - MAX} more)` : "";
    parts.push(`  ${a.unmatchedCloses.length} unmatched ')' at ${shown}${extra}`);
  }
  if (a.unmatchedOpens.length === 0 && a.unmatchedCloses.length === 0) {
    const tail = source.slice(-120).replace(/\n/g, " ⏎ ");
    parts.push(`  (analyzer sees balanced parens; likely string/comment edge case) source tail: …${tail}`);
  }
  return parts.join("\n");
}

type TimeoutController = {
  run(work: Promise<any>, timeoutMs: number): Promise<any>;
  pause(): void;
  resume(): void;
};
function createTimeoutController(): TimeoutController {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onFire: (() => void) | null = null;
  let remaining = 0;
  let armedAt = 0;
  let depth = 0;
  const arm = (delay: number): void => {
    armedAt = Date.now();
    timer = setTimeout(() => onFire?.(), Math.max(0, delay));
  };
  return {
    run(work, timeoutMs) {
      remaining = timeoutMs;
      depth = 0;
      return new Promise((resolve, reject) => {
        onFire = () => reject(new Error(`evaluation timed out after ${timeoutMs}ms`));
        arm(timeoutMs);
        const settle = (): void => { if (timer) clearTimeout(timer); timer = null; onFire = null; };
        work.then((v) => { settle(); resolve(v); }, (e) => { settle(); reject(e); });
      });
    },
    pause() {
      if (depth++ === 0 && timer) {
        clearTimeout(timer);
        remaining -= Date.now() - armedAt;
        timer = null;
      }
    },
    resume() {
      if (depth > 0 && --depth === 0 && !timer && onFire) arm(remaining);
    },
  };
}

async function evaluate(env: any, source: string, timeoutMs: number, ctl: TimeoutController = createTimeoutController(), catalog?: Map<string, { library?: string }>) {
  const preprocessed = preprocessSchemeSource(source);
  bindKeywordSymbols(env, source);
  // Capture output into the result instead of letting it vanish to console.log.
  // LIPS 1.0's native display/write resolve the *functions* from the env (the
  // stdout-port override alone misses them), so shadow each output procedure.
  const OUTPUT_PROCS = ["stdout", "display", "write", "write-string", "write-char"];
  const prev: Record<string, any> = {};
  for (const name of OUTPUT_PROCS) prev[name] = (env as any).get(name, { throwError: false });
  const buf: string[] = [];
  const raw = (a: any): string => {
    if (a === null || a === undefined) return "";
    if (typeof a === "string") return a;
    if (a && typeof (a as any).toString === "function") return (a as any).toString();
    return String(a);
  };
  (env as any).set("stdout", { write: (...args: any[]) => { for (const a of args) buf.push(raw(a)); } });
  (env as any).set("display", (...args: any[]) => { buf.push(args.map(raw).join("")); });
  (env as any).set("write", (...args: any[]) => {
    buf.push(args.map((a) => (typeof toJsStr(a) === "string" ? JSON.stringify(toJsStr(a)) : raw(a))).join(""));
  });
  (env as any).set("write-string", (...args: any[]) => { buf.push(raw(args[0])); });
  (env as any).set("write-char", (...args: any[]) => { buf.push(raw(args[0])); });
  try {
    const results = await ctl.run((lips as any).exec(preprocessed, { env }), timeoutMs);
    const last = Array.isArray(results) && results.length > 0 ? results[results.length - 1] : undefined;
    const displayed = buf.join("");
    const join = (a: string, b: string) => (a && b ? a + (a.endsWith("\n") ? "" : "\n") + b : a || b);
    // value = write-style (quoted list elements) for the LLM + summary count; display = raw for the body.
    const unwrapped = toJsStr(last);
    const value = join(displayed, last instanceof Pair ? (last as any).toString(true) : format(last));
    const display = join(displayed, typeof unwrapped === "string" ? unwrapped : format(last));
    return { ok: true as const, value, display };
  } catch (e: any) {
    logErr("evaluate", e, { source: source.slice(0, 400) });
    let msg = e?.message ?? String(e);
    if (/[Uu]nbalanced parenthes/.test(msg)) {
      msg = formatParenDiagnostic(source, msg);
    } else if (/Invalid string literal|Bad escaped character|Unexpected.*JSON|JSON at position/.test(msg)) {
      msg = formatStringEscapeDiagnostic(source, msg);
    } else if (msg.includes("Unbound variable `#\\")) {
      msg += "\n  Unknown character literal. Supported: #\\newline #\\space #\\tab" +
        " #\\return #\\null #\\delete #\\escape, #\\xNN, and #\\<char>.";
    } else if (/Unbound variable `[^']+'/.test(msg)) {
      const bad = msg.match(/Unbound variable `([^']+)'/)?.[1];
      const hits = bad ? suggestNames(bad, environmentNames(env)) : [];
      if (hits.length > 0) {
        const labeled = hits.map((n) => {
          const lib = catalog?.get(n)?.library;
          return lib ? `${n} (in ${lib})` : n;
        });
        msg += `\n  Did you mean: ${labeled.join(", ")}?`;
        if (hits.some((n) => catalog?.get(n)?.library)) {
          msg += " — (load-library 'name) lists that library's full API.";
        }
      }
    } else if (/Expecting .* got boolean/.test(msg)) {
      msg += "\n  A boolean (almost always an unchecked #f) reached a slot needing a real value —" +
        " usually a search/lookup that found nothing: string-index, string-contains, member, assoc," +
        " find, hash-ref…. Guard it: (if v (… v …) fallback) or (or v default).";
    }
    return { ok: false as const, error: msg };
  } finally {
    for (const name of OUTPUT_PROCS) {
      if (prev[name] !== undefined) (env as any).set(name, prev[name]);
    }
  }
}

// Fill the gaps the bootstrapped std library leaves: SRFI-1 helpers, Racket
// spellings, and cross-dialect aliases. std covers R7RS base, but a model
// trained on Racket/Chicken/Guile still reaches for names std doesn't bind.
// defineIfMissing so anything std already provides wins.
function installStdShims(env: any): void {
  const defineIfMissing = (name: string, fn: any) => {
    if ((env as any).get(name, { throwError: false }) === undefined) env.set(name, fn);
  };
  const pairToArray = (p: any): any[] => {
    const out: any[] = [];
    while (p instanceof Pair) { out.push(p.car); p = p.cdr; }
    return out;
  };
  const truthy = (v: any) => v !== false;

  // LIPS wraps numbers as LNumber instances, so `===` fails on equal-valued
  // numbers from different sources. Handle the wrapper types before recursing.
  const atomEqual = (a: any, b: any): boolean => {
    if (a === b) return true;
    const sa = toJsStr(a), sb = toJsStr(b);
    if (typeof sa === "string" && typeof sb === "string") return sa === sb;
    if (a instanceof LNumber && b instanceof LNumber) return a.cmp(b) === 0;
    if (typeof a === "number" && b instanceof LNumber) return LNumber(a).cmp(b) === 0;
    if (typeof b === "number" && a instanceof LNumber) return LNumber(b).cmp(a) === 0;
    if (a instanceof LSymbol && b instanceof LSymbol) return symName(a) === symName(b);
    return false;
  };
  const stdEqual = (env as any).get("equal?", { throwError: false });
  const isAtom = (x: any): boolean =>
    x == null || x === nil ||
    typeof x === "string" || typeof x === "number" || typeof x === "boolean" ||
    x instanceof LString || x instanceof LNumber || x instanceof LSymbol;
  const lipsEqual = (a: any, b: any): boolean => {
    if (atomEqual(a, b)) return true;
    if (a == null || b == null) return a == b;
    if (a instanceof Pair && b instanceof Pair) {
      return lipsEqual(a.car, b.car) && lipsEqual(a.cdr, b.cdr);
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!lipsEqual(a[i], b[i])) return false;
      return true;
    }
    if (isAtom(a) || isAtom(b)) return false;
    return stdEqual ? truthy(stdEqual(a, b)) : false;
  };

  const sameWith = (compare: any, fallback: (a: any, b: any) => boolean) =>
    typeof compare === "function" ? (a: any, b: any) => compare(a, b) !== false : fallback;
  const assocImpl = (fallback: (a: any, b: any) => boolean) =>
    (key: any, alist: any, compare?: any) => {
      const same = sameWith(compare, fallback);
      let cur: any = alist;
      while (cur instanceof Pair) {
        if (cur.car instanceof Pair && same(key, cur.car.car)) return cur.car;
        cur = cur.cdr;
      }
      return false;
    };
  const memberImpl = (fallback: (a: any, b: any) => boolean) =>
    (key: any, lst: any, compare?: any) => {
      const same = sameWith(compare, fallback);
      let cur: any = lst;
      while (cur instanceof Pair) {
        if (same(key, cur.car)) return cur;
        cur = cur.cdr;
      }
      return false;
    };
  env.set("assoc", assocImpl(lipsEqual));
  env.set("assq", assocImpl(atomEqual));
  env.set("assv", assocImpl(atomEqual));
  env.set("member", memberImpl(lipsEqual));
  env.set("memq", memberImpl(atomEqual));
  env.set("memv", memberImpl(atomEqual));
  env.set("equal?", lipsEqual);

  defineIfMissing("first",  (lst: any) => pairToArray(lst)[0]);
  defineIfMissing("second", (lst: any) => pairToArray(lst)[1]);
  defineIfMissing("third",  (lst: any) => pairToArray(lst)[2]);
  defineIfMissing("fourth", (lst: any) => pairToArray(lst)[3]);
  defineIfMissing("fifth",  (lst: any) => pairToArray(lst)[4]);
  defineIfMissing("last",   (lst: any) => { const a = pairToArray(lst); return a[a.length - 1]; });
  defineIfMissing("list-head", (lst: any, n: any) =>
    toSchemeList(pairToArray(lst).slice(0, Math.max(0, Math.floor(Number(n) || 0)))));
  defineIfMissing("take-while", (pred: any, lst: any) => {
    const out: any[] = [];
    for (const x of pairToArray(lst)) { if (!truthy(pred(x))) break; out.push(x); }
    return toSchemeList(out);
  });
  defineIfMissing("drop-while", (pred: any, lst: any) => {
    const a = pairToArray(lst); let i = 0;
    while (i < a.length && truthy(pred(a[i]))) i++;
    return toSchemeList(a.slice(i));
  });
  env.set("iota", (count: any, start: any, step: any) => {
    const n = Math.max(0, Math.floor(Number(count)));
    const s = start === undefined ? 0 : Number(start);
    const k = step === undefined ? 1 : Number(step);
    return toSchemeList(Array.from({ length: n }, (_, i) => LNumber(s + i * k)));
  });
  defineIfMissing("any",   (pred: any, lst: any) => pairToArray(lst).some((x) => truthy(pred(x))));
  defineIfMissing("count", (pred: any, lst: any) => pairToArray(lst).filter((x) => truthy(pred(x))).length);
  defineIfMissing("filter-map", (f: any, lst: any) => {
    const out: any[] = [];
    for (const x of pairToArray(lst)) { const r = f(x); if (truthy(r) && r != null) out.push(r); }
    return toSchemeList(out);
  });
  defineIfMissing("append-map", (f: any, lst: any) =>
    toSchemeList(pairToArray(lst).flatMap((x) => pairToArray(f(x)))));
  defineIfMissing("concatenate", (lol: any) =>
    toSchemeList(pairToArray(lol).flatMap(pairToArray)));
  defineIfMissing("remove", (pred: any, lst: any) =>
    toSchemeList(pairToArray(lst).filter((x) => !truthy(pred(x)))));
  defineIfMissing("delete", (item: any, lst: any) =>
    toSchemeList(pairToArray(lst).filter((x) => !lipsEqual(x, item))));
  defineIfMissing("delete-duplicates", (lst: any) => {
    const arr = pairToArray(lst);
    const out: any[] = [];
    for (const item of arr) if (!out.some((x) => lipsEqual(x, item))) out.push(item);
    return toSchemeList(out);
  });
  defineIfMissing("partition", (pred: any, lst: any) => {
    const t: any[] = []; const f: any[] = [];
    for (const x of pairToArray(lst)) (truthy(pred(x)) ? t : f).push(x);
    return new Pair(toSchemeList(t), toSchemeList(f));
  });

  defineIfMissing("string-trim-both", (s: any) => String(s).trim());
  const compileRegex = (pat: any): RegExp => {
    if (pat instanceof RegExp) return pat;
    let p = String(pat);
    let flags = "";
    const m = /^\(\?([imsx]+):/.exec(p);
    if (m && p.endsWith(")")) {
      flags = m[1].replace(/x/g, "");
      p = p.slice(m[0].length, -1);
    }
    return new RegExp(p, flags);
  };
  defineIfMissing("regexp", (pat: any) => compileRegex(pat));
  const regexpMatch = (pat: any, s: any) => {
    s = toJsStr(s);
    if (typeof s !== "string") return false;
    const m = s.match(compileRegex(pat));
    return m ? toSchemeList(Array.from(m)) : false;
  };
  defineIfMissing("regexp-match", regexpMatch);
  defineIfMissing("string-match", regexpMatch);
  defineIfMissing("match:substring", (m: any, i: any) => {
    if (m === false || m === null || m === undefined) return false;
    const idx = Math.floor(Number(i) || 0);
    if (m instanceof Pair) {
      let cur: any = m;
      let k = 0;
      while (cur instanceof Pair) {
        if (k === idx) return cur.car;
        cur = cur.cdr; k++;
      }
      return false;
    }
    return false;
  });
  defineIfMissing("regexp-match-positions", (pat: any, s: any) => {
    s = toJsStr(s);
    if (typeof s !== "string") return false;
    const m = s.match(compileRegex(pat));
    if (!m) return false;
    const start = m.index ?? 0;
    const full = new Pair(new LNumber(start), new LNumber(start + m[0].length));
    return new Pair(full, nil);
  });

  defineIfMissing("displayln", function (this: any, x: any) {
    const display = (env as any).get("display", { throwError: false });
    if (display) { display(x); display("\n"); }
  });

  defineIfMissing("error", (...msgs: any[]) => {
    throw new Error(msgs.map((m) => (typeof m === "string" ? m : String(m))).join(" "));
  });
  defineIfMissing("void", () => undefined);

  defineIfMissing("write", function (this: any, x: any) {
    const display = (env as any).get("display", { throwError: false });
    if (display) display(typeof x === "string" ? JSON.stringify(x) : x);
  });

  defineIfMissing("add1", (n: any) => Number(n) + 1);
  defineIfMissing("sub1", (n: any) => Number(n) - 1);
  defineIfMissing("sqr",  (n: any) => Number(n) * Number(n));

  defineIfMissing("string-trim",       (s: any) => String(s).trim());
  defineIfMissing("string-trim-left",  (s: any) => String(s).replace(/^\s+/, ""));
  defineIfMissing("string-trim-right", (s: any) => String(s).replace(/\s+$/, ""));
  defineIfMissing("string-prefix?", (prefix: any, s: any) =>
    String(s).startsWith(String(prefix)));
  defineIfMissing("string-suffix?", (suffix: any, s: any) =>
    String(s).endsWith(String(suffix)));
  defineIfMissing("non-empty-string?", (x: any) => {
    x = toJsStr(x);
    return typeof x === "string" && x.length > 0;
  });
  defineIfMissing("string-index", (s: any, needle: any) => {
    const i = String(s).indexOf(String(needle));
    return i < 0 ? false : i;
  });

  // std binds string-split/string-join separator-first and string-only, the
  // reverse of Racket; a Racket/Guile-trained model calls them string/list-first
  // with a whitespace default, so it silently gets the wrong shape. Override to
  // Racket order (env.set, since std already binds the names).
  const splitSep = (sep: any): RegExp => {
    if (sep === undefined) return /\s+/;
    if (sep instanceof RegExp) return sep;
    return new RegExp(String(toJsStr(sep)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  };
  env.set("string-split", (str: any, sep?: any) => {
    const s = toJsStr(str);
    if (typeof s !== "string") return nil;
    const parts = s.split(splitSep(sep));
    while (parts.length && parts[0] === "") parts.shift();
    while (parts.length && parts[parts.length - 1] === "") parts.pop();
    // Box as LString so results compose with native LIPS string ops.
    return toSchemeList(parts.map((p) => LString(p)));
  });
  env.set("string-join", (lst: any, sep?: any) => {
    const parts = pairToArray(lst).map((x) => {
      const v = toJsStr(x);
      return typeof v === "string" ? v : String(x);
    });
    return LString(parts.join(sep === undefined ? " " : String(toJsStr(sep))));
  });

  defineIfMissing("list-index", (pred: any, lst: any) => {
    let i = 0, cur: any = lst;
    while (cur instanceof Pair) {
      if (truthy(pred(cur.car))) return i;
      cur = cur.cdr; i++;
    }
    return false;
  });
  defineIfMissing("last-pair", (lst: any) => {
    let cur: any = lst;
    while (cur instanceof Pair && cur.cdr instanceof Pair) cur = cur.cdr;
    return cur;
  });
  defineIfMissing("length+", (lst: any) => {
    let n = 0, slow: any = lst, fast: any = lst;
    while (fast instanceof Pair) {
      n++;
      fast = fast.cdr;
      if (!(fast instanceof Pair)) break;
      n++;
      fast = fast.cdr;
      slow = slow.cdr;
      if (fast === slow) return false;
    }
    return n;
  });
  defineIfMissing("list-tabulate", (n: any, init: any) => {
    const count = Math.max(0, Math.floor(Number(n) || 0));
    const out: any[] = [];
    for (let i = 0; i < count; i++) out.push(init(i));
    return toSchemeList(out);
  });
  defineIfMissing("cons*", (...args: any[]) => {
    if (args.length === 0) return nil;
    if (args.length === 1) return args[0];
    let tail: any = args[args.length - 1];
    for (let i = args.length - 2; i >= 0; i--) tail = new Pair(args[i], tail);
    return tail;
  });
  defineIfMissing("append-reverse", (a: any, b: any) => {
    let cur: any = a, out: any = b;
    while (cur instanceof Pair) { out = new Pair(cur.car, out); cur = cur.cdr; }
    return out;
  });
  defineIfMissing("reduce-right", (f: any, init: any, lst: any) => {
    const arr = pairToArray(lst);
    if (arr.length === 0) return init;
    return arr.reduceRight((acc: any, x: any) => f(x, acc));
  });
  defineIfMissing("span", (pred: any, lst: any) => {
    const taken: any[] = [];
    let cur: any = lst;
    while (cur instanceof Pair && truthy(pred(cur.car))) {
      taken.push(cur.car);
      cur = cur.cdr;
    }
    return new Pair(toSchemeList(taken), cur);
  });
  defineIfMissing("break", (pred: any, lst: any) => {
    const taken: any[] = [];
    let cur: any = lst;
    while (cur instanceof Pair && !truthy(pred(cur.car))) {
      taken.push(cur.car);
      cur = cur.cdr;
    }
    return new Pair(toSchemeList(taken), cur);
  });
  defineIfMissing("alist-cons", (k: any, v: any, alist: any) =>
    new Pair(new Pair(k, v), alist));
  defineIfMissing("alist-copy", (alist: any) => {
    const out: any[] = [];
    let cur: any = alist;
    while (cur instanceof Pair) {
      const e = cur.car;
      if (e instanceof Pair) out.push(new Pair(e.car, e.cdr));
      else out.push(e);
      cur = cur.cdr;
    }
    return toSchemeList(out);
  });
  defineIfMissing("index-of", (lst: any, x: any) => {
    let i = 0, cur: any = lst;
    while (cur instanceof Pair) {
      if (atomEqual(cur.car, x)) return i;
      cur = cur.cdr; i++;
    }
    return false;
  });
  defineIfMissing("argmax", (key: any, lst: any) => {
    let best: any = false, bestKey: number = -Infinity;
    let cur: any = lst;
    while (cur instanceof Pair) {
      const k = Number(key(cur.car));
      if (k > bestKey) { bestKey = k; best = cur.car; }
      cur = cur.cdr;
    }
    return best;
  });
  defineIfMissing("argmin", (key: any, lst: any) => {
    let best: any = false, bestKey: number = Infinity;
    let cur: any = lst;
    while (cur instanceof Pair) {
      const k = Number(key(cur.car));
      if (k < bestKey) { bestKey = k; best = cur.car; }
      cur = cur.cdr;
    }
    return best;
  });
  defineIfMissing("remove-duplicates", (lst: any, same?: any) => {
    const eq = typeof same === "function" ? same : atomEqual;
    const out: any[] = [];
    let cur: any = lst;
    while (cur instanceof Pair) {
      if (!out.some((y) => eq(y, cur.car))) out.push(cur.car);
      cur = cur.cdr;
    }
    return toSchemeList(out);
  });
  defineIfMissing("group-by", (key: any, lst: any) => {
    const groups: Array<{ k: any; items: any[] }> = [];
    let cur: any = lst;
    while (cur instanceof Pair) {
      const k = key(cur.car);
      let g = groups.find((g) => atomEqual(g.k, k));
      if (!g) { g = { k, items: [] }; groups.push(g); }
      g.items.push(cur.car);
      cur = cur.cdr;
    }
    return toSchemeList(groups.map((g) => toSchemeList(g.items)));
  });

  const reCompile = (pat: any): RegExp => {
    if (pat instanceof RegExp) return pat;
    let p = String(pat);
    let flags = "";
    const m = /^\(\?([imsx]+):/.exec(p);
    if (m && p.endsWith(")")) {
      flags = m[1].replace(/x/g, "");
      p = p.slice(m[0].length, -1);
    }
    return new RegExp(p, flags);
  };
  defineIfMissing("regexp?", (x: any) => x instanceof RegExp);
  defineIfMissing("regexp-replace", (pat: any, s: any, repl: any) => {
    s = toJsStr(s);
    if (typeof s !== "string") return s;
    return s.replace(reCompile(pat), String(repl));
  });
  defineIfMissing("regexp-replace*", (pat: any, s: any, repl: any) => {
    s = toJsStr(s);
    if (typeof s !== "string") return s;
    const re = reCompile(pat);
    const global = re.flags.includes("g") ? re : new RegExp(re.source, re.flags + "g");
    return s.replace(global, String(repl));
  });
  defineIfMissing("regexp-quote", (s: any) =>
    String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  defineIfMissing("regexp-split", (pat: any, s: any) => {
    s = toJsStr(s);
    return typeof s === "string" ? toSchemeList(s.split(reCompile(pat))) : nil;
  });

  defineIfMissing("format", (fmt: any, ...rest: any[]) => {
    const f = String(fmt);
    let i = 0;
    return f.replace(/~(.)/g, (_: any, c: string) => {
      switch (c) {
        case "a": return rest[i] === undefined ? "" : (typeof rest[i++] === "string" ? rest[i-1] : (rest[i-1]).toString());
        case "s":
        case "v": { const v = rest[i++]; return typeof v === "string" ? JSON.stringify(v) : (v === undefined ? "" : v.toString()); }
        case "n":
        case "%": return "\n";
        case "~": return "~";
        default:  return "~" + c;
      }
    });
  });
  defineIfMissing("printf", function (this: any, fmt: any, ...rest: any[]) {
    const format = (env as any).get("format", { throwError: false });
    const display = (env as any).get("display", { throwError: false });
    if (format && display) display(format(fmt, ...rest));
  });
  defineIfMissing("~a", (...xs: any[]) =>
    xs.map((x) => x === undefined ? "" : (typeof x === "string" ? x : x.toString())).join(""));
  defineIfMissing("~s", (...xs: any[]) =>
    xs.map((x) => typeof x === "string" ? JSON.stringify(x) : (x === undefined ? "" : x.toString())).join(""));
  defineIfMissing("~v", (...xs: any[]) =>
    xs.map((x) => typeof x === "string" ? JSON.stringify(x) : (x === undefined ? "" : x.toString())).join(""));

  class LipsHash {
    map: Map<any, any> = new Map();
    constructor(entries?: Array<[any, any]>) {
      if (entries) for (const [k, v] of entries) this.map.set(this._key(k), v);
    }
    _key(k: any): any {
      if (k instanceof LSymbol) return "::sym::" + symName(k);
      if (typeof k === "object" && k !== null) return JSON.stringify(k);
      return k;
    }
    get(k: any, dflt: any = false) {
      const key = this._key(k);
      return this.map.has(key) ? this.map.get(key) : dflt;
    }
    set(k: any, v: any) { this.map.set(this._key(k), v); return this; }
    has(k: any) { return this.map.has(this._key(k)); }
    remove(k: any) { this.map.delete(this._key(k)); return this; }
    keys() { return Array.from(this.map.keys()).map((k) =>
      typeof k === "string" && k.startsWith("::sym::") ? new LSymbol(k.slice(7)) : k); }
    values() { return Array.from(this.map.values()); }
    size() { return this.map.size; }
  }
  defineIfMissing("make-hash", (alist?: any) => {
    const h = new LipsHash();
    if (alist instanceof Pair) {
      let cur: any = alist;
      while (cur instanceof Pair) {
        const e = cur.car;
        if (e instanceof Pair) h.set(e.car, e.cdr);
        cur = cur.cdr;
      }
    }
    return h;
  });
  defineIfMissing("hash", (...args: any[]) => {
    const h = new LipsHash();
    for (let i = 0; i + 1 < args.length; i += 2) h.set(args[i], args[i + 1]);
    return h;
  });
  defineIfMissing("hash?", (x: any) => x instanceof LipsHash);
  defineIfMissing("hash-ref", (h: any, k: any, dflt: any = false) =>
    h instanceof LipsHash ? h.get(k, dflt) : dflt);
  defineIfMissing("hash-set!", (h: any, k: any, v: any) => {
    if (h instanceof LipsHash) h.set(k, v);
    return h;
  });
  defineIfMissing("hash-set", (h: any, k: any, v: any) => {
    if (!(h instanceof LipsHash)) return h;
    const out = new LipsHash();
    h.map.forEach((vv: any, kk: any) => out.map.set(kk, vv));
    out.map.set(out._key(k), v);
    return out;
  });
  defineIfMissing("hash-remove!", (h: any, k: any) => {
    if (h instanceof LipsHash) h.remove(k);
    return h;
  });
  defineIfMissing("hash-has-key?", (h: any, k: any) =>
    h instanceof LipsHash && h.has(k));
  defineIfMissing("hash-keys",   (h: any) => h instanceof LipsHash ? toSchemeList(h.keys()) : nil);
  defineIfMissing("hash-values", (h: any) => h instanceof LipsHash ? toSchemeList(h.values()) : nil);
  defineIfMissing("hash-count",  (h: any) => h instanceof LipsHash ? h.size() : 0);

  const sortImpl = (lst: any, less: any) => {
    const cmp = typeof less === "function" ? less : (a: any, b: any) => toJsStr(a) < toJsStr(b);
    const arr = pairToArray(lst).slice();
    arr.sort((a, b) => (truthy(cmp(a, b)) ? -1 : truthy(cmp(b, a)) ? 1 : 0));
    return toSchemeList(arr);
  };
  env.set("sort", sortImpl);
  env.set("sort!", sortImpl);
  env.set("list-sort", (less: any, lst: any) => sortImpl(lst, less)); // SRFI-132 arg order

  defineIfMissing("empty",  nil);
  defineIfMissing("cons?",  (v: any) => v instanceof Pair);
  defineIfMissing("andmap", (pred: any, lst: any) => pairToArray(lst).every((x) => truthy(pred(x))));
  defineIfMissing("ormap",  (pred: any, lst: any) => pairToArray(lst).some((x) => truthy(pred(x))));
  defineIfMissing("findf",  (pred: any, lst: any) => {
    for (const x of pairToArray(lst)) if (truthy(pred(x))) return x;
    return false;
  });
  defineIfMissing("assf", (pred: any, lst: any) => {
    let cur: any = lst;
    while (cur instanceof Pair) {
      const e = cur.car;
      if (e instanceof Pair && truthy(pred(e.car))) return e;
      cur = cur.cdr;
    }
    return false;
  });
  defineIfMissing("build-list", (n: any, proc: any) => {
    const count = Math.max(0, Math.floor(Number(n) || 0));
    const out: any[] = [];
    for (let i = 0; i < count; i++) out.push(proc(i));
    return toSchemeList(out);
  });
  defineIfMissing("take-right", (lst: any, n: any) => {
    const a = pairToArray(lst);
    const k = Math.max(0, Math.floor(Number(n) || 0));
    return toSchemeList(a.slice(a.length - k));
  });
  defineIfMissing("drop-right", (lst: any, n: any) => {
    const a = pairToArray(lst);
    const k = Math.max(0, Math.floor(Number(n) || 0));
    return toSchemeList(a.slice(0, Math.max(0, a.length - k)));
  });
  defineIfMissing("split-at", (lst: any, n: any) => {
    const a = pairToArray(lst);
    const k = Math.max(0, Math.floor(Number(n) || 0));
    return new Pair(toSchemeList(a.slice(0, k)), toSchemeList(a.slice(k)));
  });
  defineIfMissing("add-between", (lst: any, sep: any) => {
    const a = pairToArray(lst);
    if (a.length < 2) return toSchemeList(a);
    const out: any[] = [a[0]];
    for (let i = 1; i < a.length; i++) { out.push(sep); out.push(a[i]); }
    return toSchemeList(out);
  });
  defineIfMissing("remf", (pred: any, lst: any) => {
    const a = pairToArray(lst);
    const i = a.findIndex((x) => truthy(pred(x)));
    return i < 0 ? lst : toSchemeList(a.slice(0, i).concat(a.slice(i + 1)));
  });
  defineIfMissing("remf*", (pred: any, lst: any) =>
    toSchemeList(pairToArray(lst).filter((x) => !truthy(pred(x)))));
  defineIfMissing("rest",    (lst: any) => lst instanceof Pair ? lst.cdr : nil);
  defineIfMissing("sixth",   (lst: any) => pairToArray(lst)[5]);
  defineIfMissing("seventh", (lst: any) => pairToArray(lst)[6]);
  defineIfMissing("eighth",  (lst: any) => pairToArray(lst)[7]);
  defineIfMissing("ninth",   (lst: any) => pairToArray(lst)[8]);
  defineIfMissing("tenth",   (lst: any) => pairToArray(lst)[9]);
  defineIfMissing("index-where", (lst: any, pred: any) => {
    let i = 0, cur: any = lst;
    while (cur instanceof Pair) {
      if (truthy(pred(cur.car))) return i;
      cur = cur.cdr; i++;
    }
    return false;
  });
  defineIfMissing("indexes-of", (lst: any, x: any) => {
    const out: number[] = [];
    let i = 0, cur: any = lst;
    while (cur instanceof Pair) {
      if (lipsEqual(cur.car, x)) out.push(i);
      cur = cur.cdr; i++;
    }
    return toSchemeList(out);
  });
  defineIfMissing("list-update", (lst: any, i: any, upd: any) => {
    const a = pairToArray(lst).slice();
    const k = Math.floor(Number(i) || 0);
    if (k >= 0 && k < a.length) a[k] = upd(a[k]);
    return toSchemeList(a);
  });
  defineIfMissing("list-set", (lst: any, i: any, v: any) => {
    const a = pairToArray(lst).slice();
    const k = Math.floor(Number(i) || 0);
    if (k >= 0 && k < a.length) a[k] = v;
    return toSchemeList(a);
  });
  defineIfMissing("list-prefix?", (a: any, b: any) => {
    const xs = pairToArray(a); const ys = pairToArray(b);
    if (xs.length > ys.length) return false;
    for (let i = 0; i < xs.length; i++) if (!lipsEqual(xs[i], ys[i])) return false;
    return true;
  });
  defineIfMissing("split-at-right", (lst: any, n: any) => {
    const a = pairToArray(lst);
    const k = Math.max(0, Math.floor(Number(n) || 0));
    const cut = Math.max(0, a.length - k);
    return new Pair(toSchemeList(a.slice(0, cut)), toSchemeList(a.slice(cut)));
  });
  defineIfMissing("takef", (lst: any, pred: any) => {
    const out: any[] = [];
    for (const x of pairToArray(lst)) { if (!truthy(pred(x))) break; out.push(x); }
    return toSchemeList(out);
  });
  defineIfMissing("dropf", (lst: any, pred: any) => {
    const a = pairToArray(lst); let i = 0;
    while (i < a.length && truthy(pred(a[i]))) i++;
    return toSchemeList(a.slice(i));
  });
  defineIfMissing("memf", (pred: any, lst: any) => {
    let cur: any = lst;
    while (cur instanceof Pair) {
      if (truthy(pred(cur.car))) return cur;
      cur = cur.cdr;
    }
    return false;
  });
  defineIfMissing("append*", (...args: any[]) => {
    if (args.length === 0) return nil;
    const leading = args.slice(0, -1).flatMap(pairToArray);
    const tail = pairToArray(args[args.length - 1]).flatMap(pairToArray);
    return toSchemeList(leading.concat(tail));
  });
  defineIfMissing("filter-not", (pred: any, lst: any) =>
    toSchemeList(pairToArray(lst).filter((x) => !truthy(pred(x)))));
  defineIfMissing("check-duplicates", (lst: any) => {
    const seen: any[] = [];
    for (const x of pairToArray(lst)) {
      if (seen.some((y) => lipsEqual(y, x))) return x;
      seen.push(x);
    }
    return false;
  });
  defineIfMissing("cartesian-product", (...lists: any[]) => {
    if (lists.length === 0) return toSchemeList([toSchemeList([])]);
    const arrs = lists.map(pairToArray);
    let acc: any[][] = [[]];
    for (const arr of arrs) {
      const next: any[][] = [];
      for (const prefix of acc) for (const x of arr) next.push(prefix.concat([x]));
      acc = next;
    }
    return toSchemeList(acc.map(toSchemeList));
  });
  defineIfMissing("inclusive-range", (a: any, b: any, step: any) => {
    let start: number, end: number, st: number;
    if (b === undefined) { start = 0; end = Number(a); st = 1; }
    else { start = Number(a); end = Number(b); st = step === undefined ? 1 : Number(step); }
    const out: number[] = [];
    if (st > 0) for (let i = start; i <= end; i += st) out.push(i);
    else if (st < 0) for (let i = start; i >= end; i += st) out.push(i);
    return toSchemeList(out);
  });
  defineIfMissing("remove*", (vs: any, lst: any) => {
    const arr = pairToArray(lst);
    const targets = vs instanceof Pair ? pairToArray(vs) : [vs];
    return toSchemeList(arr.filter((x) => !targets.some((t) => lipsEqual(t, x))));
  });

  defineIfMissing("pi", Math.PI);
  defineIfMissing("exact-floor",    (n: any) => Math.floor(Number(n)));
  defineIfMissing("exact-ceiling",  (n: any) => Math.ceil(Number(n)));
  defineIfMissing("exact-round",    (n: any) => Math.round(Number(n)));
  defineIfMissing("exact-truncate", (n: any) => Math.trunc(Number(n)));
  defineIfMissing("sgn",   (n: any) => { const x = Number(n); return x > 0 ? 1 : x < 0 ? -1 : 0; });
  defineIfMissing("sinh",  (n: any) => Math.sinh(Number(n)));
  defineIfMissing("cosh",  (n: any) => Math.cosh(Number(n)));
  defineIfMissing("tanh",  (n: any) => Math.tanh(Number(n)));
  defineIfMissing("degrees->radians", (n: any) => Number(n) * Math.PI / 180);
  defineIfMissing("radians->degrees", (n: any) => Number(n) * 180 / Math.PI);
  defineIfMissing("natural?",          (n: any) => Number.isInteger(Number(n)) && Number(n) >= 0);
  defineIfMissing("positive-integer?", (n: any) => Number.isInteger(Number(n)) && Number(n) > 0);
  defineIfMissing("negative-integer?", (n: any) => Number.isInteger(Number(n)) && Number(n) < 0);
  defineIfMissing("real->decimal-string", (n: any, digits: any) => {
    const d = digits === undefined ? 6 : Math.max(0, Math.floor(Number(digits)));
    return Number(n).toFixed(d);
  });

  defineIfMissing("string-titlecase", (s: any) =>
    String(s).replace(/\b([a-z])/g, (_, c) => c.toUpperCase()));
  defineIfMissing("string-pad", (s: any, width: any, ch?: any) => {
    const str = String(s);
    const w = Math.max(0, Math.floor(Number(width) || 0));
    const c = ch === undefined ? " " : String(ch).charAt(0) || " ";
    return str.length >= w ? str : c.repeat(w - str.length) + str;
  });
  defineIfMissing("string-pad-right", (s: any, width: any, ch?: any) => {
    const str = String(s);
    const w = Math.max(0, Math.floor(Number(width) || 0));
    const c = ch === undefined ? " " : String(ch).charAt(0) || " ";
    return str.length >= w ? str : str + c.repeat(w - str.length);
  });
  defineIfMissing("string-normalize-spaces", (s: any, sep?: any, repl?: any) => {
    const str = String(s).trim();
    const splitOn = sep === undefined ? /\s+/ : (sep instanceof RegExp ? sep : new RegExp(String(sep)));
    const joiner = repl === undefined ? " " : String(repl);
    return str.split(splitOn).filter(Boolean).join(joiner);
  });
  defineIfMissing("build-string", (n: any, proc: any) => {
    const count = Math.max(0, Math.floor(Number(n) || 0));
    let out = "";
    for (let i = 0; i < count; i++) out += String(proc(i));
    return out;
  });

  defineIfMissing("hash-update!", (h: any, k: any, upd: any, dflt: any) => {
    if (!(h instanceof LipsHash)) return h;
    const cur = h.has(k) ? h.get(k) : (typeof dflt === "function" ? dflt() : dflt);
    h.set(k, upd(cur));
    return h;
  });
  defineIfMissing("hash-update", (h: any, k: any, upd: any, dflt: any) => {
    if (!(h instanceof LipsHash)) return h;
    const out = new LipsHash();
    h.map.forEach((vv: any, kk: any) => out.map.set(kk, vv));
    const cur = h.has(k) ? h.get(k) : (typeof dflt === "function" ? dflt() : dflt);
    out.map.set(out._key(k), upd(cur));
    return out;
  });
  defineIfMissing("hash-map", (h: any, proc: any) => {
    if (!(h instanceof LipsHash)) return nil;
    const out: any[] = [];
    const keys = h.keys();
    for (const k of keys) out.push(proc(k, h.get(k)));
    return toSchemeList(out);
  });
  defineIfMissing("hash-for-each", (h: any, proc: any) => {
    if (!(h instanceof LipsHash)) return undefined;
    for (const k of h.keys()) proc(k, h.get(k));
    return undefined;
  });
  defineIfMissing("hash->list", (h: any) => {
    if (!(h instanceof LipsHash)) return nil;
    return toSchemeList(h.keys().map((k: any) => new Pair(k, h.get(k))));
  });
  defineIfMissing("hash-empty?", (h: any) => h instanceof LipsHash && h.size() === 0);
  defineIfMissing("hash-clear!", (h: any) => {
    if (h instanceof LipsHash) h.map.clear();
    return h;
  });
  defineIfMissing("hash-copy", (h: any) => {
    if (!(h instanceof LipsHash)) return h;
    const out = new LipsHash();
    h.map.forEach((vv: any, kk: any) => out.map.set(kk, vv));
    return out;
  });
  defineIfMissing("hash-ref!", (h: any, k: any, dflt: any) => {
    if (!(h instanceof LipsHash)) return dflt;
    if (h.has(k)) return h.get(k);
    const v = typeof dflt === "function" ? dflt() : dflt;
    h.set(k, v);
    return v;
  });
  defineIfMissing("hash-remove", (h: any, k: any) => {
    if (!(h instanceof LipsHash)) return h;
    const out = new LipsHash();
    h.map.forEach((vv: any, kk: any) => out.map.set(kk, vv));
    out.map.delete(out._key(k));
    return out;
  });
  defineIfMissing("hash-union", (...args: any[]) => {
    let combine: ((a: any, b: any) => any) | null = null;
    if (args.length > 0 && typeof args[args.length - 1] === "function" && !(args[args.length - 1] instanceof LipsHash)) {
      combine = args.pop();
    }
    const out = new LipsHash();
    for (const h of args) {
      if (!(h instanceof LipsHash)) continue;
      h.map.forEach((vv: any, kk: any) => {
        if (combine && out.map.has(kk)) out.map.set(kk, combine(out.map.get(kk), vv));
        else out.map.set(kk, vv);
      });
    }
    return out;
  });
  defineIfMissing("hasheq",                (...a: any[]) => (env as any).get("hash")(...a));
  defineIfMissing("hasheqv",               (...a: any[]) => (env as any).get("hash")(...a));
  defineIfMissing("make-hasheq",           (alist?: any) => (env as any).get("make-hash")(alist));
  defineIfMissing("make-hasheqv",          (alist?: any) => (env as any).get("make-hash")(alist));
  defineIfMissing("make-immutable-hash",   (alist?: any) => (env as any).get("make-hash")(alist));

  class LipsBox { constructor(public v: any) {} }
  defineIfMissing("box",      (v: any) => new LipsBox(v));
  defineIfMissing("box?",     (x: any) => x instanceof LipsBox);
  defineIfMissing("unbox",    (b: any) => b instanceof LipsBox ? b.v : b);
  defineIfMissing("set-box!", (b: any, v: any) => { if (b instanceof LipsBox) b.v = v; return undefined; });

  const collectEnvNames = (): string[] => environmentNames(env).sort();
  defineIfMissing("defined?", (sym: any) => {
    const name = sym instanceof LSymbol ? symName(sym) : String(sym);
    return (env as any).get(name, { throwError: false }) !== undefined;
  });
  const aproposImpl = (pat: any) => {
    const needle = pat instanceof LSymbol ? (symName(pat) ?? "") : String(pat ?? "");
    const re = pat instanceof RegExp ? pat : null;
    const match = (n: string) => re ? re.test(n) : n.includes(needle);
    return toSchemeList(collectEnvNames().filter(match).map((n) => new LSymbol(n)));
  };
  defineIfMissing("apropos-list", aproposImpl);

  defineIfMissing("current-seconds",      () => Math.floor(Date.now() / 1000));
  defineIfMissing("current-milliseconds", () => Date.now());
  defineIfMissing("current-inexact-milliseconds", () => performance.now());
}

// Canonical names we claim coverage for. R = R7RS small base; S = SRFI-1;
// K = Racket racket/base/list/string/format. Continuations, ports, and
// bytevectors are intentionally omitted — they'd be misleading "coverage"
// without real functionality.
const COVERAGE_CHECKLIST: string[] = [
  // R7RS § 6.1 equivalence
  "eq?", "eqv?", "equal?",
  // R7RS § 6.2 numbers
  "number?", "integer?", "exact?", "inexact?", "exact-integer?",
  "finite?", "infinite?", "nan?",
  "=", "<", ">", "<=", ">=",
  "zero?", "positive?", "negative?", "odd?", "even?",
  "max", "min", "+", "-", "*", "/",
  "abs", "quotient", "remainder", "modulo",
  "gcd", "lcm", "floor", "ceiling", "truncate", "round",
  "exp", "log", "sin", "cos", "tan", "asin", "acos", "atan",
  "sqrt", "expt",
  "exact", "inexact", "exact->inexact", "inexact->exact",
  "number->string", "string->number",
  // R7RS § 6.3 booleans
  "not", "boolean?", "boolean=?",
  // R7RS § 6.4 lists
  "pair?", "cons", "car", "cdr",
  "null?", "list?", "list", "length", "append", "reverse",
  "list-tail", "list-ref",
  "memq", "memv", "member",
  "assq", "assv", "assoc",
  // R7RS § 6.5 symbols
  "symbol?", "symbol=?", "symbol->string", "string->symbol",
  // R7RS § 6.7 strings
  "string?", "make-string", "string", "string-length", "string-ref",
  "string=?", "string-ci=?", "string<?", "string>?", "string<=?", "string>=?",
  "string-ci<?", "string-ci>?",
  "string-upcase", "string-downcase", "string-foldcase",
  "substring", "string-append", "string->list", "list->string", "string-copy",
  // R7RS § 6.10 control
  "procedure?", "apply", "map", "for-each",
  // R7RS § 6.11 error
  "error",
  // SRFI-1 (beyond R7RS list ops)
  "first", "second", "third", "fourth", "fifth", "last", "last-pair",
  "take", "drop", "iota",
  "any", "every", "count", "find",
  "filter", "filter-map", "remove", "partition",
  "fold", "fold-right", "reduce", "reduce-right", "append-map", "concatenate",
  "delete", "delete-duplicates",
  "zip", "take-while", "drop-while", "span", "break",
  "list-index", "length+", "list-tabulate", "cons*", "list*",
  "append-reverse", "alist-cons", "alist-copy",
  // Racket strings
  "string-split", "string-join", "string-trim",
  "string-trim-left", "string-trim-right", "string-trim-both",
  "string-contains", "string-contains?", "string-prefix?", "string-suffix?",
  "string-replace", "string-index", "non-empty-string?",
  // Racket regex + cross-dialect aliases
  "regexp", "regexp?", "regexp-match", "regexp-match-positions",
  "regexp-replace", "regexp-replace*", "regexp-quote", "regexp-split",
  "string-match", "match:substring",
  // Racket format
  "format", "printf", "~a", "~s", "~v", "displayln",
  // Racket list/sequence
  "range", "flatten", "index-of",
  "argmax", "argmin", "remove-duplicates", "group-by",
  "add1", "sub1", "sqr", "identity",
  // Sort (R7RS-large / SRFI-132 / Racket)
  "sort", "sort!", "list-sort",
  // Racket list aliases & gaps
  "empty?", "empty", "cons?", "andmap", "ormap", "findf", "assf",
  "make-list", "build-list", "take-right", "drop-right", "split-at",
  "shuffle", "add-between", "remf", "remf*",
  "rest", "sixth", "seventh", "eighth", "ninth", "tenth",
  "index-where", "indexes-of", "list-update", "list-set", "list-prefix?",
  "split-at-right", "takef", "dropf", "memf",
  "append*", "filter-not", "check-duplicates",
  "cartesian-product", "inclusive-range", "remove*",
  // Racket numbers (gaps)
  "pi", "random",
  "exact-floor", "exact-ceiling", "exact-round", "exact-truncate",
  "sgn", "sinh", "cosh", "tanh",
  "degrees->radians", "radians->degrees",
  "natural?", "positive-integer?", "negative-integer?",
  "real->decimal-string",
  // Racket strings & chars (gaps)
  "string-titlecase", "string-pad", "string-pad-right",
  "char-upcase", "char-downcase",
  "char->integer", "integer->char", "char?",
  "char=?", "char<?", "char>?", "char<=?", "char>=?", "char-ci=?",
  "char-alphabetic?", "char-numeric?", "char-whitespace?",
  "char-upper-case?", "char-lower-case?", "digit-value",
  "string-normalize-spaces", "build-string",
  // Racket hash
  "make-hash", "hash", "hash?", "hash-ref", "hash-set!", "hash-set",
  "hash-remove!", "hash-has-key?", "hash-keys", "hash-values", "hash-count",
  "hash-update!", "hash-update", "hash-map", "hash-for-each",
  "hash->list", "hash-empty?", "hash-clear!",
  "hash-copy", "hash-ref!", "hash-remove", "hash-union",
  "hasheq", "hasheqv", "make-hasheq", "make-hasheqv", "make-immutable-hash",
  // Racket boxes
  "box", "box?", "unbox", "set-box!",
  // Environment introspection
  "defined?", "apropos", "apropos-list",
  // Racket time
  "current-seconds", "current-milliseconds", "current-inexact-milliseconds",
];

function auditShimCoverage(env: any): { defined: number; missing: string[] } {
  const missing: string[] = [];
  let defined = 0;
  for (const name of COVERAGE_CHECKLIST) {
    const v = (env as any).get(name, { throwError: false });
    if (v === undefined) missing.push(name);
    else defined++;
  }
  return { defined, missing };
}

// Every name bound anywhere up the env chain. Mirrors the in-Scheme apropos
// walk; used for catalog audits and "did you mean" suggestions.
function environmentNames(env: any): string[] {
  const seen = new Set<string>();
  let cur: any = env;
  while (cur) {
    const frame = cur.__env__;
    if (frame && typeof frame === "object") for (const k of Object.keys(frame)) seen.add(k);
    cur = cur.__parent__;
  }
  return [...seen];
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

// Rank real names against a name that failed to resolve. Substring overlap
// (the model spelled a longer/shorter variant) outranks edit-distance, which
// is gated so unrelated names never surface.
function suggestNames(target: string, names: string[], limit = 3): string[] {
  const t = target.toLowerCase();
  const scored: Array<{ name: string; score: number }> = [];
  for (const name of names) {
    const n = name.toLowerCase();
    if (n === t) continue;
    let score: number;
    // Substring overlap only counts when the shared name is specific enough —
    // otherwise "-" or "y" match nearly everything.
    if (Math.min(n.length, t.length) >= 4 && (n.includes(t) || t.includes(n))) {
      score = Math.abs(n.length - t.length);
    } else {
      const d = levenshtein(t, n);
      if (d > Math.max(2, Math.floor(t.length / 3))) continue;
      score = 100 + d;
    }
    scored.push({ name, score });
  }
  scored.sort((a, b) => a.score - b.score || a.name.length - b.name.length);
  return scored.slice(0, limit).map((s) => s.name);
}

// Register the catalog into the shared library/primitive maps. Binding lives in
// installStdShims; this only attaches metadata, so a catalogued-but-unbound name
// is a doc bug, never a broken call — we log it rather than fail.
function registerStdlibCatalog(
  libraries: LibraryRegistry,
  catalog: Map<string, { signature?: string; doc?: string; library: string }>,
  env: any,
): void {
  const missing: string[] = [];
  for (const lib of STDLIB_CATALOG) {
    libraries.set(lib.name, {
      description: lib.description,
      doc: lib.doc,
      primitives: lib.primitives.map((p) => p.name),
      builtin: true,
    });
    for (const p of lib.primitives) {
      catalog.set(p.name, { signature: p.signature, doc: p.doc, library: lib.name });
      if ((env as any).get(p.name, { throwError: false }) === undefined) missing.push(p.name);
    }
  }
  if (missing.length > 0) {
    logErr("stdlib-catalog", new Error("catalogued names not bound"), { missing });
  }
}

// Quoted alist literals like '((k . #t)) may carry #t/#f as LSymbol or as
// the string "#t"/"#f". Normalize to JS bool.
function unwrapSchemeBool(v: any): any {
  if (v === true || v === false) return v;
  if (v instanceof LSymbol) {
    const n = symName(v);
    if (n === "#t") return true;
    if (n === "#f") return false;
  }
  if (v === "#t") return true;
  if (v === "#f") return false;
  return v;
}

type HostSig = { name: string; sig: string; ret: string; doc?: string };
const HOST_SIGS: HostSig[] = [
  { name: "bash", sig: '(bash "cmd" [:timeout sec])', ret: "str",
    doc: "run a shell command; stdout as a string" },
  { name: "sh", sig: '(sh "cmd" [:timeout sec])',
    ret: "((output . str) (exit-code . n) (error . bool))",
    doc: "run a shell command; full result. Accessors: output-of exit-code-of ok? error?" },
  { name: "read-file", sig: '(read-file "path" [:offset n] [:limit n])', ret: "str | #f",
    doc: "file contents, or #f on error. :offset is 1-indexed; :limit caps lines" },
  { name: "write-file", sig: '(write-file "path" "content")', ret: "#t | err-str" },
  { name: "edit-file", sig: '(edit-file "path" "old" "new" [:replace-all #t])', ret: "#t | err-str",
    doc: "replace exact text; :replace-all #t replaces every occurrence" },
  { name: "grep", sig: '(grep "pat" ["dir"] [:opt val …])',
    ret: "(listof ((file . str) (line . n) (text . str)))",
    doc: "ripgrep search. options: :path :include :case-insensitive :context-before :context-after :limit :offset" },
  { name: "grep-files", sig: '(grep-files "pat" ["dir"] [:opt val …])', ret: "(listof str)" },
  { name: "glob", sig: '(glob "pat" [:path "dir"])', ret: "(listof str)" },
];
const sigLine = (h: HostSig): string => `${h.sig} → ${h.ret}`;
const sigForName = (name: string): string => {
  const h = HOST_SIGS.find((s) => s.name === name);
  return h ? sigLine(h) : name;
};

function withSig(name: string, fn: (...a: any[]) => Promise<any>) {
  return async (...a: any[]) => {
    try {
      return await fn(...a);
    } catch (e: any) {
      const base = e?.message ?? String(e);
      if (!String(base).includes("signature:") && !String(base).includes("permission gate")) {
        try { e.message = `${base}\n  signature: ${sigForName(name)}`; } catch {}
      }
      throw e;
    }
  };
}

const isKwSym = (x: any): boolean => {
  const n = symName(x);
  return typeof n === "string" && n.startsWith(":");
};

function splitArgs(
  args: any[], keyMap: Record<string, string>, numericKeys?: Set<string>,
): { positionals: any[]; opts: Record<string, unknown> } {
  const positionals: any[] = [];
  let i = 0;
  while (i < args.length && !isKwSym(args[i])) { positionals.push(args[i]); i++; }
  const opts: Record<string, unknown> = {};
  while (i < args.length) {
    if (!isKwSym(args[i])) { i++; continue; }
    const key = symName(args[i])!.slice(1);
    const tgt = keyMap[key];
    if (tgt === undefined) {
      const valid = Object.keys(keyMap).map((k) => `:${k}`).join(" ");
      throw new Error(`unknown option :${key}; valid options: ${valid || "(none)"}`);
    }
    const raw = args[i + 1];
    opts[tgt] = numericKeys && numericKeys.has(tgt)
      ? Number(raw)
      : unwrapSchemeBool(toJsStr(raw));
    i += 2;
  }
  return { positionals, opts };
}

/** Fold a primitive's trailing `:key value …` args (post-marshalling, so keys
 *  arrive as `":key"` strings) into an options object, colons stripped. Skips
 *  any leading positionals. The manual building block behind declarative opts. */
export function kwargs(rest: any[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let i = 0;
  while (i < rest.length && !(typeof rest[i] === "string" && rest[i].startsWith(":"))) i++;
  for (; i + 1 < rest.length; i += 2) out[String(rest[i]).replace(/^:/, "")] = rest[i + 1];
  return out;
}

const optTypeToken = (t?: OptType): string =>
  t === "number" ? "n" : t === "boolean" ? "bool" : t === "any" ? "val" : "str";

function coerceOpt(raw: any, type?: OptType): any {
  if (type === "number") return Number(toJsStr(raw));
  if (type === "boolean") return unwrapSchemeBool(toJsStr(raw));
  const v = lipsToJs(raw);
  if (type === "string") return v == null ? v : String(v);
  return v;
}

const normOpt = (v: OptType | OptSpec): OptSpec => (typeof v === "string" ? { type: v } : v);

function generateSignature(spec: PrimitiveSpec): string {
  const parts: string[] = [spec.name];
  for (const a of spec.args ?? []) {
    const as = typeof a === "string" ? { name: a } : a;
    parts.push(as.type && as.type !== "string" ? as.name : `"${as.name}"`);
  }
  for (const [k, v] of Object.entries(spec.opts ?? {})) {
    parts.push(`[:${k} ${optTypeToken(normOpt(v).type)}]`);
  }
  const sig = `(${parts.join(" ")})`;
  return spec.returns ? `${sig} → ${spec.returns}` : sig;
}

// Declarative path: split positionals (up to the first keyword symbol) from the
// `:key value` tail, coerce + default each option by its declared type, and call
// `fn(...positionals, opts)`. Operates on raw LIPS args so a string value that
// happens to start with ":" stays a positional (only `:`-symbols are keywords).
function buildDeclaredCall(spec: PrimitiveSpec): (...lipsArgs: any[]) => any {
  const fn = spec.fn;
  const arity = (spec.args ?? []).length;
  const optSpecs: Record<string, OptSpec> = {};
  for (const [k, v] of Object.entries(spec.opts ?? {})) optSpecs[k] = normOpt(v);
  const validList = Object.keys(optSpecs).map((k) => `:${k}`).join(" ");
  return (...lipsArgs: any[]) => {
    const positionals: any[] = [];
    let i = 0;
    while (i < lipsArgs.length && !isKwSym(lipsArgs[i])) { positionals.push(lipsArgs[i]); i++; }
    const opts: Record<string, unknown> = {};
    while (i < lipsArgs.length) {
      if (!isKwSym(lipsArgs[i])) { i++; continue; }
      const key = symName(lipsArgs[i])!.slice(1);
      const os = optSpecs[key];
      if (!os) throw new Error(`unknown option :${key}; valid options: ${validList || "(none)"}`);
      opts[key] = coerceOpt(lipsArgs[i + 1], os.type);
      i += 2;
    }
    for (const [k, os] of Object.entries(optSpecs)) {
      if (!(k in opts) && "default" in os) opts[k] = os.default;
    }
    // Pad omitted positionals to null so `opts` always lands at a fixed slot.
    const js = positionals.map(lipsToJs);
    while (js.length < arity) js.push(null);
    const out = fn(...js, opts);
    return out instanceof Promise ? out.then(jsToLips) : jsToLips(out);
  };
}

// Cache executors on globalThis (survives reload's module-cache bust): the
// integration unregisters the built-ins, but the tool objects outlive it.
const EXECUTOR_CACHE: Record<string, ToolExecutor> =
  ((globalThis as any).__ashSchemeExecutors ??= {});
function resolveExecutor(ctx: AgentContext, name: string): ToolExecutor {
  const tool = ctx.agent.getTools().find((t) => t.name === name);
  if (tool) return (EXECUTOR_CACHE[name] = (args) => tool.execute(args));
  if (EXECUTOR_CACHE[name]) return EXECUTOR_CACHE[name];
  throw new Error(`scheme bridge: tool '${name}' not registered`);
}

function installBindings(
  env: any,
  bus: Bus,
  bash: ToolExecutor,
  readFile: ToolExecutor,
  writeFile: ToolExecutor,
  editFile: ToolExecutor | null,
  grep: ToolExecutor | null,
  glob: ToolExecutor | null,
  extPrims: ExtPrimitiveRegistry,
  runGuards: (name: string, args: any[]) => Promise<void>,
): void {
  const READ_KEYMAP: Record<string, string> = { "offset": "offset", "limit": "limit" };
  const READ_NUMERIC = new Set(["offset", "limit"]);
  const BASH_KEYMAP: Record<string, string> = { "timeout": "timeout" };
  const BASH_NUMERIC = new Set(["timeout"]);
  const EDIT_KEYMAP: Record<string, string> = { "replace-all": "replace_all" };
  const GLOB_KEYMAP: Record<string, string> = { "path": "path" };
  const GREP_KEYMAP: Record<string, string> = {
    "include":          "include",
    "case-insensitive": "case_insensitive",
    "context-before":   "context_before",
    "context-after":    "context_after",
    "limit":            "head_limit",
    "offset":           "offset",
    "path":             "path",
  };
  const GREP_NUMERIC = new Set([
    "context_before", "context_after", "head_limit", "offset",
  ]);

  const runBash = async (command: string, timeoutSec?: number) => {
    const args: Record<string, unknown> = { command: toJsStr(command) };
    if (typeof timeoutSec === "number") args.timeout = timeoutSec;
    const result = await bash(args);
    let output = typeof result.content === "string" ? result.content : String(result.content ?? "");
    // Undo bash.ts's "(no output)" sentinel so `(eq? out "")` works.
    if (output === "(no output)") output = "";
    return { exitCode: result.exitCode ?? (result.isError ? 1 : 0), output, error: result.isError };
  };
  const bashTimeout = (positionals: any[], opts: Record<string, unknown>): number | undefined => {
    const t = opts.timeout !== undefined ? opts.timeout : positionals[1];
    if (t === undefined || t === null) return undefined;
    const n = Number(t);
    return isNaN(n) ? undefined : n;
  };
  env.set("bash", withSig("bash", async (...rest: any[]) => {
    const { positionals, opts } = splitArgs(rest, BASH_KEYMAP, BASH_NUMERIC);
    const command = positionals[0];
    await runGuards("bash", [command]);
    try {
      return (await runBash(command, bashTimeout(positionals, opts))).output;
    } catch (e: any) {
      logErr("bash", e, { command });
      return "";
    }
  }));
  env.set("sh", withSig("sh", async (...rest: any[]) => {
    const { positionals, opts } = splitArgs(rest, BASH_KEYMAP, BASH_NUMERIC);
    const command = positionals[0];
    await runGuards("sh", [command]);
    try {
      const r = await runBash(command, bashTimeout(positionals, opts));
      return alist([
        ["output",    r.output],
        ["exit-code", r.exitCode],
        ["error",     r.error],
      ]);
    } catch (e: any) {
      logErr("sh", e, { command, typeofCommand: typeof command });
      throw e;
    }
  }));

  env.set("read-file", withSig("read-file", async (...rest: any[]) => {
    const { positionals, opts } = splitArgs(rest, READ_KEYMAP, READ_NUMERIC);
    const args: Record<string, unknown> = { path: toJsStr(positionals[0]), bypass_cache: true };
    const offset = opts.offset !== undefined ? opts.offset : positionals[1];
    const limit = opts.limit !== undefined ? opts.limit : positionals[2];
    if (offset !== undefined && offset !== null) {
      const n = Number(offset);
      if (!isNaN(n)) args.offset = n;
    }
    if (limit !== undefined && limit !== null) {
      const n = Number(limit);
      if (!isNaN(n)) args.limit = n;
    }
    const result = await readFile(args);
    if (result.isError) return false;
    if (typeof result.content !== "string") return result.content;
    return result.content
      .replace(/\n\[\d+ more lines, use offset=\d+ to continue\]$/, "")
      .replace(/^\d+\t/gm, "");
  }));

  env.set("write-file", withSig("write-file", async (filePath: string, content: string) => {
    filePath = toJsStr(filePath); content = toJsStr(content);
    await runGuards("write-file", [filePath, content]);
    const result = await withDisplay(
      bus, "write_file", "write", { path: filePath, content }, filePath,
      () => writeFile({ path: filePath, content }),
    );
    return result.isError ? result.content : true;
  }));

  if (editFile) {
    env.set("edit-file", withSig("edit-file", async (...rest: any[]) => {
      const { positionals, opts } = splitArgs(rest, EDIT_KEYMAP);
      const filePath = toJsStr(positionals[0]);
      const oldStr = toJsStr(positionals[1]);
      const newStr = toJsStr(positionals[2]);
      await runGuards("edit-file", [filePath, oldStr, newStr]);
      const replaceAll = opts.replace_all !== undefined ? opts.replace_all : positionals[3];
      const toolArgs: Record<string, unknown> = { path: filePath, old_text: oldStr, new_text: newStr };
      if (unwrapSchemeBool(replaceAll) === true) toolArgs.replace_all = true;
      const result = await withDisplay(
        bus, "edit_file", "write", toolArgs, filePath,
        () => editFile(toolArgs),
      );
      if (result.isError) return result.content;
      if (/\(\+0 -0\)/.test(String(result.content ?? "")))
        return "edit-file: old_text matched but is identical to new_text — nothing changed";
      return true;
    }));
  }

  if (grep) {
    // Ripgrep uses Rust/ERE regex, but models write BRE (the default flavor
    // of plain grep/sed) where \| \( \) \{ \} \+ \? are metacharacters.
    // Translate BRE escapes to their ERE equivalents so the model's intent is
    // honored without dialect-switching overhead.
    const normalizePattern = (pat: string): string => {
      return pat
        .replace(/\\\|/g, "|")
        .replace(/\\\(/g, "(").replace(/\\\)/g, ")")
        .replace(/\\\{/g, "{").replace(/\\\}/g, "}")
        .replace(/\\\+/g, "+").replace(/\\\?/g, "?");
    };

    env.set("grep", withSig("grep", async (...rest: any[]) => {
      const { positionals, opts } = splitArgs(rest, GREP_KEYMAP, GREP_NUMERIC);
      const args: Record<string, unknown> = {
        pattern: normalizePattern(String(positionals[0] ?? "")), output_mode: "content", ...opts,
      };
      const posPath = toJsStr(positionals[1]);
      if (args.path === undefined && typeof posPath === "string") args.path = posPath;
      const pStr = typeof args.path === "string" ? args.path : undefined;
      const result = await grep(args);
      if (result.isError) return nil;
      if (result.content === "No matches found.") return nil;
      const rows: unknown[] = [];
      for (const line of stripPagination(result.content as string)) {
        const parsed = parseGrepLine(line, pStr);
        if (parsed) rows.push(parsed);
      }
      return toSchemeList(rows);
    }));

    env.set("grep-files", withSig("grep-files", async (...rest: any[]) => {
      const { positionals, opts } = splitArgs(rest, GREP_KEYMAP, GREP_NUMERIC);
      const args: Record<string, unknown> = {
        pattern: normalizePattern(String(positionals[0] ?? "")), output_mode: "files_with_matches", ...opts,
      };
      const posPath = toJsStr(positionals[1]);
      if (args.path === undefined && typeof posPath === "string") args.path = posPath;
      const result = await grep(args);
      if (result.isError || result.content === "No matches found.") return nil;
      return toSchemeList(stripPagination(result.content as string));
    }));
  }

  if (glob) {
    // Strip leading "./" so glob paths match grep's — otherwise eq? on the
    // file field fails across the two.
    env.set("glob", withSig("glob", async (...rest: any[]) => {
      const { positionals, opts } = splitArgs(rest, GLOB_KEYMAP);
      const args: Record<string, unknown> = { pattern: toJsStr(positionals[0]) };
      const pStr = opts.path !== undefined ? String(opts.path) : toJsStr(positionals[1]);
      if (typeof pStr === "string") args.path = pStr;
      const result = await glob(args);
      if (result.isError || result.content === "No files matched.") return nil;
      const paths = stripPagination(result.content as string).map((l) =>
        l.startsWith("./") ? l.slice(2) : l,
      );
      return toSchemeList(paths);
    }));
  }

  env.set("output-of",    (r: unknown) => lookup(r, "output"));
  env.set("exit-code-of", (r: unknown) => lookup(r, "exit-code"));
  env.set("error?",       (r: unknown) => lookup(r, "error") === true);
  env.set("ok?",          (r: unknown) => lookup(r, "error") === false);

  const availableNames = new Set<string>(["bash", "sh", "read-file", "write-file"]);
  if (editFile) availableNames.add("edit-file");
  if (grep) { availableNames.add("grep"); availableNames.add("grep-files"); }
  if (glob) availableNames.add("glob");
  const availableSigs = HOST_SIGS.filter((h) => availableNames.has(h.name));
  env.set("help", (name?: any) => {
    if (name === undefined || name === null) {
      const ext = [...extPrims].map(([n, m]) => m.signature ?? `(${n} …)`);
      return [...availableSigs.map(sigLine), ...ext].join("\n");
    }
    const key = String(name instanceof LSymbol ? symName(name) : toJsStr(name)).replace(/^:/, "");
    const h = availableSigs.find((s) => s.name === key);
    if (h) return `${sigLine(h)}${h.doc ? `\n    ${h.doc}` : ""}`;
    const e = extPrims.get(key);
    if (e) return `${e.signature ?? `(${key} …)`}${e.doc ? `\n    ${e.doc}` : ""}`;
    const bound = (env as any).get(key, { throwError: false });
    if (bound !== undefined) {
      const kind = typeof bound === "function" ? "procedure" : "value";
      return `${key}: built-in ${kind} (R7RS/SRFI-1/Racket stdlib; no host signature). Call it directly; (apropos-list "${key}") finds related names.`;
    }
    return `no binding named ${key}; (apropos-list "${key}") searches all names, (help) lists host primitives`;
  });

  const asStrings = (s: unknown, needle: unknown): [string, string] | null => {
    s = toJsStr(s); needle = toJsStr(needle);
    return typeof s === "string" && typeof needle === "string" ? [s, needle] : null;
  };
  env.set("string-contains?", (s: unknown, needle: unknown) => {
    const p = asStrings(s, needle);
    return p ? p[0].includes(p[1]) : false;
  });
  env.set("string-contains", (s: unknown, needle: unknown) => {
    const p = asStrings(s, needle);
    if (!p) return false;
    const i = p[0].indexOf(p[1]);
    return i < 0 ? false : i;
  });
  env.set("string-replace", (oldStr: unknown, newStr: unknown, s: unknown) => {
    s = toJsStr(s);
    if (typeof s !== "string") return s;
    return s.split(String(oldStr ?? "")).join(String(newStr ?? ""));
  });

  env.set("lines", (s: unknown) => {
    s = toJsStr(s);
    if (typeof s !== "string" || s.length === 0) return nil;
    const parts = s.split("\n");
    if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
    let tail: any = nil;
    for (let i = parts.length - 1; i >= 0; i--) tail = new Pair(parts[i], tail);
    return tail;
  });
  env.set("unlines", (lst: unknown) => {
    let out = "";
    let cur: any = lst;
    while (cur instanceof Pair) { out += String(toJsStr(cur.car)) + "\n"; cur = cur.cdr; }
    return out;
  });
}

// Generated from HOST_SIGS so the catalog the model reads matches what
// `(help …)` reports at runtime.
const HOST_BINDINGS_BLOCK = HOST_SIGS.map(
  (h) => `  ${h.sig.padEnd(44)} → ${h.ret}${h.doc ? `\n      ${h.doc}` : ""}`,
).join("\n");

export const DESCRIPTION = [
  "Evaluate Scheme (R7RS-shaped).",
  "Built-in primitives for the shell, filesystem, and search:",
  "",
  HOST_BINDINGS_BLOCK,
  "",
  "  (help) lists these; (help 'grep) shows one.",
  "",
  "Optional arguments are :key value pairs — order-independent, and the same",
  "key means the same on every primitive (:offset/:limit on read-file and grep,",
  ":timeout on bash):",
  "  (read-file \"x\" :offset 40 :limit 20)",
  "  (grep \"TODO\" \"src/\" :include \"*.ts\" :context-after 2)",
  "",
  "Default timeout 15s; pass timeout_ms to override (max 60s).",
].join("\n");

const PRELUDE = `
(define-macro (cond . clauses)
  (if (null? clauses)
      #f
      (let ((c (car clauses)) (rest (cdr clauses)))
        (if (eq? (car c) 'else)
            (cons 'begin (cdr c))
            (list 'if (car c)
                  (cons 'begin (cdr c))
                  (cons 'cond rest))))))

(define-macro (when test . body)
  (list 'if test (cons 'begin body) #f))

(define-macro (unless test . body)
  (list 'if test #f (cons 'begin body)))

(define (newline) (display "\n"))
(define assq assoc)
`;

export type GuardCall = { name: string; args: any[] };
export type Guard = (call: GuardCall) => unknown;

export interface Interpreter {
  evaluate(source: string, timeoutMs: number): Promise<{ ok: boolean; value: string; error?: string; display?: string }>;
  definePrimitive(spec: PrimitiveSpec): void;
  defineLibrary(spec: LibrarySpec): Library;
  listPrimitives(): Array<{ name: string; signature?: string; doc?: string }>;
  listLibraries(): LibraryInfo[];
  /** What the agent has `define`d this session (name + type/size summary). */
  listBindings(): Array<{ name: string; summary: string }>;
  addGuard(guard: Guard): () => void;
}

export function createInterpreter(ctx: AgentContext): Interpreter {
  const env = (lips as any).env.inherit("scheme-ext");
  const extPrims: ExtPrimitiveRegistry = new Map();
  const libraries: LibraryRegistry = new Map();
  // Built-in stdlib signatures, kept apart from extPrims so `(help)` (which dumps
  // extPrims) stays a host-primitive reference while these stay browsable per library.
  const stdlibCatalog = new Map<string, { signature?: string; doc?: string; library: string }>();
  const loaded = new Set<string>();
  const guards: Guard[] = [];
  const timeoutCtl = createTimeoutController();
  const runGuards = async (name: string, args: any[]): Promise<void> => {
    if (guards.length === 0) return;
    const call = { name, args: args.map(lipsToJs) };
    timeoutCtl.pause();
    try {
      for (const g of guards) {
        const verdict = await g(call);
        if (verdict === false || verdict === "deny") {
          throw new Error(`${name} blocked by permission gate (do not retry or use another primitive to do it)`);
        }
      }
    } finally {
      timeoutCtl.resume();
    }
  };

  // Resolve executors before any unregister, so the bridge keeps working.
  const bash = resolveExecutor(ctx, "bash");
  const readFile = resolveExecutor(ctx, "read_file");
  const writeFile = resolveExecutor(ctx, "write_file");
  let editFile: ToolExecutor | null = null;
  let grep: ToolExecutor | null = null;
  let glob: ToolExecutor | null = null;
  try { editFile = resolveExecutor(ctx, "edit_file"); } catch {}
  try { grep = resolveExecutor(ctx, "grep"); } catch {}
  try { glob = resolveExecutor(ctx, "glob"); } catch {}
  installBindings(env, ctx.bus, bash, readFile, writeFile, editFile, grep, glob, extPrims, runGuards);

  const ready = (async () => {
    try {
      const stdXcb = path.join(
        path.dirname(createRequire(import.meta.url).resolve("@jcubic/lips")),
        "std.xcb",
      );
      await bootstrap(stdXcb);
    } catch (e) {
      logErr("bootstrap", e);
    }
    try {
      installStdShims(env);
      await (lips as any).exec(PRELUDE, { env });
      registerStdlibCatalog(libraries, stdlibCatalog, env);
      const audit = auditShimCoverage(env);
      if (audit.missing.length > 0) {
        logErr("shim-audit", new Error("missing canonical names"), {
          defined: audit.defined,
          total: audit.defined + audit.missing.length,
          missing: audit.missing,
        });
      }
    } catch (e) {
      logErr("init", e);
    }
  })();

  const ensureLibrary = (name: string): { description: string; doc?: string; primitives: string[] } => {
    let lib = libraries.get(name);
    if (!lib) {
      lib = { description: name === MISC_LIBRARY ? "Ungrouped primitives." : "", primitives: [] };
      libraries.set(name, lib);
    }
    return lib;
  };

  function definePrimitive(spec: PrimitiveSpec): void {
    const { name, doc, fn, raw } = spec ?? ({} as PrimitiveSpec);
    if (!name || typeof fn !== "function") {
      throw new Error("scheme:define-primitive: spec needs { name, fn }");
    }
    const library = spec.library ?? MISC_LIBRARY;
    const declarative = !!(spec.args || spec.opts);
    const signature = spec.signature ?? (declarative ? generateSignature(spec) : undefined);
    const call = declarative
      ? buildDeclaredCall(spec)
      : raw
        ? fn
        : (...lipsArgs: any[]) => {
            const out = fn(...lipsArgs.map(lipsToJs));
            return out instanceof Promise ? out.then(jsToLips) : jsToLips(out);
          };
    env.set(name, async (...lipsArgs: any[]) => {
      await runGuards(name, lipsArgs);
      return call(...lipsArgs);
    });
    extPrims.set(name, { signature, doc, library });
    const lib = ensureLibrary(library);
    if (!lib.primitives.includes(name)) lib.primitives.push(name);
  }

  function defineLibrary(spec: LibrarySpec): Library {
    const name = String(spec.name);
    // Upsert + reset the primitive list, so a reload rebuilds the library cleanly.
    libraries.set(name, {
      description: String(spec.description ?? ""),
      doc: spec.doc ? String(spec.doc) : undefined,
      primitives: [],
    });
    return { name, definePrimitive: (pspec) => definePrimitive({ ...pspec, library: name }) };
  }

  // Capability discovery — the agent's metacognition layer: the prompt carries
  // only one-line descriptions; the agent pulls a library's full docs in on demand.
  env.set("libraries", () => toSchemeList(
    [...libraries].map(([name, l]) => alist([
      ["name", name],
      ["description", l.description],
      ["count", l.primitives.length],
      ["builtin", !!l.builtin],
      ["loaded", loaded.has(name)],
    ])),
  ));
  env.set("load-library", (name?: any) => {
    const key = String(name instanceof LSymbol ? symName(name) : toJsStr(name) ?? "").replace(/^:/, "");
    const lib = libraries.get(key);
    if (!lib) return `no library named ${key}; (libraries) lists them`;
    loaded.add(key);
    const sigs = lib.primitives.map((pn) => {
      const m = stdlibCatalog.get(pn) ?? extPrims.get(pn);
      const sig = m?.signature ?? `(${pn} …)`;
      return m?.doc ? `${sig}\n    ${m.doc}` : sig;
    }).join("\n");
    const origin = lib.builtin ? " · standard library (always available)" : " · extension";
    const header = `## ${key}${lib.description ? ` — ${lib.description}` : ""}${origin}`;
    const body = sigs || "(no primitives)";
    return lib.doc ? `${header}\n${lib.doc}\n\n${body}` : `${header}\n${body}`;
  });

  // Baseline = heap before the agent's first eval; the delta is the agent's own
  // defines. Snapshotted lazily, so a resumed (fresh) process starts empty.
  let bindingBaseline: Set<string> | null = null;
  const ownKeys = (): string[] => Object.keys((env as any).__env__ ?? {});
  const summarizeBinding = (v: any): string => {
    if (typeof v === "function") return "procedure";
    if (LString && v instanceof LString) {
      const len = v.toString().length;
      return len >= 1024 ? `string (${(len / 1024).toFixed(1)} KB)` : `string (${len} chars)`;
    }
    if (v instanceof Pair) {
      let n = 0; let cur: any = v;
      while (cur instanceof Pair && n < 10000) { n++; cur = cur.cdr; }
      return n >= 10000 ? "list (10000+ elements)" : `list (${n} element${n === 1 ? "" : "s"})`;
    }
    if (v === nil) return "list (0 elements)";
    if (LNumber && v instanceof LNumber) return `number ${v.toString()}`;
    if (typeof v === "number") return `number ${v}`;
    if (typeof v === "boolean") return v ? "#t" : "#f";
    if (LCharacter && v instanceof LCharacter) return "char";
    return (v?.constructor?.name ?? typeof v).toLowerCase();
  };
  const listUserBindings = (): Array<{ name: string; summary: string }> => {
    if (!bindingBaseline) return [];
    const out: Array<{ name: string; summary: string }> = [];
    for (const k of ownKeys()) {
      if (bindingBaseline.has(k)) continue;
      out.push({ name: k, summary: summarizeBinding((env as any).get(k, { throwError: false })) });
    }
    return out;
  };
  env.set("bindings", () => alist(listUserBindings().map((b) => [b.name, b.summary])));

  return {
    evaluate: async (source, timeoutMs) => {
      await ready;
      if (!bindingBaseline) bindingBaseline = new Set(ownKeys());
      return evaluate(env, source, timeoutMs, timeoutCtl, stdlibCatalog);
    },
    definePrimitive,
    defineLibrary,
    listPrimitives: () => [...extPrims].map(([name, m]) => ({ name, signature: m.signature, doc: m.doc })),
    listLibraries: () => [...libraries].map(([name, l]) => ({ name, description: l.description, count: l.primitives.length, builtin: !!l.builtin })),
    listBindings: listUserBindings,
    addGuard: (guard) => {
      guards.push(guard);
      return () => {
        const i = guards.indexOf(guard);
        if (i >= 0) guards.splice(i, 1);
      };
    },
  };
}
