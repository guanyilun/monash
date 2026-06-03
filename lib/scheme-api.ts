import type { ExtensionContext } from "agent-sh/types";
import type { PrimitiveSpec, Guard, GuardCall } from "./scheme.ts";

export type { PrimitiveSpec, OptType, OptSpec, ArgSpec, Guard, GuardCall } from "./scheme.ts";
export { kwargs } from "./scheme.ts";

export interface PrimitiveInfo {
  name: string;
  signature?: string;
  doc?: string;
}

export interface Scheme {
  definePrimitive(spec: PrimitiveSpec): void;
  listPrimitives(): PrimitiveInfo[];
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
    listPrimitives() {
      return has("scheme:list-primitives") ? (ctx.call("scheme:list-primitives") as PrimitiveInfo[]) : [];
    },
    guard(guard) {
      return has("scheme:guard") ? (ctx.call("scheme:guard", guard) as () => void) : () => {};
    },
  };
}
