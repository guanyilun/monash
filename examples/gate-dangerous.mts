// An example monash extension — gate dangerous shell commands.
//
//   cp examples/gate-dangerous.mts ~/.monash/extensions/gate-dangerous.mts
//   # or, during development:  monash -e ./examples/gate-dangerous.mts
//
// monash is permissive by default. A guard is consulted before each
// side-effecting primitive (bash, sh, write-file, edit-file) and every
// extension primitive, with the call's resolved arguments. Return false (or
// "deny") to block the call — it surfaces as "permission denied" to the model.
// Returning anything else (including nothing) allows it. Async is fine, so a
// guard can await an interactive confirmation.
//
// Use the .mts extension, not .ts (a loose .ts there loads as CommonJS).

const DANGER = /\brm\s+-rf?\b|\bmkfs\b|\bdd\s+if=|\|\s*sh\b|\bsudo\b|>\s*\/dev\//;

export default function activate(ctx: any): void {
  ctx.call("scheme:guard", ({ name, args }: { name: string; args: any[] }) => {
    if ((name === "bash" || name === "sh") && DANGER.test(String(args[0] ?? ""))) {
      return ctx.call("ui:confirm", { title: `Allow this command?  ${args[0]}` });
    }
  });
}
