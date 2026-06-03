import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";
import type { AgentContext } from "agent-sh/types";
import { createInterpreter, DESCRIPTION, MAX_OUTPUT_LEN, summarizeResult, type PrimitiveSpec, type Guard } from "./scheme.ts";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function docsGuide(): string {
  if (!fs.existsSync(path.join(PKG_ROOT, "EXTENDING.md"))) return "";
  return `monash's source and docs are installed at ${PKG_ROOT}. Read them when the user asks how monash works or how to extend it: EXTENDING.md (add capabilities as Scheme primitives, gate calls), lib/ (the interpreter and integration).`;
}

const IDENTITY = `You are monash — a coding agent whose only tool is \`scheme_eval\`, a Scheme interpreter (R7RS-shaped) running on the user's machine.

You act by writing Scheme that calls the built-in primitives — reading files, running commands, searching the project — and composing them into expressions. Each call is one round-trip, so do related work in a single call rather than scattering it across many; intermediate results stay in the Scheme heap, not the conversation.

Scheme, not Common Lisp or Clojure: use \`define\`/\`lambda\`/\`let\`, only \`#f\` is false; \`defun\`/\`setq\`/\`nil\`/\`defn\` do not exist.

Think in expressions and values, not in steps. Let each evaluation inform the next.

You are talking with a person at an interactive terminal. Be direct and concise.`;

const BASE_INSTRUCTION = [
  "Compose related steps into one expression:",
  "  (map (lambda (m) (read-file (cdr (assoc 'file m)) :offset (cdr (assoc 'line m)) :limit 3))",
  '       (grep "TODO" "src/"))',
].join("\n");

const KERNEL_TOOLS = ["bash", "pwsh", "read_file", "write_file", "edit_file", "ls", "glob", "grep"];

function parseRaw(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  return {};
}

function sourceOf(rawInput: unknown): string {
  const r = parseRaw(rawInput);
  return typeof r.source === "string" ? r.source : "";
}

function compact(s: string, max = 80): string {
  const c = s.replace(/\s+/g, " ").trim();
  return c.length > max ? c.slice(0, max - 1) + "…" : c;
}

function stripComments(src: string): string {
  let out = "";
  let inStr = false, esc = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === "#") {
      const n = src[i + 1];
      if (n === "\\") { out += "#\\" + (src[i + 2] ?? ""); i += 2; continue; }
      if (n === ";") { out += "#;"; i += 1; continue; }
      if (n === "|") {
        let depth = 1; i += 2;
        while (i < src.length && depth > 0) {
          if (src[i] === "#" && src[i + 1] === "|") { depth++; i += 2; }
          else if (src[i] === "|" && src[i + 1] === "#") { depth--; i += 2; }
          else i++;
        }
        i--; continue;
      }
      out += c; continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === ";") { while (i < src.length && src[i] !== "\n") i++; i--; continue; }
    out += c;
  }
  return out
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "")
    .join("\n")
    .trim();
}

