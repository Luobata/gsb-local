import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  commandCacheFile,
  createRuntimeValidator,
  createStudioServer,
  defaultZellijSocketDir,
  gsbSocketDir,
  launchWorkbench,
  invalidateSessionCache,
  listSessions,
  loadProjectState,
  mergeSessionLines,
  openTerminalSession,
  parseArgs,
  parseProfileHeader,
  parseRoleMap,
  serializeAgents,
  serializeModels,
  sessionSocketLabel,
  sessionState,
  studioLaunchEnv,
  validateWorkbench,
  zellijSocketPathInfo,
} from "./server.mjs";
import { listStoredProjects, projectDir, PROMPT_INTENT_MARKER, saveProjectState } from "./store.mjs";
import { runZellijTimed } from "../bin/zellij-timed.mjs";

const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function testEnv(overrides = {}) {
  return {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: process.env.HOME || os.homedir(),
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    ...overrides,
  };
}

function fixture(workspace) {
  return {
    version: 1,
    name: "Studio test",
    profile: "custom",
    workspace,
    session: "studio-test",
    permission: "balanced",
    watchdog: true,
    rebuild: false,
    roles: [
      {
        id: "hub",
        name: "Hub",
        type: "orchestrator",
        description: "thin hub",
        agent: "shell:printf hub",
        model: "glm-test",
        promptTemplate: "hub",
        prompt: "Coordinate only.",
      },
      {
        id: "coder",
        name: "Coder",
        type: "executor",
        description: "implementation",
        agent: "shell:printf coder",
        model: "codex-test",
        promptTemplate: "coder",
        prompt: "Implement only assigned paths.",
      },
    ],
  };
}

function fakeRuntimeValidator(spawnSyncImpl, options = {}) {
  return createRuntimeValidator({
    spawnSyncImpl,
    now: options.now || Date.now,
    env: { GSB_STUDIO_VALIDATE_SYNC: "1", ...(options.env || {}) },
    hasZsh: options.hasZsh ?? true,
    listSessionOptionsImpl: () => [],
    cacheFile: false,
  });
}

function interactiveOutput(...available) {
  return available.map((value) => `__GSB_STUDIO_COMMAND__${value ? 1 : 0}`).join("\n") + "\n";
}

function asyncSpawnStub(handler) {
  return (command, args, options) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,
    });
    const result = handler(command, args, options) || {};
    setTimeout(() => {
      if (result.stdout) child.stdout.write(result.stdout);
      if (result.stderr) child.stderr.write(result.stderr);
      if (result.error) child.emit("error", result.error);
      else child.emit("close", result.status ?? 0, result.signal ?? null);
    }, result.delay || 0);
    return child;
  };
}

test("Studio accepts an omitted project and still validates explicit project arguments", () => {
  assert.equal(parseArgs([]).project, "");
  assert.equal(parseArgs(["--project", ".", "--no-open"]).project, ROOT_DIR);
  assert.throws(() => parseArgs(["--project"]), /--project requires a path/);
});

test("terminal opening validates sessions and has a portable command fallback", () => {
  assert.throws(() => openTerminalSession("unsafe;session", { platform: "linux" }), /会话名只能包含/);
  assert.deepEqual(openTerminalSession("safe-session", { platform: "linux" }), {
    command: "gsb-local open safe-session",
    opened: false,
  });

  const calls = [];
  let unrefCalled = false;
  const result = openTerminalSession("safe-session", {
    platform: "darwin",
    spawnImpl(command, args, options) {
      calls.push({ command, args, options });
      return { unref() { unrefCalled = true; } };
    },
  });
  assert.deepEqual(result, { command: "gsb-local open safe-session", opened: true });
  assert.deepEqual(calls, [{
    command: "osascript",
    args: ["-e", 'tell application "Terminal" to do script "gsb-local open safe-session"'],
    options: { detached: true, stdio: "ignore" },
  }]);
  assert.equal(unrefCalled, true);
});

