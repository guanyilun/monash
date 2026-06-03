// An example monash extension — a single-file drop-in.
//
//   cp examples/http.mts ~/.monash/extensions/http.mts    # then just run `monash`
//   # or, during development:  monash -e ./examples/http.mts
//
// Use the .mts extension, not .ts: a standalone file outside a package has no
// `"type": "module"` nearby, so a .ts there loads as CommonJS and its `export`
// fails. .mts is unambiguously ESM wherever it lands.

export default function activate(ctx: any): void {
  const http = ctx.call("scheme:define-library", {
    name: "http",
    description: "Fetch URLs and parse JSON.",
  });

  http.definePrimitive({
    name: "http-get",
    signature: '(http-get "url") → ((status . n) (body . str))',
    doc: "HTTP GET a URL; returns the status code and response body",
    fn: async (url: string) => {
      const res = await fetch(String(url));
      return { status: res.status, body: await res.text() };
    },
  });

  http.definePrimitive({
    name: "json",
    signature: '(json "text") → value',
    doc: "parse a JSON string into Scheme values (objects → alists, arrays → lists)",
    fn: (text: string) => JSON.parse(String(text)),
  });
}
