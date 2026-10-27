#!/usr/bin/env node

// Multiplexer backend facade. GSB's pane I/O (pane-send, nudge, watchdog,
// layout-status) talks to this interface instead of Zellij directly, so the
// same workbench can run on either backend:
//
//   zellij — pane ids are numeric, titles come from the layout KDL
//   herdr  — pane ids look like "w1:p2", titles come from `pane rename` labels
//
// Both adapters normalize panes to:
//   { id, title, focused, exited, isPlugin, agentStatus }
// agentStatus is herdr-only (idle|working|blocked|done|unknown); zellij
// reports null and callers fall back to screen heuristics.
//
// CLI form (used by bash callers such as nudge):
//   mux.mjs list-panes <session>            → normalized pane JSON
//   mux.mjs read <session> <paneId>         → pane viewport text
//   mux.mjs send-text <session> <paneId> <text>
//   mux.mjs send-keys <session> <paneId> <key> [key...]
//   mux.mjs pane-exists <session> <paneId>  → exit 0 when the pane is live
//   mux.mjs session-active <session>        → exit 0 when the session is live
//   mux.mjs session-health <session> [roles-csv]
//                                           → "<state> <missing-roles-csv>"
//   mux.mjs print-attach <session>          → attach command for humans
//
// Backend selection: GSB_MUX (zellij|herdr, default zellij). The zellij
// adapter honors GSB_ZELLIJ_BIN/ZELLIJ_* exactly like the previous direct
// calls; the herdr adapter honors GSB_HERDR_BIN and talks to the local herdr
// server socket. Set GSB_MUX_TIMEOUT_MS per caller (default 10s).