test("Studio launches with pane-scoped GSB and Zellij variables removed", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "gsb-studio-launch-env-"));
  let spawned;
  let invalidations = 0;
  try {
    const result = await launchWorkbench(fixture(workspace), {
      sourceEnv: {
        PATH: "/usr/bin:/bin",
        GSB_STATE_DIR: "/wrong/session",
        GSB_SESSION: "caller-session",
        GSB_SOCKET_DIR_OVERRIDE: "/wrong/socket",
        ZELLIJ_SESSION_NAME: "caller-session",
        ZELLIJ_SOCKET_DIR: "/wrong/socket",
      },
      activeSessionLineImpl: () => null,
      spawnSyncImpl(command, args, options) {
        spawned = { command, args, options };
        return { status: 0, stdout: "created\n", stderr: "" };
      },
      invalidateSessionCacheImpl: () => { invalidations += 1; },
    });
    assert.equal(result.launched, true);
    assert.equal(invalidations, 1);
    assert.equal(spawned.options.env.PATH, "/usr/bin:/bin");
    assert.equal(spawned.options.env.GSB_WATCHDOG_ENABLED, "true");
    for (const name of ["GSB_STATE_DIR", "GSB_SESSION", "GSB_SOCKET_DIR_OVERRIDE", "ZELLIJ_SESSION_NAME", "ZELLIJ_SOCKET_DIR"]) {
      assert.equal(name in spawned.options.env, false, name);
    }
    assert.equal(existsSync(path.join(workspace, ".gsb-local", "agents.conf")), true);
    assert.equal(existsSync(path.join(workspace, ".gsb-local", "workbench.json")), true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("Studio launch passthrough rollback preserves inherited variables", () => {
  const env = studioLaunchEnv({
    GSB_STUDIO_ENV_PASSTHROUGH: "1",
    GSB_STATE_DIR: "/legacy/state",
    ZELLIJ_SESSION_NAME: "legacy-session",
  }, false);
  assert.equal(env.GSB_STATE_DIR, "/legacy/state");
  assert.equal(env.ZELLIJ_SESSION_NAME, "legacy-session");
  assert.equal(env.GSB_WATCHDOG_ENABLED, "false");
});

test("socket directory and 103-byte boundary calculations are stable", () => {
  assert.equal(gsbSocketDir({ env: {}, home: "/Users/test" }), "/Users/test/.cache/gsb-zsock");
  assert.equal(gsbSocketDir({ env: { XDG_CACHE_HOME: "/cache" }, home: "/ignored" }), "/cache/gsb-zsock");
  assert.equal(gsbSocketDir({ env: { GSB_SOCKET_DIR_OVERRIDE: "/override" } }), "/override");
  assert.equal(defaultZellijSocketDir({ env: { TMPDIR: "/tmp/root/" }, uid: 501 }), "/tmp/root/zellij-501");
  assert.equal(zellijSocketPathInfo("/tmp/gsb-501", "x".repeat(44)).length, 76);
  assert.deepEqual(
    [zellijSocketPathInfo("/tmp/gsb-501", "x".repeat(71)).valid, zellijSocketPathInfo("/tmp/gsb-501", "x".repeat(72)).valid],
    [true, false],
  );
});

test("session merging preserves the winning socket and cross-socket EXITED evidence", () => {
  const dirs = ["/cache/gsb-zsock", "/tmp/zellij-501"];
  const merged = mergeSessionLines([
    ["shared [Created now] (EXITED - attach to resurrect)", "dead [Created before] (EXITED - attach to resurrect)"],
    ["shared [Created now]", "legacy [Created now]"],
  ], dirs);
  assert.deepEqual(merged.lines, [
    "shared [Created now]",
    "dead [Created before] (EXITED - attach to resurrect)",
    "legacy [Created now]",
  ]);
  assert.deepEqual(merged.byName.get("shared"), {
    line: "shared [Created now]",
    socketDir: "/tmp/zellij-501",
    crossSocketExited: true,
    exitedEverywhere: false,
  });
  assert.equal(merged.byName.get("dead").exitedEverywhere, true);
});

test("session provenance labels attachable live sessions and hides behind its rollback switch", () => {
  const options = { env: { TMPDIR: "/tmp" }, home: "/Users/test", uid: 501 };
  assert.equal(sessionSocketLabel("/Users/test/.cache/gsb-zsock", options), "统一目录 (~/.cache/gsb-zsock)");
  assert.equal(sessionSocketLabel("/tmp/zellij-501", options), "默认目录 (/tmp/zellij-501)");
  assert.equal(sessionSocketLabel("/custom/socket", options), "/custom/socket");

  const provenance = { socketDir: "/tmp/zellij-501", crossSocketExited: true };
  const running = sessionState("shared", "/missing", "shared [Created now]", provenance, options);
  assert.equal(running.socketDir, "/tmp/zellij-501");
  assert.equal(running.socketLabel, "默认目录 (/tmp/zellij-501)");
  assert.equal(running.crossSocketExited, true);
  assert.equal(running.attachHint, "ZELLIJ_SOCKET_DIR=/tmp/zellij-501 zellij attach shared");

  const exited = sessionState("dead", "/missing", "dead (EXITED - attach to resurrect)", {
    socketDir: "/Users/test/.cache/gsb-zsock",
    crossSocketExited: false,
  }, options);
  assert.equal(exited.status, "exited");
  assert.equal(exited.attachHint, null);

  const hidden = sessionState("shared", "/missing", "shared [Created now]", provenance, {
    ...options,
    env: { ...options.env, GSB_STUDIO_SESSION_PROVENANCE: "false" },
  });
  for (const field of ["socketDir", "socketLabel", "attachHint", "crossSocketExited"]) {
    assert.equal(field in hidden, false, field);
  }
});

test("timed Zellij wrapper forwards bounded execution options", () => {
  let call;
  const stdout = runZellijTimed(["action", "list-panes"], 321, {
    env: { GSB_ZELLIJ_BIN: "/fake/zellij" },
    execImpl(command, args, options) {
      call = { command, args, options };
      return "[]\n";
    },
  });
  assert.equal(stdout, "[]\n");
  assert.equal(call.command, "/fake/zellij");
  assert.deepEqual(call.args, ["action", "list-panes"]);
  assert.equal(call.options.timeout, 321);
  assert.equal(call.options.killSignal, "SIGKILL");
});

test("Studio merges unified and default Zellij session views", async () => {
  const calls = [];
  const sessions = await listSessions({
    env: { PATH: "/usr/bin:/bin", TMPDIR: "/tmp", GSB_STUDIO_VALIDATE_SYNC: "1" },
    home: "/Users/test",
    uid: 501,
    socketDirs: ["/Users/test/.cache/gsb-zsock", "/tmp/zellij-501"],
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      return options.env.ZELLIJ_SOCKET_DIR
        ? { stdout: "shared [Created now] (EXITED - attach to resurrect)\nunified [Created now]\n" }
        : { stdout: "shared [Created now]\nlegacy [Created now]\n" };
    },
  });
  assert.equal(calls.length, 2);
  assert.ok(sessions.includes("shared [Created now]"));
  assert.ok(sessions.some((line) => line.startsWith("unified ")));
  assert.ok(sessions.some((line) => line.startsWith("legacy ")));
});

test("role maps and generated configuration round-trip", () => {
  assert.deepEqual(parseRoleMap("# comment\nhub=claude-glm-5.3\ncore_bug=codex\n"), [
    { id: "hub", value: "claude-glm-5.3" },
    { id: "core-bug", value: "codex" },
  ]);
  const workbench = fixture("/tmp");
  assert.match(serializeAgents(workbench), /hub=shell:printf hub/);
  assert.match(serializeModels(workbench), /coder=codex-test/);
});

test("profile labels come from conf headers and fall back to the profile id", () => {
  assert.deepEqual(parseProfileHeader("# label: Friendly Profile\n# Operational description\nhub=codex\n", "config-x"), {
    name: "Friendly Profile",
    description: "Operational description",
  });
  assert.deepEqual(parseProfileHeader("# Operational description\nhub=codex\n", "config-x"), {
    name: "config-x",
    description: "Operational description",
  });
});

test("the default role map is sourced from config1 without changing its CLI path", () => {
  const defaults = path.join(ROOT_DIR, "defaults", "agents.conf");
  const config1 = path.join(ROOT_DIR, "profiles", "config1.conf");
  assert.equal(lstatSync(defaults).isSymbolicLink(), true);
  assert.equal(realpathSync(defaults), realpathSync(config1));
  assert.deepEqual(parseRoleMap(readFileSync(defaults, "utf8")), parseRoleMap(readFileSync(config1, "utf8")));
});

test("pane GSB decisions classify every direct environment fallback", () => {
  const source = readFileSync(path.join(ROOT_DIR, "gsb"), "utf8");
  const expectedStripped = new Set(`
    GSB_LOCAL_ROOT GSB_WORKSPACE GSB_SESSION GSB_AGENT GSB_STATE_DIR
    GSB_PROJECT_DIR GSB_PROMPTS_DIR GSB_PROFILES_DIR
    GSB_CONFIG_PATH GSB_MODELS_CONFIG_PATH GSB_CONFIG_SOURCE GSB_CONFIG_PROFILE
    GSB_PROTOCOL_FILE GSB_ROLE_ROSTER GSB_LAYOUT_FILE GSB_SESSION_ENV_FILE
    GSB_SESSION_METADATA_FILE GSB_ROLES GSB_WATCHDOG_ENABLED GSB_FULL_ACCESS
    GSB_PERMISSION_PROFILE GSB_PERMISSION_MODE GSB_CODEX_APPROVAL
    GSB_CODEX_SANDBOX GSB_KIMI_PERMISSION
  `.trim().split(/\s+/));
  const preserved = new Set(`
    GSB_MODEL GSB_EFFORT GSB_KIMI_MODEL GSB_KIMI_HOST_CWD GSB_CONFIG
    GSB_MODELS_CONFIG GSB_SOCKET_DIR_OVERRIDE
  `.trim().split(/\s+/));
  const denylistBlock = source.match(/PANE_RUNTIME_VARS=\(\n([\s\S]*?)\n\)/);
  assert.ok(denylistBlock, "pane runtime denylist must remain explicit");
  const actualStripped = new Set(denylistBlock[1].match(/GSB_[A-Z0-9_]+/g) || []);
  assert.deepEqual([...actualStripped].sort(), [...expectedStripped].sort());
  assert.deepEqual([...actualStripped].filter((name) => preserved.has(name)), []);

  const reads = [...source.matchAll(/\$\{(GSB_[A-Z0-9_]+):-/g)].map((match) => match[1]);
  const unclassified = [...new Set(reads.filter((name) => !actualStripped.has(name) && !preserved.has(name)))];
  assert.deepEqual(unclassified, []);
  for (const name of ["GSB_STATE_DIR", "GSB_AGENT", "GSB_WATCHDOG_ENABLED"]) assert.ok(actualStripped.has(name));
});

test("nudge isolates session.env and extracts only its Zellij socket", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "gsb-nudge-env-"));
  const stateHome = path.join(root, "state");
  const sessionState = path.join(stateHome, "gsb-local", "isolated");
  const fakeBin = path.join(root, "bin");
  const seenEnv = path.join(root, "seen-env");
  try {
    mkdirSync(sessionState, { recursive: true });
    mkdirSync(fakeBin);
    writeFileSync(path.join(sessionState, "session.env"), [
      "export ZELLIJ_SOCKET_DIR=/session/socket",
      "export GSB_ROLES=rogue",
      "export GSB_ROLE=rogue",
      "",
    ].join("\n"));
    const fakeZellij = path.join(fakeBin, "zellij");
    writeFileSync(fakeZellij, [
      "#!/usr/bin/env bash",
      "printf '%s' \"$GSB_ROLES|$GSB_ROLE|$ZELLIJ_SOCKET_DIR\" > " + JSON.stringify(seenEnv),
      "printf '%s\n' '[{\"id\":\"terminal_1\",\"title\":\"hub.isolated.main\",\"is_plugin\":false,\"exited\":false}]'",
      "",
    ].join("\n"));
    chmodSync(fakeZellij, 0o755);
    const result = spawnSync(path.join(ROOT_DIR, "bin", "nudge"), ["hub", "--dry-run"], {
      encoding: "utf8",
      env: testEnv({
        PATH: fakeBin + ":" + (process.env.PATH || "/usr/bin:/bin"),
        XDG_STATE_HOME: stateHome,
        GSB_SESSION: "isolated",
        GSB_ROLES: "hub",
        GSB_ROLE: "external",
      }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /session=isolated role=hub pane_id=terminal_1/);
    assert.equal(readFileSync(seenEnv, "utf8"), "hub|external|/session/socket");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("nudge bounds a hung default-socket lookup and falls back to the unified directory", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "gsb-nudge-timeout-"));
  const fakeBin = path.join(root, "bin");
  const seenSockets = path.join(root, "seen-sockets");
  try {
    mkdirSync(fakeBin);
    const fakeZellij = path.join(fakeBin, "zellij");
    writeFileSync(fakeZellij, [
      "#!/usr/bin/env bash",
      "printf '%s\\n' \"${ZELLIJ_SOCKET_DIR:-<default>}\" >> \"$GSB_TEST_SEEN_SOCKETS\"",
      "if [[ -z \"${ZELLIJ_SOCKET_DIR:-}\" ]]; then exec sleep 100; fi",
      "printf '%s\\n' '[{\"id\":\"terminal_7\",\"title\":\"hub.legacy.main\",\"is_plugin\":false,\"exited\":false}]'",
      "",
    ].join("\n"));
    chmodSync(fakeZellij, 0o755);
    const cacheHome = path.join(root, "cache");
    const started = Date.now();
    const result = spawnSync(path.join(ROOT_DIR, "bin", "nudge"), ["hub", "--dry-run"], {
      encoding: "utf8",
      timeout: 5_000,
      env: testEnv({
        PATH: fakeBin + ":" + (process.env.PATH || "/usr/bin:/bin"),
        XDG_CACHE_HOME: cacheHome,
        XDG_STATE_HOME: path.join(root, "state"),
        GSB_SESSION: "legacy",
        GSB_ROLES: "hub",
        GSB_ROLE: "external",
        GSB_NUDGE_RESOLVE_TIMEOUT_MS: "2000",
        GSB_TEST_SEEN_SOCKETS: seenSockets,
      }),
    });
    const elapsed = Date.now() - started;
    assert.equal(result.status, 0, result.stderr);
    assert.ok(elapsed >= 1_800, `nudge returned before the 2000ms timeout: ${elapsed}ms`);
    assert.ok(elapsed < 4_500, `nudge took ${elapsed}ms`);
    assert.match(result.stdout, /session=legacy role=hub pane_id=terminal_7/);
    assert.equal(readFileSync(seenSockets, "utf8").trim().split("\n").at(-1), path.join(cacheHome, "gsb-zsock"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Studio frontend renders provenance only when structured fields are present", () => {
  const app = readFileSync(path.join(ROOT_DIR, "studio", "public", "app.js"), "utf8");
  const styles = readFileSync(path.join(ROOT_DIR, "studio", "public", "styles.css"), "utf8");
  assert.match(app, /const hasProvenance = Object\.hasOwn\(target, "crossSocketExited"\)/);
  assert.match(app, /if \(session\.socketLabel\)/);
  assert.match(app, /if \(target\.attachHint && \(target\.status === "running" \|\| target\.crossSocketExited\)\)/);
  assert.match(app, /else if \(hasProvenance && target\.status === "exited"\)/);
  assert.match(styles, /\.resource-badge\.socket/);
  assert.match(styles, /\.detail-code/);
});

test("Studio launch controls expose validation state and a direct project edit action", () => {
  const app = readFileSync(path.join(ROOT_DIR, "studio", "public", "app.js"), "utf8");
  const html = readFileSync(path.join(ROOT_DIR, "studio", "public", "index.html"), "utf8");
  const styles = readFileSync(path.join(ROOT_DIR, "studio", "public", "styles.css"), "utf8");
  assert.match(app, /项校验错误阻止启动，请先修复/);
  assert.match(app, /validationPending = true/);
  assert.match(app, /project-quick-edit/);
  assert.match(app, /function projectKey\(value\)/);
  assert.match(app, /workspace: project\.path, name: project\.name, remember: false/);
  assert.match(html, /id="landing-project-name"[^>]+pattern=/);
  assert.match(html, /id="session-name"[^>]+readonly/);
  assert.match(styles, /\.primary-button:disabled \{ cursor: not-allowed; opacity: \.4/);
});

test("Studio confirmation rejects reentry before changing dialog content", () => {
  const source = readFileSync(path.join(ROOT_DIR, "studio", "public", "app.js"), "utf8");
  assert.match(source, /const dialog = \$\("#confirm-dialog"\);\n  if \(dialog\.open\) return false;\n  const cancel/);
});

test("the CLI still resolves an unconfigured project through defaults/agents.conf", () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "gsb-default-config-"));
  try {
    const result = spawnSync(path.join(ROOT_DIR, "gsb"), ["--print-config", workspace, "default-config-test"], {
      encoding: "utf8",
      env: testEnv(),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`Config:    ${path.join(ROOT_DIR, "defaults", "agents.conf")} (default)`));
    assert.match(result.stdout, /Roles:\s+hub,coder,core-bug,ops-gov,plan-backup,ui/);
    assert.match(result.stdout, /hub:\s+claude-glm-5\.3/);
    assert.match(result.stdout, /coder:\s+codex/);
    const overridden = spawnSync(path.join(ROOT_DIR, "gsb"), ["--print-config", workspace, "default-config-test"], {
      encoding: "utf8",
      env: testEnv({ GSB_CODER_AGENT: "shell:printf override" }),
    });
    assert.equal(overridden.status, 0, overridden.stderr);
    assert.match(overridden.stdout, /coder:\s+shell:printf override/);

    const paneOverridden = spawnSync(path.join(ROOT_DIR, "gsb"), ["--print-config", workspace, "default-config-test"], {
      encoding: "utf8",
      env: testEnv({
        ZELLIJ_SESSION_NAME: "caller-session",
        GSB_MODEL: "pane-global-model",
        GSB_CODER_AGENT: "shell:printf pane-override",
        GSB_CODER_MODEL: "pane-role-model",
        GSB_AGENT: "shell:printf inherited-default",
        GSB_STATE_DIR: "/wrong/session",
        GSB_WATCHDOG_ENABLED: "false",
        GSB_PERMISSION_MODE: "bypassPermissions",
      }),
    });
    assert.equal(paneOverridden.status, 0, paneOverridden.stderr);
    assert.match(paneOverridden.stdout, /hub:\s+claude-glm-5\.3/);
    assert.match(paneOverridden.stdout, /coder:\s+shell:printf pane-override\s+model=pane-role-model/);
    assert.equal(paneOverridden.stderr, "warning: inherited GSB_PERMISSION_MODE was stripped in pane context; use a clean shell to override permissions.\n");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("run-agent resolves named and legacy prompts from fake session environments", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "gsb-run-agent-prompts-"));
  const workspace = path.join(root, "workspace");
  const state = path.join(root, "state");
  const flatPrompts = path.join(workspace, ".gsb-local", "prompts");
  const namedProject = path.join(workspace, ".gsb-local", "projects", "named");
  try {
    mkdirSync(flatPrompts, { recursive: true });
    mkdirSync(path.join(namedProject, "prompts"), { recursive: true });
    writeFileSync(path.join(flatPrompts, "coder.md"), "legacy prompt\n");
    writeFileSync(path.join(namedProject, "prompts", "coder.md"), "named prompt\n");
    const env = testEnv({
      GSB_LOCAL_ROOT: ROOT_DIR,
      GSB_WORKSPACE: workspace,
      GSB_STATE_DIR: state,
      GSB_SESSION: "prompt-test",
      GSB_ROLES: "coder",
      GSB_CODER_AGENT: 'shell:printf "%s" "$GSB_ROLE_PROMPT"',
    });
    for (const [layout, sessionEnv, expected] of [
      ["legacy", "# old flat session.env\n", "legacy prompt"],
      ["named", `export GSB_PROJECT_DIR=${JSON.stringify(namedProject)}\nexport GSB_PROMPTS_DIR=${JSON.stringify(path.join(namedProject, "prompts"))}\n`, "named prompt"],
    ]) {
      const envFile = path.join(root, `${layout}.session.env`);
      writeFileSync(envFile, sessionEnv);
      const result = spawnSync("/bin/bash", ["-c", 'source "$1"; exec "$2" coder', "gsb-test", envFile, path.join(ROOT_DIR, "bin", "run-agent")], { encoding: "utf8", env });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`${expected}$`));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generated Zellij panes auto-start from a session-scoped environment", () => {
  const state = mkdtempSync(path.join(os.tmpdir(), "gsb-layout-runtime-"));
  const layout = path.join(state, "current.kdl");
  const sessionEnv = path.join(state, "session env.sh");
  try {
    const render = spawnSync(process.execPath, [
      path.join(ROOT_DIR, "bin", "render-layout.mjs"),
      layout,
      "isolated-session",
      "hub",
      "coder",
    ], {
      encoding: "utf8",
      env: testEnv({
        GSB_LOCAL_ROOT: ROOT_DIR,
        GSB_SESSION_ENV_FILE: sessionEnv,
        GSB_HUB_AGENT: "codex",
        GSB_CODER_AGENT: "claude-0812",
      }),
    });
    assert.equal(render.status, 0, render.stderr);
    const generated = readFileSync(layout, "utf8");
    assert.match(generated, /pane start_suspended=false/);
    assert.match(generated, /source '[^']*session env\.sh'/);
    assert.match(generated, /bin\/supervise/);
    assert.doesNotMatch(generated, /\$GSB_LOCAL_ROOT/);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("durable session metadata round-trips workspace and restart policy", () => {
  const state = mkdtempSync(path.join(os.tmpdir(), "gsb-session-meta-"));
  const metadata = path.join(state, "session.json");
  try {
    const written = spawnSync(process.execPath, [path.join(ROOT_DIR, "bin", "session-meta.mjs"), "write", metadata], {
      encoding: "utf8",
      env: testEnv({
        GSB_SESSION: "durable-test",
        GSB_WORKSPACE: state,
        GSB_STATE_DIR: state,
        GSB_CONFIG_PATH: path.join(state, "agents.conf"),
        GSB_CONFIG_SOURCE: "project",
        GSB_ROLES: "hub,coder",
        GSB_FULL_ACCESS: "true",
        GSB_WATCHDOG_ENABLED: "false",
      }),
    });
    assert.equal(written.status, 0, written.stderr);
    const saved = JSON.parse(readFileSync(metadata, "utf8"));
    assert.equal(saved.workspace, state);
    assert.deepEqual(saved.roles, ["hub", "coder"]);
    assert.equal(saved.fullAccess, true);
    assert.equal(saved.watchdogEnabled, false);

    const readWorkspace = spawnSync(process.execPath, [path.join(ROOT_DIR, "bin", "session-meta.mjs"), "get", metadata, "workspace"], { encoding: "utf8", env: testEnv() });
    assert.equal(readWorkspace.status, 0, readWorkspace.stderr);
    assert.equal(readWorkspace.stdout, state);

    const invalid = path.join(state, "invalid.json");
    writeFileSync(invalid, `${JSON.stringify({ ...saved, workspace: "relative/path" })}\n`);
    const rejected = spawnSync(process.execPath, [path.join(ROOT_DIR, "bin", "session-meta.mjs"), "get", invalid, "workspace"], { encoding: "utf8", env: testEnv() });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /workspace must be absolute/);
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
});

test("active sessions are never rebound or rewritten by a second launch", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "gsb-session-owner-"));
  const workspace = path.join(root, "project-a");
  const otherWorkspace = path.join(root, "project-b");
  const stateHome = path.join(root, "state");
  const state = path.join(stateHome, "gsb-local", "owned-session");
  const fakeBin = path.join(root, "bin");
  const fakeZellij = path.join(fakeBin, "zellij");
  try {
    for (const project of [workspace, otherWorkspace]) {
      mkdirSync(path.join(project, ".gsb-local"), { recursive: true });
      writeFileSync(path.join(project, ".gsb-local", "agents.conf"), "hub=shell:printf hub\\n");
    }
    mkdirSync(state, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(fakeZellij, "#!/usr/bin/env bash\nif [[ \"$*\" == \"list-sessions --no-formatting\" ]]; then [[ -n \"${ZELLIJ_SOCKET_DIR:-}\" ]] && echo 'owned-session [Created now]' || echo 'owned-session [Created now] (EXITED - attach to resurrect)'; exit 0; fi\nexit 99\n");
    chmodSync(fakeZellij, 0o755);
    writeFileSync(path.join(state, "session.env"), "do-not-overwrite\n");
    const metadataWrite = spawnSync(process.execPath, [path.join(ROOT_DIR, "bin", "session-meta.mjs"), "write", path.join(state, "session.json")], {
      encoding: "utf8",
      env: testEnv({
        GSB_SESSION: "owned-session",
        GSB_WORKSPACE: workspace,
        GSB_STATE_DIR: state,
        GSB_CONFIG_PATH: path.join(workspace, ".gsb-local", "agents.conf"),
        GSB_CONFIG_SOURCE: "project",
        GSB_ROLES: "hub",
      }),
    });
    assert.equal(metadataWrite.status, 0, metadataWrite.stderr);
    const originalMetadata = readFileSync(path.join(state, "session.json"), "utf8");
    const env = testEnv({ PATH: `${fakeBin}:${process.env.PATH || "/usr/bin:/bin"}`, XDG_STATE_HOME: stateHome });

    const sameProject = spawnSync(path.join(ROOT_DIR, "gsb"), ["--background", workspace, "owned-session"], { encoding: "utf8", env });
    assert.equal(sameProject.status, 0, sameProject.stderr);
    assert.match(sameProject.stdout, /already active/);
    assert.equal(readFileSync(path.join(state, "session.env"), "utf8"), "do-not-overwrite\n");
    assert.equal(readFileSync(path.join(state, "session.json"), "utf8"), originalMetadata);

    const wrongProject = spawnSync(path.join(ROOT_DIR, "gsb"), ["--background", otherWorkspace, "owned-session"], { encoding: "utf8", env });
    assert.notEqual(wrongProject.status, 0);
    assert.match(wrongProject.stderr, /belongs to a different workspace/);
    assert.equal(readFileSync(path.join(state, "session.env"), "utf8"), "do-not-overwrite\n");
    assert.equal(readFileSync(path.join(state, "session.json"), "utf8"), originalMetadata);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI create ignores inherited session state and records its socket directory", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "gsb-clean-create-"));
  const workspace = path.join(root, "project");
  const stateHome = path.join(root, "state");
  const fakeBin = path.join(root, "bin");
  const marker = path.join(root, "created");
  const createEnvLog = path.join(root, "create-env");
  const socketDir = "/tmp/gsb-w12-unit-socket";
  const taintedState = path.join(root, "wrong-state");
  const createdState = path.join(stateHome, "gsb-local", "clean-create");
  try {
    mkdirSync(path.join(workspace, ".gsb-local"), { recursive: true });
    mkdirSync(fakeBin);
    writeFileSync(path.join(workspace, ".gsb-local", "agents.conf"), "hub=shell:printf hub\ncoder=shell:printf coder\n");
    const fakeZellij = path.join(fakeBin, "zellij");
    writeFileSync(fakeZellij, `#!/usr/bin/env bash
if [[ "$*" == "list-sessions --no-formatting" ]]; then
  [[ -f ${JSON.stringify(marker)} ]] && echo 'clean-create [Created now]'
  exit 0
fi
if [[ "$*" == *"--create-background clean-create"* ]]; then
  printf '%s' "\${ZELLIJ_SESSION_NAME:-}" > ${JSON.stringify(createEnvLog)}
  touch ${JSON.stringify(marker)}
  exit 0
fi
exit 99
`);
    chmodSync(fakeZellij, 0o755);
    const result = spawnSync(path.join(ROOT_DIR, "gsb"), ["--background", workspace, "clean-create"], {
      encoding: "utf8",
      env: testEnv({
        PATH: `${fakeBin}:${process.env.PATH || "/usr/bin:/bin"}`,
        XDG_STATE_HOME: stateHome,
        GSB_STATE_DIR: taintedState,
        GSB_SESSION: "caller-session",
        GSB_AGENT: "shell:printf inherited-default",
        GSB_MODEL: "pane-global-model",
        GSB_HUB_AGENT: "shell:printf pane-override",
        GSB_HUB_MODEL: "pane-role-model",
        GSB_SOCKET_DIR_OVERRIDE: socketDir,
        GSB_WATCHDOG_ENABLED: "false",
        ZELLIJ_SESSION_NAME: "caller-session",
        ZELLIJ_SESSION_DIR: "/wrong/session-dir",
      }),
    });
    const watchdogLog = path.join(createdState, "watchdog.log");
    const sessionEnvFile = path.join(createdState, "session.env");
    assert.equal(result.status, 0, `${result.stderr}${existsSync(watchdogLog) ? readFileSync(watchdogLog, "utf8") : ""}${existsSync(sessionEnvFile) ? readFileSync(sessionEnvFile, "utf8") : ""}`);
    const sessionEnv = readFileSync(path.join(createdState, "session.env"), "utf8");
    assert.match(sessionEnv, new RegExp(`^export ZELLIJ_SOCKET_DIR=${socketDir}$`, "m"));
    assert.ok(sessionEnv.includes(`export GSB_PROJECT_DIR=${path.join(workspace, ".gsb-local")}\n`));
    assert.ok(sessionEnv.includes(`export GSB_PROMPTS_DIR=${path.join(workspace, ".gsb-local", "prompts")}\n`));
    assert.ok(sessionEnv.includes(`export GSB_PROFILES_DIR=${path.join(workspace, ".gsb-local", "profiles")}\n`));
    assert.match(sessionEnv, /^export GSB_AGENT=claude$/m);
    assert.match(sessionEnv, /^export GSB_WATCHDOG_ENABLED=true$/m);
    assert.match(sessionEnv, /^export GSB_MODEL=pane-global-model$/m);
    assert.ok(sessionEnv.includes("export GSB_HUB_AGENT=shell:printf\\ pane-override\n"));
    assert.match(sessionEnv, /^export GSB_HUB_MODEL=pane-role-model$/m);
    assert.equal(readFileSync(createEnvLog, "utf8"), "");
    assert.equal(existsSync(taintedState), false);
  } finally {
    const watchdogPidFile = path.join(createdState, "watchdog.pid");
    if (existsSync(watchdogPidFile)) {
      try { process.kill(Number(readFileSync(watchdogPidFile, "utf8").trim()), "SIGTERM"); } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("bounded command runner terminates a hung child", () => {
  const runner = path.join(ROOT_DIR, "bin", "run-with-timeout.mjs");
  const quick = spawnSync(process.execPath, [runner, "1000", process.execPath, "-e", "process.stdout.write('ok')"], { encoding: "utf8", env: testEnv() });
  assert.equal(quick.status, 0, quick.stderr);
  assert.equal(quick.stdout, "ok");

  const hung = spawnSync(process.execPath, [runner, "50", process.execPath, "-e", "setInterval(() => {}, 1000)"], { encoding: "utf8", timeout: 3_000, env: testEnv() });
  assert.equal(hung.status, 124, hung.stderr);
  assert.match(hung.stderr, /exceeded 50ms/);
});

test("workbench validation protects Hub and role identity", () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "gsb-studio-validation-"));
  try {
    assert.equal(validateWorkbench(fixture(workspace)).valid, true);
    const coreOnly = fixture(workspace);
    coreOnly.roles[0].prompt = "";
    assert.equal(validateWorkbench(coreOnly).valid, true, "Hub extension is optional because the core is built in");
    const invalid = fixture(workspace);
    invalid.roles[0].id = "Not Valid";
    const result = validateWorkbench(invalid);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((message) => message.includes("必须且只能包含一个 hub")));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("async runtime validation yields and deduplicates in-flight command probes", async () => {
  let calls = 0;
  const validator = createRuntimeValidator({
    spawnImpl: asyncSpawnStub(() => { calls += 1; return { status: 0, delay: 60 }; }),
    spawnSyncImpl: () => { throw new Error("sync path used"); },
    env: {}, cacheFile: false, listSessionOptionsImpl: () => [],
  });
  const workbench = fixture(os.tmpdir());
  workbench.roles.forEach((role) => { role.agent = "slow-agent"; });
  const first = validator.validate(workbench);
  assert.equal(calls, 0, "pure validation runs before async probing begins");
  await Promise.resolve();
  const second = validator.validate(workbench);
  let timerAdvanced = false;
  setTimeout(() => { timerAdvanced = true; }, 10);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(timerAdvanced, true);
  assert.equal(calls, 1);
  assert.deepEqual([(await first).valid, (await second).valid], [true, true]);
});

test("persistent command cache stores only positive results and follows shell fingerprints", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "gsb-studio-command-cache-"));
  const home = path.join(root, "home");
  const env = { HOME: home, GSB_STUDIO_STATE_HOME: path.join(root, "state"), GSB_STUDIO_VALIDATE_SYNC: "1" };
  mkdirSync(home);
  writeFileSync(path.join(home, ".zshrc"), "alias cached='true'\n");
  writeFileSync(path.join(home, ".zshenv"), "# env\n");
  try {
    const makeValidator = (validatorEnv, spawnSyncImpl) => createRuntimeValidator({
      env: validatorEnv, home, spawnSyncImpl, listSessionOptionsImpl: () => [],
    });
    const first = makeValidator(env, (command, args) => command === "/bin/zsh"
        ? { status: 0, stdout: interactiveOutput(false), signal: null, error: null }
        : { status: args.at(-1) === "codex" ? 0 : 1, signal: null, error: null });
    await first.checkCommands(["codex", "missing-agent"]);
    const file = commandCacheFile({ env, home });
    assert.equal(file, path.join(env.GSB_STUDIO_STATE_HOME, "cache", "command-cache.json"));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).commands, { codex: true });

    let restarts = 0;
    const restarted = makeValidator(env, () => { restarts += 1; return { status: 0, signal: null, error: null }; });
    assert.equal((await restarted.checkCommands(["codex"])).get("codex").available, true);
    assert.equal(restarts, 0, "matching disk cache skips every spawn");
    writeFileSync(path.join(home, ".zshrc"), "alias cached='true'\n# fingerprint changed\n");
    await restarted.checkCommands(["codex"]);
    assert.equal(restarts, 1, "changed shell fingerprint forces one new probe");

    const offEnv = { ...env, GSB_STUDIO_STATE_HOME: path.join(root, "off-state"), GSB_STUDIO_CMD_CACHE: "off" };
    let uncachedCalls = 0;
    const uncached = makeValidator(offEnv, () => { uncachedCalls += 1; return { status: 0, signal: null, error: null }; });
    await uncached.checkCommands(["codex"]);
    await uncached.checkCommands(["codex"]);
    assert.equal(uncachedCalls, 2);
    assert.equal(existsSync(commandCacheFile({ env: offEnv, home })), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("session listing caches for 30 seconds and supports explicit invalidation", async () => {
  const cache = new Map();
  let currentTime = 1_000;
  let calls = 0;
  const options = {
    cache, now: () => currentTime,
    env: { PATH: "/usr/bin:/bin", TMPDIR: "/tmp" },
    home: "/Users/test", uid: 501, socketDirs: ["/unified", "/legacy"],
    spawnImpl: asyncSpawnStub((_command, _args, spawnOptions) => {
      calls += 1;
      return { stdout: spawnOptions.env.ZELLIJ_SOCKET_DIR === "/unified" ? "shared [Created now]\n" : "legacy [Created now]\n" };
    }),
  };
  assert.equal((await listSessions(options)).length, 2);
  assert.equal((await listSessions(options)).length, 2);
  assert.equal(calls, 2);
  currentTime += 29_999; await listSessions(options);
  assert.equal(calls, 2);
  currentTime += 2; await listSessions(options);
  assert.equal(calls, 4);
  invalidateSessionCache(cache); await listSessions(options);
  assert.equal(calls, 6);
});

test("runtime command validation caches a repeated available command", async () => {
  const calls = [];
  const validator = fakeRuntimeValidator((command, args) => {
    calls.push({ command, args });
    return { status: 0, signal: null, error: null };
  });
  assert.equal((await validator.checkCommands(["codex"])).get("codex").available, true);
  assert.equal((await validator.checkCommands(["codex"])).get("codex").available, true);
  assert.equal(calls.length, 1);
});

test("runtime command validation expires negative cache entries after 30 seconds", async () => {
  let currentTime = 1_000;
  const calls = [];
  const validator = fakeRuntimeValidator((command) => {
    calls.push(command);
    return command === "/bin/zsh"
      ? { status: 0, signal: null, error: null, stdout: interactiveOutput(false) }
      : { status: 1, signal: null, error: null };
  }, { now: () => currentTime });
  assert.equal((await validator.checkCommands(["missing-agent"])).get("missing-agent").available, false);
  assert.equal(calls.length, 2);
  currentTime += 29_999;
  assert.equal((await validator.checkCommands(["missing-agent"])).get("missing-agent").available, false);
  assert.equal(calls.length, 2);
  currentTime += 2;
  assert.equal((await validator.checkCommands(["missing-agent"])).get("missing-agent").available, false);
  assert.equal(calls.length, 4);
});

test("runtime command validation keeps positive cache entries across TTL periods", async () => {
  let currentTime = 1_000;
  let calls = 0;
  const validator = fakeRuntimeValidator(() => {
    calls += 1;
    return { status: 0, signal: null, error: null };
  }, { now: () => currentTime });
  assert.equal((await validator.checkCommands(["codex"])).get("codex").available, true);
  currentTime += 300_000;
  assert.equal((await validator.checkCommands(["codex"])).get("codex").available, true);
  assert.equal(calls, 1);
});

test("runtime command timeout is a warning and does not invalidate the workbench", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "gsb-studio-command-timeout-"));
  try {
    const validator = fakeRuntimeValidator((command) => command === "/bin/zsh"
      ? { status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT" } }
      : { status: 1, signal: null, error: null });
    const workbench = fixture(workspace);
    workbench.roles[0].agent = "slow-agent";
    const result = await validator.validate(workbench);
    assert.equal(result.valid, true);
    assert.ok(result.warnings.some((message) => message.includes("slow-agent") && message.includes("检查超时")));
    assert.ok(!result.errors.some((message) => message.includes("slow-agent")));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("runtime command clean exit 1 is a not-found error", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "gsb-studio-command-missing-"));
  try {
    const validator = fakeRuntimeValidator(() => ({ status: 1, signal: null, error: null }));
    const workbench = fixture(workspace);
    workbench.roles[0].agent = "missing-agent";
    const result = await validator.validate(workbench);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((message) => message.includes("找不到命令或 alias missing-agent")));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("runtime command precheck avoids interactive shells when every command is available", async () => {
  const calls = [];
  const validator = fakeRuntimeValidator((command, args) => {
    calls.push({ command, args });
    return { status: 0, signal: null, error: null };
  });
  const commands = ["claude", "codex", "kimi", "zellij"];
  assert.deepEqual([...(await validator.checkCommands(commands)).values()].map(({ available }) => available), [true, true, true, true]);
  assert.equal(calls.filter(({ command }) => command === "/bin/zsh").length, 0);
  assert.equal(calls.filter(({ command }) => command === "/bin/sh").length, 4);
});

test("runtime command misses use one positional-argument interactive batch", async () => {
  const calls = [];
  const commands = ["alias-one", "alias two", "$(unsafe)"];
  const validator = fakeRuntimeValidator((command, args) => {
    calls.push({ command, args });
    return command === "/bin/zsh"
      ? { status: 0, signal: null, error: null, stdout: interactiveOutput(true, false, true) }
      : { status: 1, signal: null, error: null };
  });
  const result = await validator.checkCommands(commands);
  assert.deepEqual([...result.values()].map(({ available }) => available), [true, false, true]);
  const interactive = calls.filter(({ command }) => command === "/bin/zsh");
  assert.equal(interactive.length, 1);
  assert.deepEqual(interactive[0].args.slice(3), commands);
  assert.ok(commands.every((command) => !interactive[0].args[1].includes(command)));
});

test("runtime command rollback switches restore strict and uncached behavior", async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "gsb-studio-command-switches-"));
  try {
    const strictValidator = fakeRuntimeValidator((command) => command === "/bin/zsh"
      ? { status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT" } }
      : { status: 1, signal: null, error: null }, { env: { GSB_STUDIO_CHECK_STRICT: "on" } });
    const workbench = fixture(workspace);
    workbench.roles[0].agent = "slow-agent";
    const strict = await strictValidator.validate(workbench);
    assert.equal(strict.valid, false);
    assert.ok(strict.errors.some((message) => message.includes("slow-agent") && message.includes("检查超时")));

    let calls = 0;
    const uncachedValidator = fakeRuntimeValidator(() => {
      calls += 1;
      return { status: 0, signal: null, error: null };
    }, { env: { GSB_STUDIO_CMD_CACHE: "off" } });
    await uncachedValidator.checkCommands(["codex"]);
    await uncachedValidator.checkCommands(["codex"]);
    assert.equal(calls, 2);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("staging prevalidation leaves committed project files unchanged", () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "gsb-studio-staging-"));
  try {
    const original = fixture(workspace);
    saveProjectState(original);
    const agentsFile = path.join(workspace, ".gsb-local", "agents.conf");
    const sidecarFile = path.join(workspace, ".gsb-local", "workbench.json");
    const committedAgents = readFileSync(agentsFile, "utf8");
    const committedSidecar = readFileSync(sidecarFile, "utf8");
    const invalid = JSON.parse(JSON.stringify(original));
    invalid.roles[1].agent = "shell:printf ok\nbroken";
    assert.throws(() => saveProjectState(invalid), /配置预校验失败/);
    assert.equal(readFileSync(agentsFile, "utf8"), committedAgents);
    assert.equal(readFileSync(sidecarFile, "utf8"), committedSidecar);
    assert.ok(!readdirSync(path.join(workspace, ".gsb-local")).some((name) => name.startsWith(".staging-")));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("store prevalidation rejects empty agents and duplicate role IDs before commit", () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "gsb-studio-store-guard-"));
  try {
    const original = fixture(workspace);
    saveProjectState(original);
    const localDirectory = path.join(workspace, ".gsb-local");
    const committedFiles = [
      "agents.conf",
      "models.conf",
      "workbench.json",
      path.join("prompts", "hub-extension.md"),
      path.join("prompts", "coder.md"),
    ];
    const committed = new Map(committedFiles.map((file) => [file, readFileSync(path.join(localDirectory, file), "utf8")]));
    const invalidCases = [
      {
        pattern: /Agent 值不能为空/,
        workbench: { ...original, roles: original.roles.map((role) => role.id === "coder" ? { ...role, agent: "   " } : role) },
      },
      {
        pattern: /重复角色 ID/,
        workbench: { ...original, roles: [...original.roles, { ...original.roles[1] }] },
      },
    ];
    for (const { pattern, workbench } of invalidCases) {
      assert.throws(() => saveProjectState(workbench), pattern);
      for (const [file, content] of committed) assert.equal(readFileSync(path.join(localDirectory, file), "utf8"), content);
      assert.ok(!readdirSync(localDirectory).some((name) => name.startsWith(".staging-")));
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("damaged sidecar JSON falls back to authoritative project files", () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "gsb-studio-damaged-sidecar-"));
  try {
    const original = fixture(workspace);
    saveProjectState(original);
    writeFileSync(path.join(workspace, ".gsb-local", "workbench.json"), "{ this is not json,,,");
    const loaded = loadProjectState(workspace);
    assert.deepEqual(loaded.roles.map(({ id, agent, model }) => ({ id, agent, model })), original.roles.map(({ id, agent, model }) => ({ id, agent, model })));
    assert.equal(loaded.roles.find((role) => role.id === "coder").prompt, "Implement only assigned paths.\n");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("layered role prompts compose to disk and load back into base and intent", () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "gsb-studio-layered-prompt-"));
  try {
    const original = fixture(workspace);
    original.roles[1] = {
      ...original.roles[1],
      prompt: "stale preview",
      promptBase: "Implement focused production changes.",
      intent: "Coordinate API changes with the frontend owner.",
      promptMode: "layered",
    };
    saveProjectState(original);
    const promptFile = path.join(workspace, ".gsb-local", "prompts", "coder.md");
    assert.equal(readFileSync(promptFile, "utf8"), `Implement focused production changes.\n\n${PROMPT_INTENT_MARKER}\n\nCoordinate API changes with the frontend owner.\n`);
    const loaded = loadProjectState(workspace).roles.find((role) => role.id === "coder");
    assert.equal(loaded.promptMode, "layered");
    assert.equal(loaded.promptBase, "Implement focused production changes.");
    assert.equal(loaded.intent, "Coordinate API changes with the frontend owner.");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("an unmarked project prompt remains a custom full prompt", () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "gsb-studio-custom-prompt-"));
  try {
    const original = fixture(workspace);
    saveProjectState(original);
    const loaded = loadProjectState(workspace).roles.find((role) => role.id === "coder");
    assert.equal(loaded.promptMode, "custom");
    assert.equal(loaded.promptBase, "");
    assert.equal(loaded.intent, "");
    assert.equal(loaded.prompt, "Implement only assigned paths.\n");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("new projects derive valid sessions from basename and fall back for invalid names", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "gsb-studio-session-name-"));
  try {
    const cases = [
      ["valid-project", "valid-project"],
      ["project with spaces", "seed-gsb"],
      ["中文项目", "seed-gsb"],
    ];
    for (const [name, expected] of cases) {
      const workspace = path.join(root, name);
      mkdirSync(workspace);
      assert.equal(loadProjectState(workspace).session, expected);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("role bases match exact names and aliases before falling back to generic", () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "gsb-studio-role-base-"));
  try {
    const localDirectory = path.join(workspace, ".gsb-local");
    mkdirSync(localDirectory);
    writeFileSync(path.join(localDirectory, "agents.conf"), "hub=shell:printf hub\nfrontend=codex\nfe=codex\nunknown-role=codex\n");
    const roles = loadProjectState(workspace).roles;
    const frontendBase = readFileSync(path.join(ROOT_DIR, "prompts", "frontend.md"), "utf8").trim();
    const genericBase = readFileSync(path.join(ROOT_DIR, "prompts", "generic.md"), "utf8").trim();
    assert.equal(roles.find((role) => role.id === "frontend").promptBase, frontendBase);
    assert.equal(roles.find((role) => role.id === "frontend").promptTemplate, "frontend");
    assert.equal(roles.find((role) => role.id === "frontend").name, "Frontend");
    assert.equal(roles.find((role) => role.id === "frontend").type, "specialist");
    assert.equal(roles.find((role) => role.id === "fe").promptBase, frontendBase);
    assert.equal(roles.find((role) => role.id === "fe").promptTemplate, "frontend");
    assert.equal(roles.find((role) => role.id === "fe").name, "Frontend");
    assert.equal(roles.find((role) => role.id === "unknown-role").promptBase, genericBase);
    assert.equal(roles.find((role) => role.id === "unknown-role").promptTemplate, "generic");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("workbench validation rejects an empty role list", () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "gsb-studio-empty-roster-"));
  try {
    const result = validateWorkbench({ ...fixture(workspace), roles: [] });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((message) => message.includes("至少需要一个角色")));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("consecutive saves leave no staging residue and expose the latest state", () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "gsb-studio-consecutive-save-"));
  try {
    const first = fixture(workspace);
    saveProjectState(first);
    const second = JSON.parse(JSON.stringify(first));
    second.name = "Latest Studio state";
    second.roles[1].agent = "shell:printf latest";
    second.roles[1].model = "latest-model";
    second.roles[1].prompt = "Latest coder prompt.";
    saveProjectState(second);
    const localDirectory = path.join(workspace, ".gsb-local");
    assert.deepEqual(parseRoleMap(readFileSync(path.join(localDirectory, "agents.conf"), "utf8")), [
      { id: "hub", value: "shell:printf hub" },
      { id: "coder", value: "shell:printf latest" },
    ]);
    assert.match(readFileSync(path.join(localDirectory, "models.conf"), "utf8"), /coder=latest-model/);
    assert.equal(readFileSync(path.join(localDirectory, "prompts", "coder.md"), "utf8"), "Latest coder prompt.\n");
    assert.equal(JSON.parse(readFileSync(path.join(localDirectory, "workbench.json"), "utf8")).name, second.name);
    assert.ok(!readdirSync(localDirectory).some((name) => name.startsWith(".staging-")));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a 50-role project state round-trips without truncation", () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "gsb-studio-long-roster-"));
  try {
    const original = fixture(workspace);
    original.roles.push(...Array.from({ length: 48 }, (_, index) => ({
      id: `extra-${index + 1}`,
      name: `Extra ${index + 1}`,
      type: "specialist",
      description: "long roster fixture",
      agent: `shell:printf extra-${index + 1}`,
      model: `model-${index + 1}`,
      promptTemplate: "generic",
      prompt: `Prompt ${index + 1}.`,
    })));
    saveProjectState(original);
    const loaded = loadProjectState(workspace);
    assert.equal(loaded.roles.length, 50);
    assert.deepEqual(loaded.roles.map((role) => role.id), original.roles.map((role) => role.id));
    assert.equal(loaded.roles.at(-1).agent, original.roles.at(-1).agent);
    assert.equal(loaded.roles.at(-1).model, original.roles.at(-1).model);
    assert.equal(loaded.roles.at(-1).prompt, `${original.roles.at(-1).prompt}\n`);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("a second named project lazily migrates a flat project without cross-talk", () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "gsb-studio-projects-"));
  try {
    const legacy = fixture(workspace);
    saveProjectState(legacy);
    assert.equal(loadProjectState(workspace).projectName, "studio-test");
    assert.equal(existsSync(path.join(workspace, ".gsb-local", "projects")), false);

    const beta = { ...fixture(workspace), projectName: "beta", name: "Beta", session: "beta" };
    beta.roles = beta.roles.map((role) => role.id === "coder" ? { ...role, agent: "shell:printf beta" } : role);
    saveProjectState(beta);

    assert.deepEqual(listStoredProjects(workspace).map(({ name }) => name), ["beta", "studio-test"]);
    assert.equal(existsSync(path.join(workspace, ".gsb-local", "agents.conf")), false);
    assert.equal(existsSync(path.join(projectDir(workspace, "studio-test"), "agents.conf")), true);
    assert.equal(loadProjectState(workspace, "studio-test").roles[1].agent, "shell:printf coder");
    assert.equal(loadProjectState(workspace, "beta").roles[1].agent, "shell:printf beta");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("lazy migration restores every flat file when the final rename fails", () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "gsb-studio-migrate-"));
  try {
    saveProjectState(fixture(workspace));
    const files = ["agents.conf", "models.conf", "workbench.json", path.join("prompts", "coder.md")];
    const before = new Map(files.map((name) => [name, readFileSync(path.join(workspace, ".gsb-local", name))]));
    const beta = { ...fixture(workspace), projectName: "beta", session: "beta" };
    let renames = 0;
    assert.throws(() => saveProjectState(beta, { renameImpl(from, to) {
      if (++renames === 6) throw new Error("injected final rename failure");
      renameSync(from, to);
    } }), /旧配置已回滚/);
    for (const [name, bytes] of before) assert.deepEqual(readFileSync(path.join(workspace, ".gsb-local", name)), bytes);
    assert.deepEqual(listStoredProjects(workspace).map(({ name, legacy }) => ({ name, legacy })), [{ name: "studio-test", legacy: true }]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("local API bootstraps, validates, and saves project-local files", async (t) => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "gsb-studio-api-"));
  mkdirSync(path.join(workspace, ".git"));
  const stateRoot = path.join(workspace, ".studio-state");
  const savedSession = path.join(stateRoot, "saved-session");
  const otherWorkspace = path.join(workspace, "other-project");
  const foreignSession = path.join(stateRoot, "foreign-session");
  mkdirSync(savedSession, { recursive: true });
  mkdirSync(otherWorkspace);
  mkdirSync(foreignSession);
  writeFileSync(path.join(savedSession, "ROLES.md"), `# GSB Active Role Roster\n\nSession: saved-session\nWorkspace: ${workspace}\n\n## Active roles\n\n- hub: \`codex\`\n- coder: \`codex\`\n`);
  writeFileSync(path.join(foreignSession, "ROLES.md"), `# GSB Active Role Roster\n\nSession: foreign-session\nWorkspace: ${otherWorkspace}\n\n## Active roles\n\n- hub: \`codex\`\n`);
  const previousStateHome = process.env.GSB_STUDIO_STATE_HOME;
  const previousConfigHome = process.env.GSB_STUDIO_CONFIG_HOME;
  process.env.GSB_STUDIO_STATE_HOME = stateRoot;
  process.env.GSB_STUDIO_CONFIG_HOME = path.join(workspace, ".studio-config");
  const token = "test-token";
  let cacheWriteAttempted = false;
  const validator = createRuntimeValidator({ env: { GSB_STUDIO_VALIDATE_SYNC: "1" }, cacheFile: "ignored",
    atomicWriteImpl: () => { cacheWriteAttempted = true; throw new Error("disk full"); },
    spawnSyncImpl: () => ({ status: 0, signal: null, error: null }), listSessionOptionsImpl: () => [{ name: "foreign-session", workspace: otherWorkspace, status: "saved" }] });
  const server = createStudioServer({ project: workspace, token, platform: "linux", validator });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (pathname, options = {}) => fetch(`${origin}${pathname}`, {
    ...options,
    headers: { "content-type": "application/json", "x-gsb-token": token, ...(options.headers || {}) },
  });
  try {
    const page = await fetch(`${origin}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /GSB Studio/);

    const forbidden = await fetch(`${origin}/api/bootstrap`);
    assert.equal(forbidden.status, 403);

    await t.test("projectless bootstrap returns a landing-page payload", async () => {
      const landingServer = createStudioServer({ project: "", token });
      await new Promise((resolve, reject) => {
        landingServer.once("error", reject);
        landingServer.listen(0, "127.0.0.1", resolve);
      });
      try {
        const response = await fetch(`http://127.0.0.1:${landingServer.address().port}/api/bootstrap`, {
          headers: { "x-gsb-token": token },
        });
        assert.equal(response.status, 200);
        const payload = await response.json();
        assert.equal(payload.workbench, null);
        assert.ok(payload.projectOptions.some((project) => project.path === workspace));
        assert.ok(!payload.recentProjects.includes(""));
      } finally {
        await new Promise((resolve) => landingServer.close(resolve));
      }
    });

    const boot = await request("/api/bootstrap");
    assert.equal(boot.status, 200);
    const bootPayload = await boot.json();
    assert.equal(bootPayload.product.apiVersion, 2);
    assert.equal(bootPayload.platform, process.platform);
    assert.equal(bootPayload.roleBaseAliases.fe, "frontend");
    const defaultProfile = bootPayload.profiles.find((profile) => profile.id === "config1");
    const defaultHub = defaultProfile.roles.find((role) => role.role === "hub");
    assert.equal(bootPayload.workbench.roles[0].agent, defaultHub.agent);
    assert.ok(bootPayload.workbench.roles.some((role) => role.id === "coder"));
    assert.ok(bootPayload.projectOptions.some((project) => project.path === workspace && project.sessions === 1));
    const savedSessionOption = bootPayload.sessionOptions.find((session) => session.name === "saved-session");
    assert.equal(savedSessionOption.status, "saved");
    assert.equal(savedSessionOption.workspace, workspace);
    assert.deepEqual(savedSessionOption.roles, ["hub", "coder"]);

    const resources = await request(`/api/resources?project=${encodeURIComponent(workspace)}`);
    assert.equal(resources.status, 200);
    assert.ok((await resources.json()).sessionOptions.some((session) => session.name === "saved-session"));

    await t.test("validate survives command-cache write failures", async () => {
      const workbench = fixture(workspace);
      workbench.roles[1].agent = "codex";
      const response = await request("/api/validate", { method: "POST", body: JSON.stringify({ workbench }) });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).validation.valid, true);
      assert.equal(cacheWriteAttempted, true);
    });

    await t.test("validate rejects empty prefixed agents and control characters", async () => {
      for (const agent of ["shell:", "codex:"]) {
        const invalid = fixture(workspace);
        invalid.roles[1].agent = agent;
        const response = await request("/api/validate", { method: "POST", body: JSON.stringify({ workbench: invalid }) });
        assert.equal(response.status, 200);
        const payload = await response.json();
        assert.equal(payload.validation.valid, false);
        assert.ok(payload.validation.errors.some((message) => message.includes("冒号后必须提供命令")));
      }
      const unsafe = fixture(workspace);
      unsafe.roles[1].agent = "shell:printf ok\nnext";
      unsafe.roles[1].model = "codex-test\u0007";
      const response = await request("/api/validate", { method: "POST", body: JSON.stringify({ workbench: unsafe }) });
      const payload = await response.json();
      assert.equal(payload.validation.valid, false);
      assert.ok(payload.validation.errors.some((message) => message.includes("Agent 不能包含换行或控制字符")));
      assert.ok(payload.validation.errors.some((message) => message.includes("模型不能包含换行或控制字符")));
      const wrongType = fixture(workspace);
      wrongType.roles[1].model = 42;
      const wrongTypeResponse = await request("/api/validate", { method: "POST", body: JSON.stringify({ workbench: wrongType }) });
      const wrongTypePayload = await wrongTypeResponse.json();
      assert.equal(wrongTypeResponse.status, 200);
      assert.ok(wrongTypePayload.validation.errors.some((message) => message.includes("模型必须是文本")));
    });

    await t.test("open-terminal validates input and returns the portable command through the API", async () => {
      const valid = await request("/api/open-terminal", {
        method: "POST",
        body: JSON.stringify({ session: "safe-session" }),
      });
      assert.equal(valid.status, 200);
      assert.deepEqual(await valid.json(), { command: "gsb-local open safe-session", opened: false });

      const response = await request("/api/open-terminal", {
        method: "POST",
        body: JSON.stringify({ session: "unsafe;session" }),
      });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /会话名只能包含/);
    });

    await t.test("validate detects a same-name session owned by another workspace", async () => {
      const conflicting = fixture(workspace);
      conflicting.session = "foreign-session";
      const response = await request("/api/validate", { method: "POST", body: JSON.stringify({ workbench: conflicting }) });
      const payload = await response.json();
      assert.equal(payload.validation.valid, false);
      assert.ok(payload.validation.errors.some((message) => message.includes("属于另一项目") && message.includes("更换会话名称") && message.includes("gsb-local open")));
    });

    await t.test("an empty spoke prompt saves a non-empty builtin base", async () => {
      const baseWorkspace = path.join(workspace, "empty-prompt-project");
      mkdirSync(baseWorkspace);
      const emptyPrompt = fixture(baseWorkspace);
      emptyPrompt.roles[1].prompt = "";
      const response = await request("/api/save", { method: "POST", body: JSON.stringify({ workbench: emptyPrompt }) });
      assert.equal(response.status, 200, await response.text());
      const expectedBase = readFileSync(path.join(ROOT_DIR, "prompts", "coder.md"), "utf8").trim();
      const savedPrompt = readFileSync(path.join(baseWorkspace, ".gsb-local", "prompts", "coder.md"), "utf8");
      assert.equal(savedPrompt, `${expectedBase}\n\n${PROMPT_INTENT_MARKER}\n`);
      const loaded = loadProjectState(baseWorkspace).roles.find((role) => role.id === "coder");
      assert.equal(loaded.promptMode, "layered");
      assert.equal(loaded.promptBase, expectedBase);
      assert.equal(loaded.intent, "");
    });

    const promptDirectory = path.join(workspace, ".gsb-local", "prompts");
    mkdirSync(promptDirectory, { recursive: true });
    writeFileSync(path.join(promptDirectory, "stale-role.md"), "stale\n");
    writeFileSync(path.join(promptDirectory, "hub.md"), "legacy\n");

    const save = await request("/api/save", { method: "POST", body: JSON.stringify({ workbench: fixture(workspace) }) });
    assert.equal(save.status, 200, await save.text());
    assert.match(readFileSync(path.join(workspace, ".gsb-local", "agents.conf"), "utf8"), /hub=shell:printf hub/);
    assert.match(readFileSync(path.join(workspace, ".gsb-local", "models.conf"), "utf8"), /hub=glm-test/);
    assert.equal(readFileSync(path.join(workspace, ".gsb-local", "prompts", "hub-extension.md"), "utf8"), "Coordinate only.\n");
    assert.equal(existsSync(path.join(workspace, ".gsb-local", "prompts", "hub.md")), false);
    assert.equal(existsSync(path.join(workspace, ".gsb-local", "prompts", "stale-role.md")), false);
    assert.equal(readFileSync(path.join(workspace, ".gsb-local", "prompts", "coder.md"), "utf8"), "Implement only assigned paths.\n");

    await t.test("validate previews a draft without mutating project files", async () => {
      const files = [
        path.join(workspace, ".gsb-local", "agents.conf"),
        path.join(workspace, ".gsb-local", "models.conf"),
        path.join(workspace, ".gsb-local", "workbench.json"),
        ...readdirSync(promptDirectory).map((name) => path.join(promptDirectory, name)),
      ];
      const before = new Map(files.map((file) => [file, {
        bytes: readFileSync(file),
        mtimeNs: statSync(file, { bigint: true }).mtimeNs,
      }]));
      const draft = fixture(workspace);
      draft.roles[1].agent = "shell:printf draft-agent";
      draft.roles[1].model = "draft-model";
      draft.roles[1].prompt = "Draft prompt must not persist.";
      const response = await request("/api/validate", { method: "POST", body: JSON.stringify({ workbench: draft }) });
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.match(payload.files.models, /coder=draft-model/);
      for (const [file, snapshot] of before) {
        assert.deepEqual(readFileSync(file), snapshot.bytes, file);
        assert.equal(statSync(file, { bigint: true }).mtimeNs, snapshot.mtimeNs, file);
      }
    });

    await t.test("project load treats conf and prompts as authoritative", async () => {
      const authorityWorkspace = path.join(workspace, "authority-project");
      mkdirSync(authorityWorkspace);
      const authoritative = fixture(authorityWorkspace);
      const initialSave = await request("/api/save", { method: "POST", body: JSON.stringify({ workbench: authoritative }) });
      assert.equal(initialSave.status, 200, await initialSave.text());

      const localDirectory = path.join(authorityWorkspace, ".gsb-local");
      writeFileSync(path.join(localDirectory, "agents.conf"), "# manually edited\nhub=shell:printf hub\ncoder=claude\nextra=codex\n");
      writeFileSync(path.join(localDirectory, "models.conf"), "coder=manual-model\nextra=extra-model\n");
      writeFileSync(path.join(localDirectory, "prompts", "coder.md"), "Manual coder prompt.\n");
      writeFileSync(path.join(localDirectory, "prompts", "extra.md"), "Manual extra prompt.\n");
      const sidecarFile = path.join(localDirectory, "workbench.json");
      const staleSidecar = JSON.parse(readFileSync(sidecarFile, "utf8"));
      staleSidecar.roles.find((role) => role.id === "coder").agent = "stale-agent";
      staleSidecar.roles.push({ id: "ghost", name: "Ghost", agent: "codex", model: "ghost-model", prompt: "stale" });
      writeFileSync(sidecarFile, `${JSON.stringify(staleSidecar, null, 2)}\n`);

      const loadedResponse = await request("/api/project", { method: "POST", body: JSON.stringify({ workspace: authorityWorkspace }) });
      assert.equal(loadedResponse.status, 200);
      const loaded = (await loadedResponse.json()).workbench;
      assert.deepEqual(loaded.roles.map((role) => role.id), ["hub", "coder", "extra"]);
      assert.equal(loaded.roles.find((role) => role.id === "coder").agent, "claude");
      assert.equal(loaded.roles.find((role) => role.id === "coder").model, "manual-model");
      assert.equal(loaded.roles.find((role) => role.id === "coder").prompt, "Manual coder prompt.\n");
      assert.equal(loaded.roles.find((role) => role.id === "extra").agent, "codex");
      assert.equal(loaded.roles.find((role) => role.id === "extra").model, "extra-model");
      assert.equal(loaded.roles.find((role) => role.id === "extra").prompt, "Manual extra prompt.\n");
      assert.ok(!loaded.roles.some((role) => role.id === "ghost"));

      unlinkSync(sidecarFile);
      const withoutSidecarResponse = await request("/api/project", { method: "POST", body: JSON.stringify({ workspace: authorityWorkspace }) });
      const withoutSidecar = (await withoutSidecarResponse.json()).workbench;
      assert.deepEqual(withoutSidecar.roles.map((role) => role.id), ["hub", "coder", "extra"]);
      assert.equal(withoutSidecar.permission, "balanced");
      assert.equal(withoutSidecar.roles.find((role) => role.id === "extra").name, "extra");
    });

    await t.test("project state round-trips through an UI-only sidecar", async () => {
      const roundTripWorkspace = path.join(workspace, "round-trip-project");
      mkdirSync(roundTripWorkspace);
      const original = fixture(roundTripWorkspace);
      original.roles[1].name = "Implementation Owner";
      const saveResponse = await request("/api/save", { method: "POST", body: JSON.stringify({ workbench: original }) });
      assert.equal(saveResponse.status, 200, await saveResponse.text());
      const loadResponse = await request("/api/project", { method: "POST", body: JSON.stringify({ workspace: roundTripWorkspace }) });
      const loaded = (await loadResponse.json()).workbench;
      assert.deepEqual(loaded.roles.map(({ id, agent, model }) => ({ id, agent, model })), original.roles.map(({ id, agent, model }) => ({ id, agent, model })));
      assert.deepEqual(loaded.roles.map((role) => role.prompt), original.roles.map((role) => `${role.prompt.trim()}\n`));

      const sidecar = JSON.parse(readFileSync(path.join(roundTripWorkspace, ".gsb-local", "workbench.json"), "utf8"));
      for (const role of sidecar.roles) {
        assert.equal("agent" in role, false);
        assert.equal("model" in role, false);
        assert.equal("prompt" in role, false);
      }
    });

    await t.test("legacy sidecar self-heals when agents.conf is missing", async () => {
      const legacyWorkspace = path.join(workspace, "legacy-project");
      mkdirSync(path.join(legacyWorkspace, ".gsb-local"), { recursive: true });
      writeFileSync(path.join(legacyWorkspace, ".gsb-local", "workbench.json"), `${JSON.stringify(fixture(legacyWorkspace), null, 2)}\n`);
      const loadResponse = await request("/api/project", { method: "POST", body: JSON.stringify({ workspace: legacyWorkspace }) });
      assert.equal(loadResponse.status, 200);
      const loaded = (await loadResponse.json()).workbench;
      assert.deepEqual(loaded.roles.map((role) => role.id), ["hub", "coder"]);
      assert.equal(existsSync(path.join(legacyWorkspace, ".gsb-local", "agents.conf")), true);
      assert.equal(existsSync(path.join(legacyWorkspace, ".gsb-local", "prompts", "coder.md")), true);
      const healedSidecar = JSON.parse(readFileSync(path.join(legacyWorkspace, ".gsb-local", "workbench.json"), "utf8"));
      assert.equal("agent" in healedSidecar.roles[0], false);
      assert.equal("prompt" in healedSidecar.roles[0], false);
    });

    await t.test("saving a reduced roster removes all stale role prompts", async () => {
      const cleanupWorkspace = path.join(workspace, "cleanup-project");
      mkdirSync(cleanupWorkspace);
      const expanded = fixture(cleanupWorkspace);
      for (let index = 1; index <= 4; index++) {
        expanded.roles.push({
          id: `extra-${index}`,
          name: `Extra ${index}`,
          type: "specialist",
          description: "temporary",
          agent: "shell:printf extra",
          model: "",
          promptTemplate: "generic",
          prompt: `Extra ${index} prompt.`,
        });
      }
      const expandedSave = await request("/api/save", { method: "POST", body: JSON.stringify({ workbench: expanded }) });
      assert.equal(expandedSave.status, 200, await expandedSave.text());
      const promptDirectory = path.join(cleanupWorkspace, ".gsb-local", "prompts");
      writeFileSync(path.join(promptDirectory, "hub.md"), "legacy\n");

      const reduced = { ...expanded, roles: [expanded.roles[0]] };
      const reducedSave = await request("/api/save", { method: "POST", body: JSON.stringify({ workbench: reduced }) });
      assert.equal(reducedSave.status, 200, await reducedSave.text());
      for (const role of expanded.roles.slice(1)) {
        assert.equal(existsSync(path.join(promptDirectory, `${role.id}.md`)), false);
      }
      assert.equal(existsSync(path.join(promptDirectory, "hub.md")), false);
      assert.equal(existsSync(path.join(promptDirectory, "hub-extension.md")), true);
    });

    const projectLoad = await request("/api/project", { method: "POST", body: JSON.stringify({ workspace }) });
    assert.equal(projectLoad.status, 200);
    const projectPayload = await projectLoad.json();
    assert.equal(projectPayload.workbench.name, "Studio test");
    assert.equal(projectPayload.workbench.session, "studio-test");

    const cli = spawnSync(path.join(ROOT_DIR, "gsb"), ["--print-config", workspace, "studio-test"], { encoding: "utf8", env: testEnv() });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /hub:\s+shell:printf hub\s+model=glm-test/);
    assert.match(cli.stdout, /coder:\s+shell:printf coder\s+model=codex-test/);

    const runtime = spawnSync(path.join(ROOT_DIR, "bin", "run-agent"), ["hub"], {
      encoding: "utf8",
      env: testEnv({
        GSB_LOCAL_ROOT: ROOT_DIR,
        GSB_WORKSPACE: workspace,
        GSB_STATE_DIR: path.join(workspace, ".state"),
        GSB_SESSION: "studio-test",
        GSB_ROLES: "hub,coder",
        GSB_HUB_AGENT: 'shell:printf "%s" "$GSB_ROLE_PROMPT"',
      }),
    });
    assert.equal(runtime.status, 0, runtime.stderr);
    assert.match(runtime.stdout, /immutable Hub core/);
    assert.match(runtime.stdout, /Additive Hub capability extension/);
    assert.match(runtime.stdout, /Coordinate only\./);

    await t.test("named project APIs normalize old recents and reject global duplicates", async () => {
      const first = path.join(workspace, "named-one");
      const second = path.join(workspace, "named-two");
      mkdirSync(first);
      mkdirSync(second);
      const recentFile = path.join(process.env.GSB_STUDIO_CONFIG_HOME, "recent-projects.json");
      mkdirSync(path.dirname(recentFile), { recursive: true });
      writeFileSync(recentFile, `${JSON.stringify([second])}\n`);
      const resources = await request("/api/resources");
      assert.ok((await resources.json()).recentProjects.some((item) => item.path === second && item.name === "named-two"));

      const draftResponse = await request("/api/project", {
        method: "POST",
        body: JSON.stringify({ workspace: first, name: "shared-name", create: true, remember: false }),
      });
      const draftPayload = await draftResponse.json();
      assert.equal(draftResponse.status, 200, JSON.stringify(draftPayload));
      const draft = draftPayload.workbench;
      assert.equal(draft.projectName, "shared-name");
      assert.equal(draft.session, "shared-name");
      const namedSave = await request("/api/save", { method: "POST", body: JSON.stringify({ workbench: draft }) });
      assert.equal(namedSave.status, 200, await namedSave.text());
      assert.equal(typeof JSON.parse(readFileSync(recentFile, "utf8"))[0], "object");
      const namedCli = spawnSync(path.join(ROOT_DIR, "gsb"), ["--print-config", first, "shared-name"], { encoding: "utf8", env: testEnv() });
      assert.equal(namedCli.status, 0, namedCli.stderr);
      assert.ok(namedCli.stdout.includes(path.join(first, ".gsb-local", "projects", "shared-name", "agents.conf")));

      const siblingResponse = await request("/api/project", {
        method: "POST",
        body: JSON.stringify({ workspace: first, name: "sibling", create: true, remember: false }),
      });
      const sibling = (await siblingResponse.json()).workbench;
      assert.equal(siblingResponse.status, 200);
      assert.equal((await request("/api/save", { method: "POST", body: JSON.stringify({ workbench: sibling }) })).status, 200);
      const listed = await request(`/api/resources?project=${encodeURIComponent(first)}&name=shared-name`);
      assert.deepEqual((await listed.json()).projectOptions.filter((item) => item.path === first).map((item) => item.name).sort(), ["shared-name", "sibling"]);

      const duplicate = await request("/api/project", {
        method: "POST",
        body: JSON.stringify({ workspace: second, name: "shared-name", create: true, remember: false }),
      });
      assert.equal(duplicate.status, 400);
      assert.match((await duplicate.json()).error, /全局唯一/);
    });

    const minimalTemplate = fixture(workspace);
    minimalTemplate.name = "_Release / 前端（Kimi）🚀";
    minimalTemplate.roles = [minimalTemplate.roles[0]];
    minimalTemplate.roles[0].prompt = "";
    const createTemplate = await request("/api/templates", {
      method: "POST",
      body: JSON.stringify({ name: minimalTemplate.name, workbench: minimalTemplate }),
    });
    assert.equal(createTemplate.status, 200);
    const templatePayload = await createTemplate.json();
    assert.equal(templatePayload.template.id, "template-_release-kimi");
    assert.equal(templatePayload.template.roles.length, 1);
    assert.deepEqual(templatePayload.template.hubCore, { source: "builtin", locked: true, version: 1 });

    await t.test("new templates reject a slug collision from a different name", async () => {
      const collision = await request("/api/templates", {
        method: "POST",
        body: JSON.stringify({ name: "_Release Kimi", workbench: minimalTemplate }),
      });
      assert.equal(collision.status, 400);
      const payload = await collision.json();
      assert.match(payload.error, /已被.+使用，请换一个名称/);
      const original = JSON.parse(readFileSync(path.join(process.env.GSB_STUDIO_CONFIG_HOME, "templates", `${templatePayload.template.id}.json`), "utf8"));
      assert.equal(original.name, minimalTemplate.name);
    });

    const templateEdit = fixture(workspace);
    templateEdit.profile = `user:${templatePayload.template.id}`;
    const syncedSave = await request("/api/save", {
      method: "POST",
      body: JSON.stringify({ workbench: templateEdit }),
    });
    const syncedText = await syncedSave.text();
    assert.equal(syncedSave.status, 200, syncedText);
    const syncedPayload = JSON.parse(syncedText);
    assert.equal(syncedPayload.templateUpdated.id, templatePayload.template.id);
    assert.equal(syncedPayload.templateUpdated.name, minimalTemplate.name);
    assert.deepEqual(syncedPayload.templateUpdated.roles.map((role) => role.id), ["hub", "coder"]);

    const refreshed = await request("/api/bootstrap");
    const refreshedPayload = await refreshed.json();
    assert.ok(refreshedPayload.userTemplates.some((template) => template.name === "_Release / 前端（Kimi）🚀"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousStateHome === undefined) delete process.env.GSB_STUDIO_STATE_HOME;
    else process.env.GSB_STUDIO_STATE_HOME = previousStateHome;
    if (previousConfigHome === undefined) delete process.env.GSB_STUDIO_CONFIG_HOME;
    else process.env.GSB_STUDIO_CONFIG_HOME = previousConfigHome;
    rmSync(workspace, { recursive: true, force: true });
  }
});
