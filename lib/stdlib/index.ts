import type { CatalogLib } from "./types.ts";
import { strings } from "./strings.ts";
import { lists } from "./lists.ts";
import { hashtables } from "./hashtables.ts";
import { math } from "./math.ts";
import { control } from "./control.ts";

export type { CatalogLib } from "./types.ts";

// The built-in standard library, one module per domain. This order is the order
// shown in the prompt's "## Standard library" index and in `(libraries)`.
export const STDLIB_CATALOG: CatalogLib[] = [strings, lists, hashtables, math, control];
