#!/usr/bin/env node

// GSB watchdog: detects in-session API errors in spoke panes and recovers them.
//
// Most API failures do not kill the agent process — the CLI prints an error and
// sits idle at its prompt. Process supervision cannot see that. Instead, every
// GSB_WATCHDOG_INTERVAL seconds this watchdog:
//
//   1. dumps each spoke pane's viewport (zellij action dump-screen)
//   2. matches the bottom non-blank lines against defaults/watchdog-patterns.conf
//   3. acts only when a match persists across consecutive polls AND the screen
//      is idle (unchanged hash) AND the pane is not focused (a human is there)
//
// Recovery order: soft (type the retry text + Enter) -> hub blocker escalation.
// Hard restart (Ctrl-c, letting bin/supervise restart the pane) is opt-in via
// GSB_WATCHDOG_HARD_RESTART=true.
//
// Logs to stdout (gsb redirects this to $GSB_STATE_DIR/watchdog.log).

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Pure helpers (also exercised by --selftest)
// ---------------------------------------------------------------------------

export function compilePatterns(file) {
  const patterns = [];
  if (!existsSync(file)) return patterns;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const source = line.trim();
    if (!source || source.startsWith("#")) continue;
    try {
      patterns.push({ source, re: new RegExp(source, "i") });
    } catch {
      console.error(`${new Date().toISOString()} watchdog: skipping invalid pattern: ${source}`);
    }
  }
  return patterns;
}

export function bottomLines(text, n) {
  const nonBlank = text.split("\n").filter((line) => line.trim() !== "");
  return nonBlank.slice(-n).join("\n");
}

export function matchError(screen, patterns, bottomN) {
  const haystack = bottomLines(screen, bottomN);
  return patterns.some(({ re }) => re.test(haystack));
}

export function spokeTitle(session, role) {
  return `spk.${session}.${role}`;
}

// Resolve live panes for the given spoke roles. Returns Map<role, pane>.
// A role with zero or multiple live panes is omitted (supervise handles exits).
export function resolveSpokePanes(panes, session, roles) {
  const resolved = new Map();
  for (const role of roles) {
    const title = spokeTitle(session, role);
    const hits = panes.filter((pane) => !pane.is_plugin && !pane.exited && pane.title === title);
    if (hits.length === 1) resolved.set(role, hits[0]);
  }
  return resolved;
}

