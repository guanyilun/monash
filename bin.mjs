#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import * as path from "node:path";

const require = createRequire(import.meta.url);

const HOME = process.env.MONASH_HOME
  ? path.resolve(process.env.MONASH_HOME)
  : path.join(os.homedir(), ".monash");

const MONASH = fileURLToPath(new URL("./lib/monash.ts", import.meta.url));

const args = process.argv.slice(2);
const MANAGEMENT = new Set(["install", "uninstall", "list", "auth", "init"]);

const ashiArgs = MANAGEMENT.has(args[0] ?? "")
  ? args
  : ["-e", MONASH, ...args];

const child = spawn(process.execPath, [require.resolve("@guanyilun/ashi"), ...ashiArgs], {
  stdio: "inherit",
  env: { ...process.env, AGENT_SH_HOME: HOME },
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
