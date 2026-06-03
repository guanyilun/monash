# monash

**An agent with a single tool.**

monash is an AI agent reduced to one verb: a small Lisp. There's no bash, no
file editor, no search command — its only tool evaluates Lisp. Reading files,
running commands, searching the project are all built-in primitives, so monash
works by composing them into expressions instead of firing one-shot tool calls.

## Install

```sh
npm i -g @guanyilun/monash
```

## Use

```sh
monash                 # start the agent
monash -c              # continue the last session in this directory
```

monash is an interactive terminal chat: type a request, read the reply, and
watch each expression evaluate as it works.

## Authenticate

monash needs an API key for your model provider. Either store one:

```sh
monash auth login      # paste a key; saved privately under ~/.monash
```

`monash auth list` shows what's configured; `monash auth logout <provider>`
removes a key.

## How it works

Everything monash does is Lisp. Rather than juggling separate tools for the
shell, files, and search, it has one — a Lisp interpreter whose primitives cover
all three. Ask for something and it writes an expression, evaluates it, reads the
result, and continues; you see the source and its value at every step.

## Permissions

monash runs every primitive freely by default. To require confirmation before
certain ones, list them in `~/.monash/settings.json`:

```json
{ "monash": { "gate": ["bash", "write-file", "edit-file"] } }
```

Any evaluation that calls a listed primitive prompts once before it runs — allow
once, allow for the session, or deny. The list can name built-ins or primitives
added by extensions. For finer policies — gating only *dangerous* commands,
restricting write paths, auditing calls — register a guard from an extension; see
[EXTENDING.md](EXTENDING.md).

## Extending

monash has one tool, so you add capability by registering a Scheme **primitive**
— a plain JS function the model can call and compose — not a tool. See
[EXTENDING.md](EXTENDING.md).

## Development

monash is built on [agent-sh](https://github.com/guanyilun/agent-sh). The
monash-specific pieces live here and ship on their own cadence:

- `lib/scheme.ts` — the interpreter: the Scheme engine, its primitives, and the
  tool description.
- `lib/monash.ts` — the agent integration: registers the one tool, the system
  prompt, and the renderer.
- `lib/scheme-api.ts` — the extension API (`@guanyilun/monash/scheme`): `createScheme(ctx)`.
- `bin.mjs` — the launcher.

```sh
npm install
npm link        # expose the `monash` command locally
```

## License

MIT