function gatedOps(source: string, names: string[]): string[] {
  if (names.length === 0) return [];
  const code = stripComments(source) || source;
  const tokens = new Set(code.split(/[\s()'`,;"]+/).filter(Boolean));
  return names.filter((n) => tokens.has(n));
}

const renderModel = {
  initial: ({ rawInput }: any) => ({ source: sourceOf(rawInput) }),
  view: (s: any, env: any) => {
    const failed = !!s.status && s.status.exitCode !== 0 && s.status.exitCode !== null;
    const code = stripComments(s.source) || s.source;
    return {
      title: [
        { text: "λ ", style: { color: "warning" } },
        { text: env.expanded ? code : compact(code), highlight: "scheme" },
      ],
      status: s.status,
      body: failed
        ? { kind: "text", segments: [{ text: `✗ ${s.output.trim()}`, style: { color: "error" } }] }
        : { kind: "stream", text: s.output },
      expandable: true,
      defaultExpanded: failed,
    };
  },
};

export default function activate(ctx: AgentContext): void {
  const interp = createInterpreter(ctx);

  const gated = (ctx.getExtensionSettings("monash", { gate: [] as string[] }).gate ?? []).map(String);
  let allowRestOfSession = false;

  async function permit(source: string): Promise<string | null> {
    if (allowRestOfSession) return null;
    const ops = gatedOps(source, gated);
    if (ops.length === 0) return null;
    if (!ctx.list().includes("ui:select")) {
      return `permission needed to run ${ops.join(", ")}, but no interactive prompt is available; remove them from monash.gate to run unattended`;
    }
    const answer = await ctx.call("ui:select", {
      title: `Allow this evaluation to run ${ops.join(", ")}?`,
      items: [
        { value: "once", label: "Allow once" },
        { value: "always", label: "Allow for the rest of this session" },
        { value: "deny", label: "Deny" },
      ],
    });
    if (answer === "always") { allowRestOfSession = true; return null; }
    if (answer === "once") return null;
    return `permission denied by user (${ops.join(", ")})`;
  }

  ctx.define("scheme:define-primitive", (spec: PrimitiveSpec) => interp.definePrimitive(spec));
  ctx.define("scheme:list-primitives", () => interp.listPrimitives());
  ctx.define("scheme:guard", (guard: Guard) => interp.addGuard(guard));

  for (const name of KERNEL_TOOLS) {
    try { ctx.agent.unregisterTool(name); } catch {}
  }
  const warnedTools = new Set<string>();
  ctx.bus.onPipe("agent:core-tools:collect", (ev: any) => {
    for (const n of ev.names ?? []) {
      if (n !== "scheme_eval" && !warnedTools.has(n)) {
        warnedTools.add(n);
        ctx.bus.emit("ui:info", {
          message: `monash: ignoring tool "${n}" — register a Scheme primitive (scheme:define-primitive) instead`,
        });
      }
    }
    return { ...ev, names: ["scheme_eval"] };
  });

  ctx.bus.onPipe("agent:tools:visible", (ev: any) => ({
    ...ev,
    tools: (ev.tools ?? []).filter((t: any) => t.name === "scheme_eval"),
  }));

  ctx.bus.onPipe("ashi:startup-extensions", (ev: any) => ({
    ...ev,
    names: (ev.names ?? []).filter((n: string) => n !== "monash"),
  }));

  ctx.agent.registerTool({
    name: "scheme_eval",
    displayName: "scheme",
    description: DESCRIPTION,
    maxResultBytes: 128 * 1024,
    input_schema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "Scheme source. One or more top-level forms; value of the last is returned.",
        },
        timeout_ms: {
          type: "number",
          description: "Optional timeout override (default 15000ms, max 60000).",
        },
      },
      required: ["source"],
    },
    getDisplayInfo: () => ({ kind: "execute", icon: "λ", sourceLanguage: "scheme" }),
    formatResult: (args: any, result: any) => {
      const src = String(args.source ?? "");
      const sourceLines = (stripComments(src) || src).split("\n");
      if (!result.isError) {
        return {
          summary: summarizeResult(result.content, false),
          body: { kind: "lines", lines: sourceLines, maxLines: 30 },
        };
      }
      const lines = [...sourceLines, "", "✗ " + result.content];
      return {
        summary: summarizeResult(result.content, true),
        body: { kind: "lines", lines, maxLines: 30 },
      };
    },
    async execute(args: Record<string, unknown>) {
      const source = String(args.source ?? "");
      const timeoutMs = Math.min(Number(args.timeout_ms) || 15000, 60000);
      if (!source.trim()) return { content: "scheme_eval: empty source", exitCode: 1, isError: true };
      const denied = await permit(source);
      if (denied) return { content: denied, exitCode: 1, isError: true };
      const result = await interp.evaluate(source, timeoutMs);
      if (!result.ok) return { content: `scheme error: ${result.error}`, exitCode: 1, isError: true };
      const out = result.value.length > MAX_OUTPUT_LEN
        ? result.value.slice(0, MAX_OUTPUT_LEN) + `\n... [truncated ${result.value.length - MAX_OUTPUT_LEN} chars]`
        : result.value;
      return { content: out, exitCode: 0, isError: false };
    },
  });

  for (const n of ["scheme", "scheme_eval"]) {
    ctx.define(`ashi:render-tool:${n}`, () => renderModel);
  }

  const guide = docsGuide();
  ctx.advise("system-prompt:build", () => {
    const parts = [IDENTITY, BASE_INSTRUCTION];
    const prims = interp.listPrimitives();
    if (prims.length > 0) {
      const catalog = prims
        .map((p) => `  ${p.signature ?? `(${p.name} …)`}${p.doc ? `  — ${p.doc}` : ""}`)
        .join("\n");
      parts.push(`## Extension primitives\nLoaded extensions added these; call them like any built-in.\n${catalog}`);
    }
    if (guide) parts.push(guide);
    return parts.join("\n\n");
  });
}
