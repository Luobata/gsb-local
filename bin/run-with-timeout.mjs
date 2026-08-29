#!/usr/bin/env node

import { spawn } from "node:child_process";
import process from "node:process";

const [timeoutText, command, ...args] = process.argv.slice(2);
const timeoutMs = Number(timeoutText);

if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !command) {
  console.error("usage: run-with-timeout.mjs <milliseconds> <command> [args...]");
  process.exit(2);
}

const child = spawn(command, args, { stdio: "inherit", env: process.env });
let timedOut = false;
let killTimer;
const timeout = setTimeout(() => {
  timedOut = true;
  console.error(`gsb-timeout: ${command} exceeded ${timeoutMs}ms; terminating it`);
  child.kill("SIGTERM");
  killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
}, timeoutMs);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  clearTimeout(timeout);
  if (killTimer) clearTimeout(killTimer);
  console.error(`gsb-timeout: failed to start ${command}: ${error.message}`);
  process.exit(127);
});

child.on("exit", (code, signal) => {
  clearTimeout(timeout);
  if (killTimer) clearTimeout(killTimer);
  if (timedOut) process.exit(124);
  if (signal) {
    console.error(`gsb-timeout: ${command} exited on ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
