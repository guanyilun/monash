# Changelog

All notable changes to monash are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Simplified the system prompt for smaller models. It now leads with a worked
  example of each primitive call (`read-file`, `write-file`, `edit-file`, `grep`,
  `glob`, `bash`) as the central content, then gives a short set of
  copy-pasteable patterns each keyed to the situation that triggers it: `let*`
  when each step needs the previous result, `list`/`map` when the calls are
  independent, and a single `bash` call when several shell commands are needed.
  It also notes that `define`d names persist across calls, so the agent can reuse
  a value instead of re-reading or recomputing it. The Scheme-dialect rules are
  demoted to a trailing note. This replaces the
  previous abstract framing, which pushed deep nested pipelines — the most common
  failure in the eval logs.
- The built-in standard library is now presented as a browsable catalog under a
  `## Standard library` prompt section, grouped into domain libraries (`strings`,
  `lists`, `hashtables`, `math`, `control`) and kept separate from host extension
  libraries. Signatures use the host style — string arguments quoted, numbers
  shown as `n` — so a primitive's argument types read clearly.
- The combining-primitives guidance is framed as round-trip economy: group
  related steps into a single evaluation, kept flat with `let*` rather than
  deeply nested, so it reinforces the "keep each form small" note instead of
  pushing toward nested pipelines.
- `bash` returns stdout as a string and `sh` returns the full result alist
  (`output` / `exit-code` / `error`); previously these return types were reversed.
- Bumped `@guanyilun/ashi` to `^0.3.4`.

### Added
- A per-request context block listing the variables the agent has `define`d this
  session (name + a type/size summary), so it reuses bindings instead of
  re-reading or recomputing. It's read from the live interpreter heap on every
  request, so it reflects new `define`s immediately, is empty in a fresh or
  resumed process, and stays consistent through compaction. Registered via
  agent-sh's `registerContextProducer` (`mode: "per-request"`).
- `bindings` primitive — returns the session's `define`d names with a type/size
  summary as an alist. The context block lists only the 40 most recent; this is
  the agent's escape hatch to see the full set when that truncates.
- `list-head` (SRFI-1 / Guile alias for `take`).
- `unlines` — lossless inverse of `lines` (joins with `\n` and terminates with a
  trailing newline), so `read → lines → … → unlines → write-file` round-trips
  preserve the trailing newline that `string-split` trims.
- A standard-library catalog browsable with `(libraries)` and
  `(load-library 'name)`: the SRFI-1 / R7RS / Racket shim layer grouped into five
  domain libraries (`lib/stdlib/`, one module each) with per-library signatures
  and docs. The catalog is metadata only — every name stays always callable — and
  each library is flagged built-in so it reads distinctly from host extensions.
- "Did you mean" suggestions on unbound-variable errors: the nearest real
  bindings (ranked by substring overlap, then edit distance) annotated with their
  library and a pointer to `(load-library)`, so a misremembered name self-corrects.
- A hint on `got boolean` type errors naming the usual cause — an unchecked `#f`
  from a search or lookup (`string-index`, `string-contains`, `member`, `assoc`,
  `find`, `hash-ref`, …) reaching a slot that needs a real value — with the
  `(if v … fallback)` / `(or v default)` guard to apply.
- A per-request nudge that spots a compound expression shape written two or more
  times across calls and suggests `define`-ing it as a reusable helper.

### Fixed
- `read-file` now returns raw file contents instead of the line-numbered
  display text the underlying kernel produces, so `read → transform →
  write-file` round-trips no longer bake line-number prefixes into files.
- `string-split` and other string primitives now accept a character delimiter
  such as `#\newline`; previously a character stringified to its literal form
  and the input split into a single element.
- `string-contains` follows SRFI-13 — returns the match index (or `#f`) so it
  composes with `substring` — instead of a boolean; the boolean predicate
  remains `string-contains?` (Racket). Previously both names returned a boolean.
- `(help 'name)` recognizes standard-library bindings (e.g. `string-index`)
  instead of reporting "no primitive named …", and points at `apropos-list`
  for discovery.
- `edit-file` reports a matched-but-identical edit (`+0 -0`) as a message
  rather than a bare `#t` that read as a successful change.
- `apropos-list` (and the internal env-name walk behind it) returned nothing
  because it read `.env` / `.parent`; this LIPS build exposes frames as
  `__env__` / `__parent__`, which it now walks.

## [0.1.0] - 2026-06-03

Initial release: monash, an agent whose only tool is a Scheme (LIPS) evaluator.

### Added
- `scheme_eval` tool — an R7RS-shaped Scheme interpreter (tolerant of common
  Racket forms) with host primitives for the shell, filesystem, and search:
  `bash`, `sh`, `read-file`, `write-file`, `edit-file`, `grep`, `grep-files`,
  `glob`.
- Extension API (`@guanyilun/monash/scheme`): `scheme:define-primitive`,
  primitives grouped into libraries with on-demand doc disclosure, and
  declarative `args`/`opts` that generate signatures.
- Keyword-symbol binding from the source so extension primitives accept
  `:option` arguments.
- Racket-order `string-split`/`string-join` and a large SRFI-1 / Racket
  standard-library shim layer over LIPS.
- The working directory in the system prompt; `scheme_eval` results and errors
  rendered in the tool body.

[Unreleased]: https://github.com/guanyilun/monash/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/guanyilun/monash/releases/tag/v0.1.0
