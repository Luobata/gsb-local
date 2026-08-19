#!/usr/bin/env node

import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const [target, session, ...roles] = process.argv.slice(2);
const rolePattern = /^[a-z][a-z0-9-]*$/;

function fail(message) {
  console.error(`gsb-layout: ${message}`);
  process.exit(2);
}

if (!target || !session || !roles.length) fail("usage: render-layout.mjs <target> <session> <role>...");
if (!/^[A-Za-z0-9._-]+$/.test(session)) fail(`invalid session: ${session}`);
if (new Set(roles).size !== roles.length) fail("role names must be unique");
if (!roles.includes("hub")) fail("the active role list must include hub");
for (const role of roles) {
  if (!rolePattern.test(role)) fail(`invalid role: ${role}`);
}

const quote = (value) => JSON.stringify(value);
const command = (role) => `exec \"$GSB_LOCAL_ROOT/bin/supervise\" ${role}`;
const title = (role) => role === "hub" ? `hub.${session}.main` : `spk.${session}.${role}`;
const pane = (role, indent, options = "") => [
  `${indent}pane${options} name=${quote(title(role))} command=${quote("/bin/zsh")} {`,
  `${indent}    args ${quote("-lc")} ${quote(command(role))}`,
  `${indent}}`,
];

const spokes = roles.filter((role) => role !== "hub");
const lines = [
  "layout {",
  "    pane size=1 borderless=true {",
  "        plugin location=\"tab-bar\"",
  "    }",
];

if (spokes.length) {
  lines.push('    pane split_direction="vertical" {');
  lines.push(...pane("hub", "        ", ' size="50%" focus=true'));
  lines.push('        pane split_direction="horizontal" {');
  for (const role of spokes) lines.push(...pane(role, "            "));
  lines.push("        }");
  lines.push("    }");
} else {
  lines.push(...pane("hub", "    ", " focus=true"));
}

lines.push(
  "    pane size=2 borderless=true {",
  "        plugin location=\"status-bar\"",
  "    }",
  "}",
  "",
);

await mkdir(path.dirname(target), { recursive: true });
const temporary = `${target}.${process.pid}.tmp`;
await writeFile(temporary, lines.join("\n"), { mode: 0o600 });
await chmod(temporary, 0o600);
await rename(temporary, target);
