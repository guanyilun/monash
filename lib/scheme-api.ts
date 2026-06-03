import type { ExtensionContext } from "agent-sh/types";
import type { PrimitiveSpec, LibrarySpec, Library, LibraryInfo, Guard, GuardCall } from "./scheme.ts";

export type { PrimitiveSpec, LibrarySpec, Library, LibraryInfo, OptType, OptSpec, ArgSpec, Guard, GuardCall } from "./scheme.ts";
export { kwargs } from "./scheme.ts";

export interface PrimitiveInfo {
  name: string;
  signature?: string;
  doc?: string;
}

export interface Scheme {
  /** Define a standalone primitive (lands in the "misc" library). Prefer
   *  `defineLibrary(...).definePrimitive(...)` so it groups for disclosure. */
  definePrimitive(spec: PrimitiveSpec): void;
  /** Register a library, then define its primitives through the returned handle. */
  defineLibrary(spec: LibrarySpec): Library;
  listPrimitives(): PrimitiveInfo[];
  listLibraries(): LibraryInfo[];
  /** Register a pre-call guard (see Guard). Returns an unsubscribe; no-ops under
   *  a non-monash host. */
  guard(guard: Guard): () => void;
}

export function createScheme(ctx: ExtensionContext): Scheme {
  const has = (name: string): boolean => ctx.list().includes(name);
  return {
    definePrimitive(spec) {
      if (has("scheme:define-primitive")) ctx.call("scheme:define-primitive", spec);
    },
    defineLibrary(spec) {
      if (has("scheme:define-library")) return ctx.call("scheme:define-library", spec) as Library;
      return { name: spec.name, definePrimitive() {} };
    },
    listPrimitives() {
      return has("scheme:list-primitives") ? (ctx.call("scheme:list-primitives") as PrimitiveInfo[]) : [];
    },
    listLibraries() {
      return has("scheme:list-libraries") ? (ctx.call("scheme:list-libraries") as LibraryInfo[]) : [];
    },
    guard(guard) {
      return has("scheme:guard") ? (ctx.call("scheme:guard", guard) as () => void) : () => {};
    },
  };
}
