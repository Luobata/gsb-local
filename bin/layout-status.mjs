#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { runZellijTimed } from "./zellij-timed.mjs";

const baseTitle = (session, role) => role === "hub" ? `hub.${session}.main` : `spk.${session}.${role}`;
const titleMatches = (title, base) => title === base || title.startsWith(`${base} · `);

export function parseRoster(text) {
  const roles = [...text.matchAll(/^- ([a-z][a-z0-9-]*):/gm)].map((match) => match[1]);
  if (!roles.includes("hub") || new Set(roles).size !== roles.length) throw new Error("invalid active role roster");
  return roles;
}

export function parseLayout(text) {
  const active = text.split(/\n\s*new_tab_template\s*\{/)[0];
  const names = [];
  for (const match of active.matchAll(/\bpane\b[^\n{]*\bname=("(?:\\.|[^"\\])*")/g)) {
    try { names.push(JSON.parse(match[1])); } catch { /* Ignore unrelated malformed KDL strings. */ }
  }
  return { names, verticalSplits: (active.match(/\bsplit_direction="vertical"/g) || []).length };
}

export function analyzeWatchdogHeartbeat(pidText, heartbeatText, nowMs, staleMs = 150_000) {
  const pidMatch = String(pidText || "").trim().match(/^\d+$/);
  const pid = pidMatch ? Number(pidMatch[0]) : null;
  if (!Number.isSafeInteger(pid) || pid <= 0) return { status: "no-pid", pid: null, ageMs: null };
  const heartbeat = String(heartbeatText || "").trim().match(/^(\d+) (\d+) (\d+)$/);
  if (!heartbeat || Number(heartbeat[1]) !== pid) return { status: "stale", pid, ageMs: null };
  const ageMs = Math.max(0, nowMs - Number(heartbeat[2]) * 1000);
  return { status: ageMs < staleMs ? "healthy" : "stale", pid, ageMs };
}

export function formatWatchdogHeartbeat(health) {
  const age = health.ageMs === null ? "missing" : `${Math.floor(health.ageMs / 1000)}s`;
  return `watchdog: ${health.status} pid=${health.pid ?? "none"} heartbeat_age=${age}`;
}

function paneRole(pane, session, roles) {
  const titled = roles.find((role) => titleMatches(pane.title || "", baseTitle(session, role)));
  if (titled) return { role: titled, titleOk: true };
  const command = pane.terminal_command || "";
  if (!command.includes("supervise")) return { role: null, titleOk: false };
  const role = roles.find((candidate) => new RegExp(`(?:^|[\\s'"])${candidate}(?:$|[\\s'"])`).test(command));
  return { role: role || null, titleOk: false };
}

export function analyzeLayout(panes, layout, session, roles) {
  const terminals = panes.filter((pane) => !pane.is_plugin);
  const hubs = terminals.filter((pane) => titleMatches(pane.title || "", baseTitle(session, "hub")));
  const hub = [...hubs].sort((a, b) => a.id - b.id)[0];
  const hubX = hub?.pane_x ?? Math.min(...terminals.map((pane) => pane.pane_x));
  const spokeX = hub ? hub.pane_x + hub.pane_columns : Math.min(...terminals.filter((pane) => pane.pane_x !== hubX).map((pane) => pane.pane_x));
  const extras = [];
  const broken = [];
  const rows = roles.map((role) => {
    const base = baseTitle(session, role);
    const matches = terminals.filter((pane) => titleMatches(pane.title || "", base));
    const expectedX = role === "hub" ? hubX : spokeX;
    const ordered = [...matches].sort((a, b) => (a.pane_x === expectedX ? -1 : 1) - (b.pane_x === expectedX ? -1 : 1) || a.id - b.id);
    for (const pane of ordered.slice(1)) extras.push({ pane, role, expectedX });
    return {
      role,
      live: matches.filter((pane) => !pane.exited),
      exited: matches.filter((pane) => pane.exited),
      expectedX,
      positionDrift: ordered[0] && Number.isFinite(expectedX) && ordered[0].pane_x !== expectedX ? ordered[0] : null,
    };
  });
  for (const pane of terminals) {
    const match = paneRole(pane, session, roles);
    if (match.role && !match.titleOk) broken.push({ pane, role: match.role });
    else if (!match.role) extras.push({ pane, role: null, expectedX: null });
  }
  const layoutMissing = roles.filter((role) => !layout.names.some((title) => titleMatches(title, baseTitle(session, role))));
  return {
    rows,
    extras,
    broken,
    layoutMissing,
    verticalDrift: layout.verticalSplits !== (roles.length > 1 ? 1 : 0),
    expectedVerticalSplits: roles.length > 1 ? 1 : 0,
  };
}

function ids(panes) {
  return panes.length ? `[${panes.map((pane) => pane.id).join(",")}]` : "[]";
}

function printReport(result, layout, session, roles, watchdogHealth) {
  console.log(`Layout status: session=${session} roles=${roles.join(",")}`);
  console.log(formatWatchdogHeartbeat(watchdogHealth));
  for (const row of result.rows) console.log(`role ${row.role}: live=${row.live.length} ${ids(row.live)} exited=${row.exited.length} ${ids(row.exited)}`);
  const missing = result.rows.filter((row) => !row.live.length).map((row) => row.role);
  console.log(`missing live roles: ${missing.length ? missing.join(", ") : "none"}`);
  const exited = result.rows.flatMap((row) => row.exited.map((pane) => `pane ${pane.id} (${row.role})`));
  console.log(`exited placeholders: ${exited.length ? exited.join(", ") : "none"}`);
  const shifted = result.rows.filter((row) => row.positionDrift);
  if (result.extras.length || shifted.length) {
    console.log("extra panes / layout drift:");
    for (const { pane, role, expectedX } of result.extras) {
      const column = Number.isFinite(expectedX) && pane.pane_x !== expectedX ? `; expected x=${expectedX}, got x=${pane.pane_x}` : "";
      console.log(`  pane ${pane.id} (${role || "unknown"}) title=${JSON.stringify(pane.title)}${column}`);
    }
    for (const row of shifted) console.log(`  pane ${row.positionDrift.id} (${row.role}); expected x=${row.expectedX}, got x=${row.positionDrift.pane_x}`);
  } else console.log("extra panes / layout drift: none");
  if (result.broken.length) {
    console.log(`broken titles: ${result.broken.map(({ pane, role }) => `pane ${pane.id} (${role}) ${JSON.stringify(pane.title)}`).join(", ")}`);
  } else console.log("broken titles: none");
  console.log(`dump-layout vertical splits: ${layout.verticalSplits} (expected ${result.expectedVerticalSplits})`);
  if (result.layoutMissing.length) console.log(`dump-layout missing titles: ${result.layoutMissing.join(", ")}`);
  const drift = missing.length || exited.length || result.extras.length || result.broken.length || result.layoutMissing.length || result.verticalDrift || result.rows.some((row) => row.positionDrift);
  console.log(`result: ${drift ? "DRIFT" : "CANONICAL"} (diagnostic only; no changes made)`);
}

function selftest() {
  const roles = parseRoster("- hub: `agent`\n- coder: `agent`\n- audit: `agent`\n");
  const cleanKdl = 'layout {\n tab {\n  pane split_direction="vertical" {\n   pane name="hub.demo.main · h" {}\n   pane { pane name="spk.demo.coder · c" {} pane name="spk.demo.audit · a" {} }\n  }\n }\n}\nnew_tab_template {';
  const layout = parseLayout(cleanKdl);
  const panes = [
    { id: 0, title: "hub.demo.main · h", pane_x: 0, pane_columns: 50, exited: false },
    { id: 1, title: "spk.demo.coder · c", pane_x: 50, pane_columns: 50, exited: false },
    { id: 2, title: "spk.demo.audit · a", pane_x: 50, pane_columns: 50, exited: false },
  ];
  const clean = analyzeLayout(panes, layout, "demo", roles);
  assert.deepEqual(roles, ["hub", "coder", "audit"]);
  assert.equal(layout.names.length, 3);
  assert.equal(layout.verticalSplits, 1);
  assert.equal(clean.extras.length + clean.broken.length + clean.layoutMissing.length, 0);
  const drift = analyzeLayout([
    panes[0], { ...panes[1], exited: true }, { ...panes[1], id: 12, pane_x: 75 },
    { ...panes[2], title: "audit", terminal_command: "supervise 'audit'" },
  ], { ...layout, verticalSplits: 2 }, "demo", roles);
  assert.deepEqual(drift.rows.find((row) => row.role === "coder").live.map((pane) => pane.id), [12]);
  assert.deepEqual(drift.rows.find((row) => row.role === "coder").exited.map((pane) => pane.id), [1]);
  assert.equal(drift.extras[0].pane.id, 12);
  assert.equal(drift.broken[0].role, "audit");
  assert.deepEqual(analyzeWatchdogHeartbeat("42\n", "42 1000 3\n", 1_010_000), { status: "healthy", pid: 42, ageMs: 10_000 });
  assert.equal(analyzeWatchdogHeartbeat("42", "42 1000 3", 1_200_000).status, "stale");
  assert.equal(formatWatchdogHeartbeat(analyzeWatchdogHeartbeat("", "", 1_000_000)), "watchdog: no-pid pid=none heartbeat_age=missing");
  console.log("layout-status selftest: 11 passed");
}

function isMainModule(entry) {
  const source = fileURLToPath(import.meta.url);
  try { return realpathSync(entry) === realpathSync(source); } catch { return entry === source; }
}

if (isMainModule(process.argv[1])) {
  if (process.argv[2] === "--selftest") selftest();
  else {
    const session = process.argv[2] || process.env.GSB_SESSION || process.env.ZELLIJ_SESSION_NAME || "seed-gsb";
    if (!/^[A-Za-z0-9._-]+$/.test(session) || process.argv[3]) throw new Error("usage: layout-status.mjs [session]");
    const stateDir = process.env.GSB_STATE_DIR || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state"), "gsb-local", session);
    const roles = parseRoster(readFileSync(process.env.GSB_ROLE_ROSTER || path.join(stateDir, "ROLES.md"), "utf8"));
    const env = { ...process.env, ZELLIJ_SESSION_NAME: session };
    const timeout = Number(process.env.GSB_LAYOUT_STATUS_TIMEOUT_MS || 10_000);
    const readState = (name) => { try { return readFileSync(path.join(stateDir, name), "utf8"); } catch { return ""; } };
    const watchdogHealth = analyzeWatchdogHeartbeat(
      readState("watchdog.pid"),
      readState("watchdog.heartbeat"),
      Date.now(),
      Number(process.env.GSB_WATCHDOG_HEARTBEAT_STALE_MS || 150_000),
    );
    const layout = parseLayout(runZellijTimed(["action", "dump-layout"], timeout, { env }));
    const panes = JSON.parse(runZellijTimed(["action", "list-panes", "--json", "--all"], timeout, { env }));
    printReport(analyzeLayout(panes, layout, session, roles), layout, session, roles, watchdogHealth);
  }
}
