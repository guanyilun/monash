import type { CatalogLib } from "./types.ts";

export const hashtables: CatalogLib = {
  name: "hashtables",
  description: "mutable and immutable key/value maps",
  primitives: [
    { name: "make-hash", signature: "(make-hash [alist]) → hash", doc: "Mutable. make-hasheq / make-hasheqv key by eq?/eqv?." },
    { name: "hash", signature: "(hash k v ...) → hash", doc: "Immutable, from alternating key/value args." },
    { name: "hash?", signature: "(hash? x) → bool" },
    { name: "hash-ref", signature: "(hash-ref h k [default]) → any", doc: "A missing key returns default (#f when omitted)." },
    { name: "hash-set!", signature: "(hash-set! h k v) → void", doc: "Mutates h. hash-set returns a new hash instead." },
    { name: "hash-set", signature: "(hash-set h k v) → hash", doc: "Functional: returns an updated copy, leaving h untouched." },
    { name: "hash-update!", signature: "(hash-update! h k proc [default]) → void", doc: "Applies proc to the current value (or default). hash-update is the functional form." },
    { name: "hash-remove!", signature: "(hash-remove! h k) → void", doc: "hash-remove is functional." },
    { name: "hash-has-key?", signature: "(hash-has-key? h k) → bool" },
    { name: "hash-keys", signature: "(hash-keys h) → list" },
    { name: "hash-values", signature: "(hash-values h) → list" },
    { name: "hash-count", signature: "(hash-count h) → n", doc: "hash-empty? tests for zero." },
    { name: "hash->list", signature: "(hash->list h) → (listof pair)" },
    { name: "hash-map", signature: "(hash-map h proc) → list", doc: "Hash first; proc is called (k v). hash-for-each for side effects." },
    { name: "hash-for-each", signature: "(hash-for-each h proc) → void", doc: "Hash first; proc is called (k v)." },
    { name: "hash-copy", signature: "(hash-copy h) → hash" },
  ],
};
