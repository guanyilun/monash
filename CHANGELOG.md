# Changelog

All notable changes to monash are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `list-head` (SRFI-1 / Guile alias for `take`).
- `unlines` — lossless inverse of `lines` (joins with `\n` and terminates with a
  trailing newline), so `read → lines → … → unlines → write-file` round-trips
  preserve the trailing newline that `string-split` trims.

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