import { execFileSync, spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export class MuxError extends Error {
  constructor(message, exitCode = 4) { super(message); this.exitCode = exitCode; }
}

export function resolveBackendName(env) {
  const raw = String(env.GSB_MUX || "zellij").trim().toLowerCase();
  if (raw !== "zellij" && raw !== "herdr") {
    throw new MuxError(`unsupported GSB_MUX: ${raw} (expected zellij or herdr)`, 2);
  }
  return raw;
}

export function runTimedExec(bin, args, env, timeoutMs) {
  return execFileSync(bin, args, {
    env,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 16 * 1024 * 1024,
  }).toString("utf8");
}

const runTimed = runTimedExec;

// ---------------------------------------------------------------------------
// Zellij adapter
// ---------------------------------------------------------------------------

function zellijFallbackAllowed(args) {
  return args[0] === "action" && (args[1] === "list-panes" || args[1] === "dump-screen");
}

// External callers do not inherit the session contract. Recover the saved
// ZELLIJ_SOCKET_DIR (and GSB_MUX) from the session's own session.env so a
// bare `mux.mjs list-panes <session>` targets the right socket directory
// instead of zellij's default, where unrelated sessions live.
function sessionEnvValue(session, env, name) {
  try {
    const stateDir = env.GSB_STATE_DIR ||
      path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state"), "gsb-local", session);
    const match = readFileSync(path.join(stateDir, "session.env"), "utf8").match(new RegExp(`^export ${name}=(\\S+)$`, "m"));
    return match ? match[1].replace(/^['"]|['"]$/g, "") : null;
  } catch { return null; }
}

function envWithSessionContract(env, session) {
  const scoped = { ...env };
  if (!scoped.ZELLIJ_SOCKET_DIR) {
    const saved = sessionEnvValue(session, env, "ZELLIJ_SOCKET_DIR");
    if (saved) scoped.ZELLIJ_SOCKET_DIR = saved;
  }
  if (!scoped.GSB_MUX) {
    const saved = sessionEnvValue(session, env, "GSB_MUX");
    if (saved) scoped.GSB_MUX = saved;
  }
  return scoped;
}

export { envWithSessionContract };

function createZellij(env) {
  const bin = env.GSB_ZELLIJ_BIN || "zellij";
  const timeoutMs = Number(env.GSB_MUX_TIMEOUT_MS || 10_000);
  function zellij(args) {
    const scoped = { ...envWithSessionContract(env, args.session), ZELLIJ_SESSION_NAME: args.session };
    try {
      return runTimed(bin, args.argv, scoped, timeoutMs);
    } catch (error) {
      if (!scoped.ZELLIJ_SOCKET_DIR || !zellijFallbackAllowed(args.argv)) {
        const stderr = String(error?.stderr || "").trim();
        throw new MuxError(`zellij ${args.argv[1] || args.argv[0]} failed: ${stderr || error.message}`);
      }
      delete scoped.ZELLIJ_SOCKET_DIR;
      return runTimed(bin, args.argv, scoped, timeoutMs);
    }
  }
  return {
    name: "zellij",
    async listPanes(session) {
      const panes = JSON.parse(zellij({ session, argv: ["action", "list-panes", "--json", "--all"] }));
      if (!Array.isArray(panes)) throw new MuxError("invalid list-panes response");
      return panes.map((pane) => ({
        id: String(pane.id),
        title: pane.title || "",
        focused: Boolean(pane.is_focused),
        exited: Boolean(pane.exited),
        isPlugin: Boolean(pane.is_plugin),
        agentStatus: null,
      }));
    },
    async dumpScreen(session, paneId) {
      return zellij({ session, argv: ["action", "dump-screen", "--pane-id", String(paneId)] });
    },
    async sendText(session, paneId, text) {
      zellij({ session, argv: ["action", "write-chars", "--pane-id", String(paneId), text] });
    },
    async sendKeys(session, paneId, keys) {
      zellij({ session, argv: ["action", "send-keys", "--pane-id", String(paneId), ...keys] });
    },
    async sessionActive(session) {
      try {
        const scoped = envWithSessionContract(env, session);
        const list = runTimed(bin, ["list-sessions", "--no-formatting"], { ...scoped, ZELLIJ_SESSION_NAME: session }, timeoutMs);
        return list.split("\n").some((line) => {
          const fields = line.trim().split(/\s+/);
          return fields[0] === session && !/EXITED/.test(line);
        });
      } catch { return false; }
    },
    attachArgv(session) { return ["attach", session]; },
  };
}

// ---------------------------------------------------------------------------
// herdr adapter
// ---------------------------------------------------------------------------

// GSB key names ("Enter", "Ctrl c") → herdr key names.
const HERDR_KEY_MAP = { "Enter": "enter", "Tab": "tab", "Esc": "esc", "Ctrl c": "ctrl+c", "Ctrl u": "ctrl+u" };

function herdrKey(key) {
  const mapped = HERDR_KEY_MAP[key];
  if (mapped) return mapped;
  throw new MuxError(`unsupported key for herdr backend: ${JSON.stringify(key)}`, 2);
}

function createHerdr(env) {
  const bin = env.GSB_HERDR_BIN || "herdr";
  const timeoutMs = Number(env.GSB_MUX_TIMEOUT_MS || 10_000);
  function herdr(args) {
    try {
      return runTimed(bin, args, env, timeoutMs);
    } catch (error) {
      const stderr = String(error?.stderr || "").trim();
      let detail = stderr || error.message;
      try {
        const parsed = JSON.parse(stderr);
        if (parsed?.error?.code) detail = `${parsed.error.code}: ${parsed.error.message || ""}`;
      } catch { /* stderr was not herdr JSON */ }
      throw new MuxError(`herdr ${args[0]} ${args[1] || ""} failed: ${detail}`.replace(/\s+/g, " "));
    }
  }
  function herdrJson(args) { return JSON.parse(herdr(args)).result; }
  // One GSB session maps to one herdr workspace inside the default herdr
  // session; panes are scoped by their canonical GSB titles.
  const workspaceLabel = (session) => `gsb-${session}`;
  const isSessionPane = (session, pane) => {
    const title = pane.label || pane.terminal_title_stripped || "";
    return title.startsWith(`hub.${session}.`) || title.startsWith(`spk.${session}.`);
  };
  return {
    name: "herdr",
    async listPanes(session) {
      const panes = herdrJson(["pane", "list"]).panes || [];
      return panes
        .filter((pane) => isSessionPane(session, pane))
        .map((pane) => ({
          id: pane.pane_id,
          title: pane.label || pane.terminal_title_stripped || "",
          focused: Boolean(pane.focused),
          exited: false,
          isPlugin: false,
          agentStatus: pane.agent_status || "unknown",
        }));
    },
    async dumpScreen(session, paneId) {
      return herdr(["pane", "read", String(paneId), "--source", "visible", "--lines", "60", "--format", "text"]);
    },
    async sendText(session, paneId, text) {
      herdr(["pane", "send-text", String(paneId), text]);
    },
    async sendKeys(session, paneId, keys) {
      herdr(["pane", "send-keys", String(paneId), ...keys.map(herdrKey)]);
    },
    async sessionActive(session) {
      try {
        const workspaces = herdrJson(["workspace", "list"]).workspaces || [];
        return workspaces.some((workspace) => workspace.label === workspaceLabel(session));
      } catch { return false; }
    },
    attachArgv(session) { return ["session", "attach", "default"]; },
  };
}

// ---------------------------------------------------------------------------
// Session health
// ---------------------------------------------------------------------------

// A live workspace is not a live GSB session. herdr persists workspace and
// pane labels across a server restart and restores the panes on its own, but
// the processes behind them are new: plain shells or agents resumed by herdr's
// integrations, outside `supervise` and without the session contract. A GSB
// session is healthy only when every roster role has its labelled pane AND
// that role's supervise process (agent-files/<role>.supervise.pid) is alive.
//
//   complete — every role is labelled and supervised
//   partial  — some roles are, some are not (live agents worth keeping)
//   orphaned — the session is up but no role is supervised (safe to rebuild)
//   absent   — no live session

export function roleTitle(session, role) {
  return role === "hub" ? `hub.${session}.main` : `spk.${session}.${role}`;
}

export function classifySessionHealth({ session, active, titles, roles, supervised }) {
  if (!active) return { state: "absent", missing: [...roles] };
  const labelled = (role) => {
    const title = roleTitle(session, role);
    return titles.some((candidate) => candidate === title || candidate.startsWith(`${title} · `));
  };
  const missing = roles.filter((role) => !labelled(role) || !supervised.has(role));
  if (!missing.length) return { state: "complete", missing };
  return { state: missing.length === roles.length ? "orphaned" : "partial", missing };
}

export function supervisorCommandMatches(commandLine, role) {
  const match = String(commandLine).trim().match(/\/bin\/supervise\s+(\S+)$/);
  return Boolean(match) && match[1] === role;
}

function processCommandLine(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 5_000 });
  return result.status === 0 ? result.stdout : "";
}

export function supervisedRoles(stateDir, roles, commandLine = processCommandLine) {
  const supervised = new Set();
  for (const role of roles) {
    let pid;
    try {
      pid = Number.parseInt(readFileSync(path.join(stateDir, "agent-files", `${role}.supervise.pid`), "utf8"), 10);
    } catch { continue; }
    if (Number.isInteger(pid) && pid > 0 && supervisorCommandMatches(commandLine(pid), role)) supervised.add(role);
  }
  return supervised;
}

function sessionStateDir(session, env) {
  return env.GSB_STATE_DIR ||
    path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state"), "gsb-local", session);
}

function savedRoles(stateDir) {
  try {
    const roles = JSON.parse(readFileSync(path.join(stateDir, "session.json"), "utf8")).roles;
    return Array.isArray(roles) ? roles.filter((role) => typeof role === "string" && role) : [];
  } catch { return []; }
}

export async function sessionHealth(mux, session, { roles, stateDir }) {
  const active = await mux.sessionActive(session);
  const titles = active ? (await mux.listPanes(session)).filter((pane) => !pane.exited).map((pane) => pane.title) : [];
  return classifySessionHealth({
    session,
    active,
    titles,
    roles,
    supervised: active ? supervisedRoles(stateDir, roles) : new Set(),
  });
}

// ---------------------------------------------------------------------------
// Factory + CLI
// ---------------------------------------------------------------------------

export function createMux(env = process.env) {
  const name = resolveBackendName(env);
  return name === "herdr" ? createHerdr(env) : createZellij(env);
}

async function cliMain(argv, env = process.env) {
  const [op, session, paneId, ...rest] = argv;
  if (!op || !session) throw new MuxError("usage: mux.mjs <list-panes|read|send-text|send-keys|pane-exists|session-active|session-health|print-attach> <session> [pane-id] [payload...]", 2);
  const mux = createMux(envWithSessionContract(env, session));
  switch (op) {
    case "list-panes":
      console.log(JSON.stringify(await mux.listPanes(session)));
      return 0;
    case "read":
      if (!paneId) throw new MuxError("read requires a pane id", 2);
      process.stdout.write(await mux.dumpScreen(session, paneId));
      return 0;
    case "send-text":
      if (!paneId || rest.length !== 1) throw new MuxError("send-text requires exactly one text payload", 2);
      await mux.sendText(session, paneId, rest[0]);
      return 0;
    case "send-keys":
      if (!paneId || !rest.length) throw new MuxError("send-keys requires at least one key", 2);
      await mux.sendKeys(session, paneId, rest);
      return 0;
    case "pane-exists": {
      if (!paneId) throw new MuxError("pane-exists requires a pane id", 2);
      const panes = await mux.listPanes(session);
      return panes.some((pane) => pane.id === String(paneId) && !pane.exited) ? 0 : 1;
    }
    case "session-active":
      return (await mux.sessionActive(session)) ? 0 : 1;
    case "session-health": {
      // The second positional is a roles CSV here; default to the running
      // session's own roster rather than whatever config invoked us.
      const stateDir = sessionStateDir(session, env);
      const roles = paneId ? paneId.split(",").filter(Boolean) : savedRoles(stateDir);
      const health = await sessionHealth(mux, session, { roles, stateDir });
      console.log(`${health.state} ${health.missing.join(",")}`);
      return 0;
    }
    case "print-attach": {
      const argvAttach = mux.attachArgv(session);
      console.log(`${env.GSB_HERDR_BIN || (mux.name === "herdr" ? "herdr" : env.GSB_ZELLIJ_BIN || "zellij")} ${argvAttach.join(" ")}`);
      return 0;
    }
    default:
      throw new MuxError(`unknown op: ${op}`, 2);
  }
}

function selftest() {
  const zellijEnv = { GSB_MUX: "zellij", GSB_ZELLIJ_BIN: "/bin/echo", GSB_MUX_TIMEOUT_MS: "1000" };
  const zmux = createMux(zellijEnv);
  assert.equal(zmux.name, "zellij");
  const echoed = runTimed("/bin/echo", ["action", "list-panes", "--json", "--all"], zellijEnv, 1000);
  assert.match(echoed, /list-panes/);
  assert.equal(resolveBackendName({}), "zellij");
  assert.equal(resolveBackendName({ GSB_MUX: "herdr" }), "herdr");
  assert.throws(() => resolveBackendName({ GSB_MUX: "tmux" }), /unsupported GSB_MUX/);
  assert.equal(herdrKey("Enter"), "enter");
  assert.equal(herdrKey("Ctrl c"), "ctrl+c");
  assert.throws(() => herdrKey("Ctrl z"), /unsupported key/);
  const herdrEnv = { GSB_MUX: "herdr" };
  const hmux = createMux(herdrEnv);
  assert.equal(hmux.name, "herdr");
  assert.deepEqual(hmux.attachArgv("demo"), ["session", "attach", "default"]);
  const roles = ["hub", "coder", "review"];
  const titles = ["hub.demo.main", "spk.demo.coder", "spk.demo.review · busy"];
  const health = (supervised, overrides = {}) =>
    classifySessionHealth({ session: "demo", active: true, titles, roles, supervised: new Set(supervised), ...overrides });
  assert.deepEqual(health(roles), { state: "complete", missing: [] });
  assert.deepEqual(health(["hub", "coder"]), { state: "partial", missing: ["review"] });
  assert.deepEqual(health([]), { state: "orphaned", missing: roles });
  assert.deepEqual(health(roles, { titles: ["hub.demo.main"] }), { state: "partial", missing: ["coder", "review"] });
  assert.equal(health(roles, { active: false }).state, "absent");
  assert.ok(supervisorCommandMatches("bash /opt/gsb-local/bin/supervise coder\n", "coder"));
  assert.ok(!supervisorCommandMatches("bash /opt/gsb-local/bin/supervise coder", "code"));
  assert.ok(!supervisorCommandMatches("claude --resume abc", "coder"));
  console.log("mux selftest: 18 passed");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === "--selftest") selftest();
    else process.exitCode = await cliMain(process.argv.slice(2));
  } catch (error) {
    console.error(`gsb-mux: ${error.message}`);
    process.exit(error.exitCode || 1);
  }
}
