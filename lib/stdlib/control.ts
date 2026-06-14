import type { CatalogLib } from "./types.ts";

export const control: CatalogLib = {
  name: "control",
  description: "apply, equality, predicates, errors",
  primitives: [
    { name: "apply", signature: "(apply proc arg ... lst) → any", doc: "Calls proc with the leading args plus the elements of the final list spread in." },
    { name: "procedure?", signature: "(procedure? x) → bool" },
    { name: "identity", signature: "(identity x) → x" },
    { name: "void", signature: "(void any ...) → void", doc: "Discards its arguments — the 'no useful value' result." },
    { name: "error", signature: "(error \"msg\" arg ...) → !", doc: "Raises and aborts the whole evaluation." },
    { name: "not", signature: "(not x) → bool", doc: "Only #f is false; 0, \"\" and '() are all true." },
    { name: "eq?", signature: "(eq? a b) → bool", doc: "Pointer identity. eqv? for numbers/chars, equal? for deep/structural comparison." },
    { name: "eqv?", signature: "(eqv? a b) → bool" },
    { name: "equal?", signature: "(equal? a b) → bool" },
    { name: "andmap", signature: "(andmap pred lst ...) → bool", doc: "Racket: #t when every element satisfies pred. ormap is the existential (SRFI: every / any)." },
    { name: "ormap", signature: "(ormap pred lst ...) → bool" },
  ],
};
