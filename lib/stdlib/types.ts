// Catalog metadata for one built-in standard-library domain. This is a catalog
// only: every name listed is already bound by installStdShims/std — a library
// entry adds discoverability, never callability. `(load-library 'name)` reveals
// these signatures; nothing here gates a call.
export type CatalogLib = {
  name: string;
  description: string;
  doc?: string;
  primitives: Array<{ name: string; signature: string; doc?: string }>;
};