// Decide what to do for one role this poll. Pure except for mutating the
// streak counter on `st`; all side effects happen in applyAction().
//
// obs = { hasPane, focused, idle, matched }
// Returns { action: "forget"|"guard-focus"|"reset"|"clear"|"observe"|"soft"|"hard"|"escalate" }
export function decideAction(st, obs, now, config) {
  if (!obs.hasPane) return { action: "forget" };
  if (obs.focused || st.prevFocused) return { action: "guard-focus" };
  if (!obs.idle) return { action: "reset", wasStreak: st.errorStreak > 0 };
  if (!obs.matched) return { action: "clear", wasStreak: st.errorStreak > 0 };

  st.errorStreak += 1;
  if (st.errorStreak < config.stalePolls) return { action: "observe" };
  if (now < st.escalatedUntil) return { action: "observe" };
  if (now - st.lastActionAt < config.cooldown) return { action: "observe" };

  const recentSoft = st.softTimes.filter((t) => now - t < 3600).length;
  if (!st.softPending && recentSoft < config.maxSoft) {
    return { action: "soft", retryText: config.retryText };
  }
  if (config.hardRestart) return { action: "hard" };
  return { action: "escalate", recentSoft };
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

const STATE_DIR = process.env.GSB_STATE_DIR;
const SESSION = process.env.GSB_SESSION || "seed-gsb";
const ROOT = process.env.GSB_LOCAL_ROOT;
const SPOKES = (process.env.GSB_ROLES || "hub,core-bug,ops-gov,plan-backup,ui")
  .split(",")
  .map((role) => role.trim())
  .filter((role) => role && role !== "hub");
const CONFIG = {
  interval: Number(process.env.GSB_WATCHDOG_INTERVAL || 60),
  bottomLines: Number(process.env.GSB_WATCHDOG_BOTTOM_LINES || 15),
  stalePolls: Number(process.env.GSB_WATCHDOG_STALE_POLLS || 2),
  hardRestart: process.env.GSB_WATCHDOG_HARD_RESTART === "true",
  retryText: process.env.GSB_WATCHDOG_RETRY_TEXT || "continue",
  maxSoft: Number(process.env.GSB_WATCHDOG_MAX_SOFT || 3),
  cooldown: Number(process.env.GSB_WATCHDOG_COOLDOWN || 300),
  escalateBackoff: Number(process.env.GSB_WATCHDOG_ESCALATE_BACKOFF || 900),
};
const PATTERNS_FILE =
  process.env.GSB_WATCHDOG_PATTERNS ||
  (ROOT ? path.join(ROOT, "defaults", "watchdog-patterns.conf") : "");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const log = (msg) => console.log(`${new Date().toISOString()} watchdog: ${msg}`);

function zellij(args) {
  return execFileSync("zellij", args, {
    env: { ...process.env, ZELLIJ_SESSION_NAME: SESSION },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function listPanes() {
  return JSON.parse(zellij(["action", "list-panes", "--json", "--all"]));
}

function dumpScreen(paneId) {
  return zellij(["action", "dump-screen", "--pane-id", String(paneId)]);
}

function writeChars(paneId, text) {
  zellij(["action", "write-chars", "--pane-id", String(paneId), text]);
}

function sendKeys(paneId, keys) {
  zellij(["action", "send-keys", "--pane-id", String(paneId), ...keys]);
}

function freshState() {
  return {
    prevHash: null,
    prevFocused: false,
    errorStreak: 0,
    softPending: false,
    softTimes: [],
    lastActionAt: 0,
    escalatedUntil: 0,
  };
}

const states = new Map();

function markerPath(role) {
  return path.join(STATE_DIR, "agent-files", `${role}.restart-requested`);
}

// Drop a blocker envelope directly into Hub's inbox and wake it. Hub reads
// mailbox payloads as untrusted data, so a watchdog-sourced message is safe.
function notifyHub(role, detail) {
  const ts = new Date().toISOString();
  const id = `${ts.replace(/[-:.TZ]/g, "")}-watchdog-${randomBytes(4).toString("hex")}`;
  const envelope = {
    schema: 1,
    id,
    session: SESSION,
    contract_id: `watchdog-${role}`,
    from: "watchdog",
    to: "hub",
    kind: "blocker",
    ts,
    payload: {
      question: `${role} pane shows a persistent error and automatic soft recovery failed`,
      missing: "manual intervention: inspect the pane, or rebuild the session with --rebuild",
      safe_fallback: "no_safe_fallback",
      detail,
    },
  };
  const inbox = path.join(STATE_DIR, "inbox", "hub");
  mkdirSync(inbox, { recursive: true });
  writeFileSync(path.join(inbox, `${id}.json`), `${JSON.stringify(envelope, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  try {
    execFileSync("bash", [path.join(ROOT, "bin", "nudge"), "hub"], {
      env: { ...process.env, GSB_ROLE: "" },
      stdio: "ignore",
    });
  } catch {
    // Hub pane may be gone; the durable message still waits in the inbox.
  }
}

function applyAction(role, pane, st, action, now) {
  switch (action.action) {
    case "forget":
      states.delete(role);
      return;
    case "guard-focus":
      // Currently focused: stay guarded. Was focused but isn't now: unguard
      // after this poll so the next one may act.
      st.prevFocused = Boolean(pane.is_focused);
      st.prevHash = null;
      break;
    case "reset":
      if (action.wasStreak) log(`role=${role} screen active again; error streak reset`);
      st.errorStreak = 0;
      st.softPending = false;
      st.prevFocused = false;
      break;
    case "clear":
      if (action.wasStreak) log(`role=${role} error pattern cleared`);
      st.errorStreak = 0;
      st.softPending = false;
      st.prevFocused = false;
      break;
    case "observe":
      st.prevFocused = false;
      break;
    case "soft":
      writeChars(pane.id, action.retryText);
      sendKeys(pane.id, ["Enter"]);
      st.softPending = true;
      st.softTimes.push(now);
      st.lastActionAt = now;
      st.prevFocused = false;
      log(`role=${role} soft recovery: sent "${action.retryText}" + Enter (streak=${st.errorStreak})`);
      break;
    case "hard":
      mkdirSync(path.dirname(markerPath(role)), { recursive: true });
      writeFileSync(markerPath(role), "");
      sendKeys(pane.id, ["Ctrl c", "Ctrl c"]);
      st.softPending = false;
      st.errorStreak = 0;
      st.lastActionAt = now;
      st.prevFocused = false;
      log(`role=${role} hard restart: marker set, sent Ctrl-c`);
      break;
    case "escalate":
      notifyHub(
        role,
        `persistent error pattern for ${st.errorStreak} consecutive idle polls; soft recovery exhausted (${action.recentSoft}/${CONFIG.maxSoft} this hour)`,
      );
      st.escalatedUntil = now + CONFIG.escalateBackoff;
      st.softPending = false;
      st.lastActionAt = now;
      st.prevFocused = false;
      log(`role=${role} escalated to hub after failed soft recovery (streak=${st.errorStreak})`);
      break;
  }
}

function poll(panes, patterns, now) {
  const resolved = resolveSpokePanes(panes, SESSION, SPOKES);

  for (const role of SPOKES) {
    const pane = resolved.get(role);
    const st = states.get(role) || freshState();

    let obs;
    if (!pane) {
      obs = { hasPane: false };
    } else {
      let screen;
      try {
        screen = dumpScreen(pane.id);
      } catch {
        continue;
      }
      const hash = sha256(screen);
      obs = {
        hasPane: true,
        focused: Boolean(pane.is_focused),
        idle: st.prevHash !== null && st.prevHash === hash,
        matched: matchError(screen, patterns, CONFIG.bottomLines),
      };
      st.prevHash = hash;
    }

    const action = decideAction(st, obs, now, CONFIG);
    applyAction(role, pane, st, action, now);
    if (action.action !== "forget") states.set(role, st);
  }
}

async function main() {
  if (!STATE_DIR) {
    console.error("watchdog: GSB_STATE_DIR is required");
    process.exit(2);
  }
  if (!ROOT) {
    console.error("watchdog: GSB_LOCAL_ROOT is required");
    process.exit(2);
  }
  if (!SPOKES.length) {
    log("no spoke roles configured; exiting");
    process.exit(0);
  }

  const lockDir = path.join(STATE_DIR, "watchdog.lock");
  mkdirSync(STATE_DIR, { recursive: true });
  try {
    mkdirSync(lockDir);
  } catch (error) {
    if (error.code === "EEXIST") {
      console.error("watchdog: another instance holds the lock; exiting");
      process.exit(0);
    }
    throw error;
  }
  const cleanup = () => {
    try {
      rmdirSync(lockDir);
    } catch {
      // best effort
    }
  };
  process.on("exit", cleanup);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      cleanup();
      process.exit(0);
    });
  }

  const patterns = compilePatterns(PATTERNS_FILE);
  log(
    `started session=${SESSION} interval=${CONFIG.interval}s bottom=${CONFIG.bottomLines} ` +
      `stale=${CONFIG.stalePolls} soft_max=${CONFIG.maxSoft}/h cooldown=${CONFIG.cooldown}s ` +
      `hard_restart=${CONFIG.hardRestart} patterns=${patterns.length}`,
  );

  let sessionFailures = 0;
  for (;;) {
    let panes;
    try {
      panes = listPanes();
      sessionFailures = 0;
    } catch (error) {
      sessionFailures += 1;
      if (sessionFailures >= 3) {
        log(`zellij session unavailable after ${sessionFailures} attempts; exiting (${error.message})`);
        process.exit(0);
      }
      await sleep(CONFIG.interval * 1000);
      continue;
    }

    try {
      poll(panes, patterns, Date.now() / 1000);
    } catch (error) {
      log(`poll error: ${error.stack || error.message}`);
    }
    await sleep(CONFIG.interval * 1000);
  }
}

// ---------------------------------------------------------------------------
// Self-test: node bin/watchdog.mjs --selftest
// ---------------------------------------------------------------------------

function runSelfTest() {
  let failed = 0;
  const test = (name, condition) => {
    if (condition) {
      console.log(`ok: ${name}`);
    } else {
      failed += 1;
      console.error(`FAIL: ${name}`);
    }
  };

  const patternFile = path.join(tmpdir(), `gsb-wd-patterns-${process.pid}.conf`);
  writeFileSync(patternFile, "# comment\n\nAPI Error\nbad(regex\n\\b429\\b\nrate.?limit\n");
  const patterns = compilePatterns(patternFile);
  test("compilePatterns keeps valid lines, skips comments/blanks/invalid", patterns.length === 3);

  test("bottomLines takes last non-blank lines", bottomLines("a\n\nb\n \n\nc\nd", 2) === "c\nd");
  test("bottomLines handles short input", bottomLines("a\nb", 5) === "a\nb");

  test("matchError hits on error text", matchError("working...\nAPI Error: 429 rate limit hit", patterns, 15));
  test(
    "matchError ignores error text above the bottom window",
    matchError(`API Error\n${"scroll\n".repeat(40)}`, patterns, 5) === false,
  );
  test("matchError passes on clean screen", matchError("analyzing repo\ntests passing", patterns, 15) === false);

  test("spokeTitle format", spokeTitle("s1", "core-bug") === "spk.s1.core-bug");

  const panes = [
    { id: "terminal_1", title: "spk.s1.core-bug", is_plugin: false, exited: false, is_focused: false },
    { id: "terminal_2", title: "hub.s1.main", is_plugin: false, exited: false, is_focused: true },
    { id: "terminal_3", title: "spk.s1.core-bug", is_plugin: false, exited: true, is_focused: false },
    { id: "plugin_1", title: "spk.s1.ui", is_plugin: true, exited: false, is_focused: false },
    { id: "terminal_4", title: "spk.s1.ui", is_plugin: false, exited: false, is_focused: false },
  ];
  const resolved = resolveSpokePanes(panes, "s1", ["core-bug", "ui", "ops-gov"]);
  test("resolveSpokePanes picks the live pane", resolved.get("core-bug")?.id === "terminal_1");
  test("resolveSpokePanes resolves other roles", resolved.get("ui")?.id === "terminal_4");
  test("resolveSpokePanes omits roles without a pane", resolved.has("ops-gov") === false);

  // decideAction state machine.
  const cfg = { stalePolls: 2, cooldown: 300, maxSoft: 3, hardRestart: false, retryText: "continue" };
  const t0 = 1_000_000;
  let st = freshState();

  test("missing pane -> forget", decideAction(st, { hasPane: false }, t0, cfg).action === "forget");

  // First sight: no prevHash -> not idle -> reset.
  test("first sight resets", decideAction(st, { hasPane: true, focused: false, idle: false, matched: true }, t0, cfg).action === "reset");

  // Idle + matched: streak builds; action at streak == stalePolls.
  st = freshState();
  st.prevHash = "h1";
  test("streak 1 observes", decideAction(st, { hasPane: true, focused: false, idle: true, matched: true }, t0, cfg).action === "observe");
  test("streak 1 recorded", st.errorStreak === 1);
  const soft = decideAction(st, { hasPane: true, focused: false, idle: true, matched: true }, t0 + 1, cfg);
  test("streak 2 triggers soft recovery", soft.action === "soft" && soft.retryText === "continue");
  st.softPending = true;
  st.softTimes.push(t0 + 1);
  st.lastActionAt = t0 + 1;

  // Still broken after soft, within cooldown -> observe.
  test("cooldown blocks re-action", decideAction(st, { hasPane: true, focused: false, idle: true, matched: true }, t0 + 2, cfg).action === "observe");
  // After cooldown, soft already pending -> escalate.
  const esc = decideAction(st, { hasPane: true, focused: false, idle: true, matched: true }, t0 + 400, cfg);
  test("soft exhausted -> escalate", esc.action === "escalate");
  st.escalatedUntil = t0 + 400 + 900;
  test("escalation backoff blocks", decideAction(st, { hasPane: true, focused: false, idle: true, matched: true }, t0 + 500, cfg).action === "observe");

  // Screen changing mid-streak resets.
  st = freshState();
  st.prevHash = "h1";
  st.errorStreak = 2;
  const resetAct = decideAction(st, { hasPane: true, focused: false, idle: false, matched: true }, t0, cfg);
  test("active screen resets streak", resetAct.action === "reset" && resetAct.wasStreak === true);

  // Focus guard: focused now, then one poll of unfocused grace, then free.
  st = freshState();
  st.prevHash = "h1";
  test("focused pane guarded", decideAction(st, { hasPane: true, focused: true, idle: true, matched: true }, t0, cfg).action === "guard-focus");
  st.prevFocused = true;
  test("recently-focused pane still guarded", decideAction(st, { hasPane: true, focused: false, idle: true, matched: true }, t0, cfg).action === "guard-focus");
  st.prevFocused = false;
  test("unfocused pane eligible", decideAction(st, { hasPane: true, focused: false, idle: true, matched: true }, t0, cfg).action === "observe");

  // Hard restart opt-in: still soft-first, then hard once soft is spent.
  st = freshState();
  st.prevHash = "h1";
  const hardCfg = { ...cfg, hardRestart: true };
  decideAction(st, { hasPane: true, focused: false, idle: true, matched: true }, t0, hardCfg);
  const hardSoft = decideAction(st, { hasPane: true, focused: false, idle: true, matched: true }, t0 + 1, hardCfg);
  test("hard restart still tries soft first", hardSoft.action === "soft");
  st.softPending = true;
  st.softTimes.push(t0 + 1);
  st.lastActionAt = t0 + 1;
  const hard = decideAction(st, { hasPane: true, focused: false, idle: true, matched: true }, t0 + 400, hardCfg);
  test("hard restart after soft failed", hard.action === "hard");

  // maxSoft cap: after maxSoft soft attempts in an hour, escalate.
  st = freshState();
  st.prevHash = "h1";
  st.softTimes = [t0 - 10, t0 - 20, t0 - 30];
  decideAction(st, { hasPane: true, focused: false, idle: true, matched: true }, t0, cfg);
  const capped = decideAction(st, { hasPane: true, focused: false, idle: true, matched: true }, t0 + 1, cfg);
  test("maxSoft cap escalates", capped.action === "escalate");

  if (failed) {
    console.error(`\n${failed} self-test(s) failed`);
    process.exit(1);
  }
  console.log("\nall self-tests passed");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain && process.argv[2] === "--selftest") {
  runSelfTest();
} else if (isMain) {
  await main();
}
