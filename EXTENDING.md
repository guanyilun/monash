# Extending monash

monash has exactly one tool: `scheme_eval`. So you don't add capability by
registering a *tool* — you register **primitives** into the Scheme environment,
grouped into a named **library**. The model then calls them like any built-in and
composes them with the rest of the language in a single evaluation.

You first register a library, then define its primitives through the returned
handle. The library is the unit of *progressive disclosure*: only library
name+description sits in the system prompt; the agent pulls a library's full
primitive docs into context on demand with `(load-library "name")` (see
[Libraries & disclosure](#libraries--disclosure)). Primitives are callable the
moment they're registered — loading only governs where their docs show up.

There are two ways to register, depending on how you ship the extension.

## A single-file drop-in

Drop a file into `~/.monash/extensions/` (or pass `monash -e ./my-ext.mts`). Use
the **`.mts`** extension, not `.ts`: a standalone file there has no `"type":
"module"` package nearby, so a `.ts` loads as CommonJS and its `export` fails —
`.mts` is unambiguously ESM wherever it lands. A loose file also can't `import`
from monash (nothing makes a global install resolvable from that directory), so
it registers straight through the `scheme:define-primitive` handler — no imports
to resolve:

```ts
// ~/.monash/extensions/http.mts
export default function activate(ctx: any) {
  const http = ctx.call("scheme:define-library", {
    name: "http",
    description: "Make HTTP requests.",   // one-liner shown in the prompt catalog
  });
  http.definePrimitive({
    name: "http-get",
    signature: '(http-get "url") → ((status . n) (body . str))',
    doc: "HTTP GET a URL; returns the status code and response body",
    fn: async (url) => {
      const res = await fetch(String(url));
      return { status: res.status, body: await res.text() };
    },
  });
}
```

`ctx.call("scheme:define-library", …)` returns a handle whose `definePrimitive`
tags each primitive with the library — `ctx.call` is in-process here, so the
handle is a real object, not a wire message.

The complete version (with a `json` primitive too) is in
[`examples/http.mts`](examples/http.mts) — copy it to
`~/.monash/extensions/http.mts` and run `monash`.

## A typed wrapper (for project extensions)

If your extension lives in a project that depends on monash — or you install it
as a directory extension via `monash install ./my-ext` (which runs `npm install`)
— then monash *is* resolvable and you can import the typed wrapper. It's the same
shape as ashi's `createUi`: real types, no magic strings.

```ts
import { createScheme } from "@guanyilun/monash/scheme";

export default function activate(ctx) {
  const db = createScheme(ctx).defineLibrary({
    name: "db",
    description: "Query the project database.",
  });
  db.definePrimitive({
    name: "db-query",
    signature: '(db-query "sql") → (listof alist)',
    doc: "run a read-only SQL query; each row is an alist",
    fn: async (sql) => db.query(String(sql)),
  });
}
```

`createScheme` degrades gracefully: under a non-monash host `defineLibrary`
returns a handle whose `definePrimitive` no-ops, so the same extension stays
loadable elsewhere. Both paths register the identical spec — the wrapper is just
typed sugar over the same `ctx.call`.

## Composing

Either way, the model gets a primitive it composes in one `scheme_eval` call; the
rich return lives in the Scheme heap, never stringified mid-flight:

```scheme
(map (lambda (row) (cdr (assoc 'email row)))
     (db-query "select email from users where active"))
```

## The spec

```ts
{
  name: string;          // the Scheme identifier, e.g. "db-query"
  doc?: string;          // one-line description
  fn: (...args) => any;  // your implementation (sync or async)
  signature?: string;    // shown to the model + in (help); auto-generated if you declare args/opts
  raw?: boolean;         // opt out of marshalling (see below)
  // Declarative interface (see "Keyword arguments") — enables auto-parse + signature generation:
  args?: Array<string | { name; type? }>;          // positional params
  opts?: Record<string, Type | { type?; default? }>;  // keyword options; Type = "string" | "number" | "boolean" | "any"
  returns?: string;      // return-type blurb for the generated signature
}
```

## Marshalling — you write plain JS

By default `fn` receives plain JS and returns plain JS; monash converts both
directions, so you never touch LIPS values:

- **Arguments (LIPS → JS):** string → `string`, number → `number`, symbol →
  `string`, list → `Array` (recursively), `'()` → `[]`.
- **Return (JS → LIPS):** `Array` → list, plain object → alist (symbol keys),
  string/number/boolean → as-is, `null` → `'()`, `undefined` → no value.
- `fn` may be **async** — return a `Promise` and the value resolves inside the
  same evaluation.

For genuine LIPS values (a closure, lazy stream, hash-table), set `raw: true`;
then `fn` receives the raw LIPS arguments and must return a raw LIPS value.

## Keyword arguments

The model calls a primitive with options after the positionals — a bare
`:keyword` self-evaluates, so this just works at the call site:

```scheme
(my-search "query" :limit 5 :sort-by "date")
```

**Declarative (recommended).** Declare `args` and `opts`; monash splits
positionals from keywords, coerces each option to its type, applies defaults,
rejects unknown options, and **generates the `signature`** so it can't drift
from the implementation. `fn` receives `(...positionals, opts)`:

```ts
{
  name: "my-search",
  doc: "Search things.",
  args: ["query"],
  opts: {
    limit:     { type: "number", default: 10 },
    "sort-by": { type: "string", default: "relevance" },
    refereed:  "boolean",   // shorthand for { type: "boolean" }
  },
  returns: "(listof alist)",
  fn: (query, opts) => {
    // opts → { limit: 10, "sort-by": "relevance", refereed?: true }
    // already colon-stripped, coerced, and defaulted
  },
}
```

Option keys keep their Scheme spelling, so read `opts["sort-by"]`. Omitted
positionals arrive as `null`, so `opts` always lands at the same parameter slot.
The generated signature above is
`(my-search "query" [:limit n] [:sort-by str] [:refereed bool]) → (listof alist)`.

**Manual.** For variadic or hand-rolled primitives, skip `args`/`opts` and fold
the keyword tail yourself with the `kwargs` helper:

```ts
import { kwargs } from "@guanyilun/monash/scheme";

fn: (query, ...rest) => {
  const { limit = 10, "sort-by": sort = "date" } = kwargs(rest);
}
```

Either way, every keyword needs a value — there are no bare flags; pass
`:refereed #t`, not a lone `:refereed`.

## Loading & resolution

monash discovers extensions from three places, all loaded **after** monash
itself — so registering in `activate()` is always safe; the
`scheme:define-primitive` handler exists by then:

1. **`-e` flag** — `monash -e ./my-ext.ts` (handy during development).
2. **`~/.monash/extensions/`** — a drop-in file, or `monash install <name>`.
3. **`~/.monash/settings.json`** — an `extensions: [...]` array.

Why two registration styles: Node resolves `import "@guanyilun/monash/scheme"` relative to
*your file's* location. A loose file in `~/.monash/extensions/` has no
`node_modules` containing monash (a global install isn't on that path), so the
import can't resolve — hence `ctx.call` for drop-ins. A directory extension
installed with `monash install` gets an `npm install`, which makes the import
resolve; an extension developed inside a project simply lists monash as a
dependency.

## Libraries & disclosure

The system prompt does **not** list every primitive — that would bloat context
and blur the model's focus as libraries accumulate. Instead it lists library
*headers* (name + the one-line `description`), and the model pulls a library's
full docs into context only when it needs them:

```
## Primitive libraries
  ads — Search astronomy/physics literature on NASA ADS — papers, citations, PDFs.
  http — Make HTTP requests.
```

This mirrors a skill exactly — `description` is the always-present one-liner;
`doc` is the on-demand body:

- **`description`** (required) — the one sharp sentence in the prompt catalog.
  It's the model's whole basis for deciding to load the library, so make it count.
- **`doc`** (optional) — longer library-level instructions, shown *only* on load.
  Put guidance here that applies to the whole library (e.g. "read `SKILL.md`
  before composing queries"), not glued to one primitive.

- **`(load-library "ads")`** → returns the library's `doc` (if any) followed by
  every primitive's signature+doc; it lands in the conversation and stays until
  compaction (same lifecycle as a loaded skill).
- **`(libraries)`** → returns the catalog as *data* — `((name . "ads")
  (description . "…") (count . 4) (loaded . #f)) …` — so the model can reason
  about what to pull in.
- **`(help)`** / **`(help 'ads-search)`** still do flat lookup across everything.

The split that makes this cheap: **registration is free, documentation is the
cost.** Every primitive is bound in the environment the moment it's registered,
so it's callable from turn one whether or not its library is "loaded" — loading
only governs whether the docs are *in front of* the model.

Standalone `definePrimitive` (no library) still works — its primitives land in a
`misc` library — but prefer `defineLibrary` so related primitives disclose together.

## Gating primitive calls (permissions)

monash is permissive by default — nothing prompts. There are two ways to add
oversight, and you can use both:

- **By name, no code** — set `monash.gate` in `~/.monash/settings.json` to a list
  of primitive names; any evaluation that calls one prompts once before it runs
  (see the README). Good for the common "confirm every write" case.
- **By content / path / custom logic** — register a **guard**. It runs before
  each side-effecting primitive (`bash`, `sh`, `write-file`, `edit-file`) and
  every extension primitive, with the call's resolved arguments, and can deny:

```ts
import { createScheme } from "@guanyilun/monash/scheme";

export default function activate(ctx) {
  const scheme = createScheme(ctx);
  const danger = /\brm\s+-rf?\b|\bmkfs\b|\|\s*sh\b/;
  scheme.guard(({ name, args }) => {
    if ((name === "bash" || name === "sh") && danger.test(String(args[0] ?? "")))
      return ctx.call("ui:confirm", { title: `Allow: ${args[0]} ?` }); // false → deny
    // anything else (including no return) → allow
  });
}
```

Single-file drop-ins call the handler directly — `ctx.call("scheme:guard", fn)`;
see [`examples/gate-dangerous.mts`](examples/gate-dangerous.mts).

**Show the change, not just a title.** A guard can render a real diff box — the
same one `write-file` shows — and put it in the confirm, so you approve seeing
exactly what will happen. ashi renders the diff (`ui:diff`) and dialogs take a
`body`, so a drop-in needs no diff library:

```ts
ctx.call("scheme:guard", ({ name, args }) => {
  if (name !== "edit-file") return;            // allow everything else
  const [path, oldText, newText] = args;
  const diff = ctx.call("ui:diff", { before: oldText, after: newText, filePath: path });
  return ctx.call("ui:confirm", { title: `Apply edit to ${path}?`, body: diff });
});
```

The full version (write-file too) is in
[`examples/gate-diff.mts`](examples/gate-diff.mts). `ui:diff` takes
`{ before, after, filePath?, boxed? }` (`before: null` → new-file preview) and
returns pre-styled lines; pass them as the `body` of `ui:confirm`/`ui:select`.

**The guard contract** — `({ name, args }) => verdict`:

- `args` are resolved JS values: `bash`/`sh` → `[command]`, `write-file` →
  `[path, content]`, `edit-file` → `[path, old, new]`, extension primitives → the
  marshalled call args.
- Return `false` or `"deny"` to block — the call throws `permission denied` into
  the eval, which the model sees and can adapt to. Anything else allows.
- Async is fine, so a guard can `await ctx.call("ui:confirm", …)` (boolean) or
  `"ui:select"` to ask the user. Under a headless backend those resolve to
  no/undefined, so a prompt-based guard denies when there's no one to ask.
- Guards stack; if any denies, the call is blocked.

This is a cooperative speed-bump for honest mistakes, not a sandbox — a regex
won't catch an obfuscated or aliased command. For real isolation, run monash
under an OS-level sandbox.

## Note: tools are ignored

monash is single-tool by construction, so a plain `ctx.agent.registerTool(…)` is
dropped (with a one-line notice) — it would never reach the model. Register a
primitive instead.
