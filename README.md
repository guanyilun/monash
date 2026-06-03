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

## Configure providers

monash works with any OpenAI-compatible API. You can configure providers in
`~/.monash/settings.json`, pass CLI flags, or set environment variables — they
compose, with CLI flags taking highest precedence.

### Provider profiles in settings.json

Define named providers in `~/.monash/settings.json` so you don't pass flags
every time. The `apiKey` field supports `$ENV_VAR` and `${ENV_VAR}` syntax —
secrets are expanded at runtime and never stored in plaintext in the file:

```json
{
  "defaultProvider": "openai",
  "providers": {
    "openai": {
      "apiKey": "$OPENAI_API_KEY",
      "defaultModel": "gpt-4o",
      "models": ["gpt-4o", "gpt-4o-mini"]
    },
    "ollama": {
      "apiKey": "not-needed",
      "baseURL": "http://localhost:11434/v1",
      "defaultModel": "llama3",
      "models": ["llama3", "mistral", "codellama"]
    },
    "openrouter": {
      "apiKey": "$OPENROUTER_KEY",
      "baseURL": "https://openrouter.ai/api/v1",
      "defaultModel": "anthropic/claude-sonnet-4-20250514"
    }
  }
}
```

Then launch with:

```sh
monash                          # uses defaultProvider
monash --provider ollama        # pick a specific provider
monash --provider openai --model gpt-4-turbo  # override model
```

### Quick start

**OpenAI**

```sh
export OPENAI_API_KEY="sk-..."
monash --model gpt-4o
```

**OpenRouter**

```sh
monash --api-key "$OPENROUTER_KEY" \
  --base-url https://openrouter.ai/api/v1 \
  --model anthropic/claude-sonnet-4-20250514
```

**Ollama (local, no auth)**

```sh
monash --api-key dummy --base-url http://localhost:11434/v1 --model llama3
```

**LM Studio / vLLM (local)**

```sh
monash --api-key dummy --base-url http://localhost:1234/v1 --model local-model
```

### CLI flags

| Flag | Environment variable | Description |
|---|---|---|
| `--provider <name>` | — | Provider profile from settings.json |
| `--model <name>` | — | Model name (overrides provider default) |
| `--api-key <key>` | `OPENAI_API_KEY` | API key |
| `--base-url <url>` | `OPENAI_BASE_URL` | Base URL for API endpoint |

Precedence (highest to lowest): CLI flags → environment variables →
provider profile in settings.json → built-in defaults.

### Switching models at runtime

Inside a session, `/model` shows the current model. `/model <name>` switches
to a different model (possibly crossing providers) without losing conversation
state.

### Reference

For the full settings schema — per-model `contextWindow`, `reasoning` flags,
`defaultBackend`, `extensions`, and more — see the
[agent-sh usage guide](https://github.com/guanyilun/agent-sh/blob/main/docs/usage.md).
monash shares agent-sh's configuration model; the only difference is that
monash stores its settings in `~/.monash/settings.json` instead of
`~/.agent-sh/settings.json`.

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
