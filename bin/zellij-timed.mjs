#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

export function runZellijTimed(args, timeoutMs, { execImpl = execFileSync, env = process.env, bin = env.GSB_ZELLIJ_BIN || "zellij" } = {}) {
  return execImpl(bin, args, {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: Number(timeoutMs),
    killSignal: "SIGKILL",
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [timeoutArg, ...args] = process.argv.slice(2);
  const timeoutMs = Number(timeoutArg);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !args.length) {
    console.error("Usage: zellij-timed.mjs <timeoutMs> <zellij args...>");
    process.exit(2);
  }
  try {
    process.stdout.write(runZellijTimed(args, timeoutMs));
  } catch (error) {
    if (error?.stderr) process.stderr.write(error.stderr);
    process.exit(Number.isInteger(error?.status) ? error.status : 124);
  }
}
