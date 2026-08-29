#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
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
const shellQuote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;
const sessionEnvFile = process.env.GSB_SESSION_ENV_FILE;
const rootDir = process.env.GSB_LOCAL_ROOT;
if (!sessionEnvFile || !path.isAbsolute(sessionEnvFile)) fail("GSB_SESSION_ENV_FILE must be an absolute path");
if (!rootDir || !path.isAbsolute(rootDir)) fail("GSB_LOCAL_ROOT must be an absolute path");
const command = (role) => `source ${shellQuote(sessionEnvFile)} && exec ${shellQuote(path.join(rootDir, "bin", "supervise"))} ${shellQuote(role)}`;

function agentSpec(role) {
  const key = `GSB_${role.replaceAll("-", "_").toUpperCase()}_AGENT`;
  return process.env[key] || "agent";
}

function roleModel(role) {
  const key = `GSB_${role.replaceAll("-", "_").toUpperCase()}_MODEL`;
  return process.env[key] || null;
}

function codexDefaultModel() {
  try {
    const config = readFileSync(path.join(os.homedir(), ".codex", "config.toml"), "utf8");
    return config.match(/^model\s*=\s*"([^"]+)"/m)?.[1] || null;
  } catch {
    return null;
  }
}

function modelLabel(role) {
  const spec = agentSpec(role);
  const configured = roleModel(role);
  if (configured) return configured;
  if (spec === "codex" || spec.startsWith("codex:")) {
    return process.env.GSB_MODEL || codexDefaultModel() || spec.replace(/^codex:/, "");
  }
  if (spec === "kimi" || spec.startsWith("kimi:")) {
    return process.env.GSB_KIMI_MODEL || process.env.GSB_MODEL || "kimi-code/k3-256k";
  }
  if (spec.startsWith("claude:")) {
    return process.env.GSB_MODEL || spec.slice("claude:".length);
  }
  if (spec === "claude") return process.env.GSB_MODEL || spec;
  if (spec.startsWith("shell:")) return "custom-shell";
  return process.env.GSB_MODEL || spec;
}

const baseTitle = (role) => role === "hub" ? `hub.${session}.main` : `spk.${session}.${role}`;
const title = (role) => `${baseTitle(role)} · ${modelLabel(role)}`;
const pane = (role, indent, options = "") => [
  `${indent}pane start_suspended=false${options} name=${quote(title(role))} command=${quote("/bin/zsh")} {`,
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
