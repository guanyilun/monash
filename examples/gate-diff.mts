// An example monash extension — confirm writes/edits with a diff box.
//
//   cp examples/gate-diff.mts ~/.monash/extensions/gate-diff.mts
//   # or, during development:  monash -e ./examples/gate-diff.mts
//
// Before each write-file / edit-file, this renders the change as a diff — the
// same box write-file shows in the transcript — and asks to apply it. Deny and
// the call returns "permission denied" to the model.
//
// It's a pure drop-in: every UI call goes through a named handler, so it needs
// no imports beyond node:fs. Requires an ashi that provides `ui:diff` and the
// dialog `body` field (confirm the change is shown, not just a title).

import { readFileSync } from "node:fs";

function safeRead(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

export default function activate(ctx: any): void {
  ctx.call("scheme:guard", ({ name, args }: { name: string; args: any[] }) => {
    if (name === "write-file") {
      const [path, content] = args;
      const diff = ctx.call("ui:diff", {
        before: safeRead(String(path)),
        after: String(content ?? ""),
        filePath: String(path),
      });
      return ctx.call("ui:confirm", { title: `Write ${path}?`, body: diff });
    }
    if (name === "edit-file") {
      const [path, oldText, newText] = args;
      const diff = ctx.call("ui:diff", {
        before: String(oldText ?? ""),
        after: String(newText ?? ""),
        filePath: String(path),
      });
      return ctx.call("ui:confirm", { title: `Apply edit to ${path}?`, body: diff });
    }
  });
}
