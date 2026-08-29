#!/usr/bin/env node

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const [command, file, field] = process.argv.slice(2);

function fail(message) {
  console.error(`gsb-session-meta: ${message}`);
  process.exit(2);
}

function readMetadata() {
  if (!file || !path.isAbsolute(file)) fail("metadata path must be absolute");
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("root must be an object");
    if (value.version !== 1) throw new Error(`unsupported version: ${value.version}`);
    if (typeof value.session !== "string" || !/^[A-Za-z0-9._-]+$/.test(value.session)) throw new Error("invalid session");
    if (typeof value.workspace !== "string" || !path.isAbsolute(value.workspace)) throw new Error("workspace must be absolute");
    if (typeof value.stateDir !== "string" || !path.isAbsolute(value.stateDir)) throw new Error("stateDir must be absolute");
    if (typeof value.configPath !== "string" || !path.isAbsolute(value.configPath)) throw new Error("configPath must be absolute");
    return value;
  } catch (error) {
    fail(`cannot read ${file}: ${error.message}`);
  }
}

if (command === "get") {
  if (!field) fail("get requires a field name");
  const value = readMetadata()[field];
  if (value === undefined || value === null) process.exit(1);
  if (Array.isArray(value)) process.stdout.write(value.join(","));
  else if (typeof value === "object") process.stdout.write(JSON.stringify(value));
  else process.stdout.write(String(value));
  process.exit(0);
}

if (command === "write") {
  if (!file || !path.isAbsolute(file)) fail("metadata path must be absolute");
  const required = ["GSB_SESSION", "GSB_WORKSPACE", "GSB_CONFIG_PATH", "GSB_STATE_DIR"];
  for (const name of required) {
    if (!process.env[name]) fail(`${name} is required`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(process.env.GSB_SESSION)) fail("GSB_SESSION is invalid");
  for (const name of ["GSB_WORKSPACE", "GSB_CONFIG_PATH", "GSB_STATE_DIR"]) {
    if (!path.isAbsolute(process.env[name])) fail(`${name} must be absolute`);
  }
  const metadata = {
    version: 1,
    session: process.env.GSB_SESSION,
    workspace: process.env.GSB_WORKSPACE,
    stateDir: process.env.GSB_STATE_DIR,
    configPath: process.env.GSB_CONFIG_PATH,
    configSource: process.env.GSB_CONFIG_SOURCE || "project",
    configProfile: process.env.GSB_CONFIG_PROFILE || "",
    modelsConfigPath: process.env.GSB_MODELS_CONFIG_PATH || "",
    roles: (process.env.GSB_ROLES || "").split(",").filter(Boolean),
    fullAccess: process.env.GSB_FULL_ACCESS === "true",
    permissionProfile: process.env.GSB_PERMISSION_PROFILE || "balanced",
    watchdogEnabled: process.env.GSB_WATCHDOG_ENABLED !== "false",
    updatedAt: new Date().toISOString(),
  };
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
  process.exit(0);
}

fail("usage: session-meta.mjs get <absolute-file> <field> | write <absolute-file>");
