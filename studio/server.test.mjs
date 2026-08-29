import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createRuntimeValidator,
  createStudioServer,
  loadProjectState,
  openTerminalSession,
  parseArgs,
  parseProfileHeader,
  parseRoleMap,
  serializeAgents,
  serializeModels,
  validateWorkbench,
} from "./server.mjs";
import { PROMPT_INTENT_MARKER, saveProjectState } from "./store.mjs";

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
    env: options.env || {},
    hasZsh: options.hasZsh ?? true,
    listSessionOptionsImpl: () => [],
  });
}

function interactiveOutput(...available) {
  return available.map((value) => `__GSB_STUDIO_COMMAND__${value ? 1 : 0}`).join("\n") + "\n";
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
  } finally {
    rmSync(workspace, { recursive: true, force: true });
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
    writeFileSync(fakeZellij, "#!/usr/bin/env bash\nif [[ \"$*\" == \"list-sessions --no-formatting\" ]]; then echo 'owned-session [Created now]'; exit 0; fi\nexit 99\n");
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

test("runtime command validation caches a repeated available command", () => {
  const calls = [];
  const validator = fakeRuntimeValidator((command, args) => {
    calls.push({ command, args });
    return { status: 0, signal: null, error: null };
  });
  assert.equal(validator.checkCommands(["codex"]).get("codex").available, true);
  assert.equal(validator.checkCommands(["codex"]).get("codex").available, true);
  assert.equal(calls.length, 1);
});

test("runtime command validation expires negative cache entries after 30 seconds", () => {
  let currentTime = 1_000;
  const calls = [];
  const validator = fakeRuntimeValidator((command) => {
    calls.push(command);
    return command === "/bin/zsh"
      ? { status: 0, signal: null, error: null, stdout: interactiveOutput(false) }
      : { status: 1, signal: null, error: null };
  }, { now: () => currentTime });
  assert.equal(validator.checkCommands(["missing-agent"]).get("missing-agent").available, false);
  assert.equal(calls.length, 2);
  currentTime += 29_999;
  assert.equal(validator.checkCommands(["missing-agent"]).get("missing-agent").available, false);
  assert.equal(calls.length, 2);
  currentTime += 2;
  assert.equal(validator.checkCommands(["missing-agent"]).get("missing-agent").available, false);
  assert.equal(calls.length, 4);
});

test("runtime command validation keeps positive cache entries across TTL periods", () => {
  let currentTime = 1_000;
  let calls = 0;
  const validator = fakeRuntimeValidator(() => {
    calls += 1;
    return { status: 0, signal: null, error: null };
  }, { now: () => currentTime });
  assert.equal(validator.checkCommands(["codex"]).get("codex").available, true);
  currentTime += 300_000;
  assert.equal(validator.checkCommands(["codex"]).get("codex").available, true);
  assert.equal(calls, 1);
});

test("runtime command timeout is a warning and does not invalidate the workbench", () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "gsb-studio-command-timeout-"));
  try {
    const validator = fakeRuntimeValidator((command) => command === "/bin/zsh"
      ? { status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT" } }
      : { status: 1, signal: null, error: null });
    const workbench = fixture(workspace);
    workbench.roles[0].agent = "slow-agent";
    const result = validator.validate(workbench);
    assert.equal(result.valid, true);
    assert.ok(result.warnings.some((message) => message.includes("slow-agent") && message.includes("检查超时")));
    assert.ok(!result.errors.some((message) => message.includes("slow-agent")));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("runtime command clean exit 1 is a not-found error", () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "gsb-studio-command-missing-"));
  try {
    const validator = fakeRuntimeValidator(() => ({ status: 1, signal: null, error: null }));
    const workbench = fixture(workspace);
    workbench.roles[0].agent = "missing-agent";
    const result = validator.validate(workbench);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((message) => message.includes("找不到命令或 alias missing-agent")));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("runtime command precheck avoids interactive shells when every command is available", () => {
  const calls = [];
  const validator = fakeRuntimeValidator((command, args) => {
    calls.push({ command, args });
    return { status: 0, signal: null, error: null };
  });
  const commands = ["claude", "codex", "kimi", "zellij"];
  assert.deepEqual([...validator.checkCommands(commands).values()].map(({ available }) => available), [true, true, true, true]);
  assert.equal(calls.filter(({ command }) => command === "/bin/zsh").length, 0);
  assert.equal(calls.filter(({ command }) => command === "/bin/sh").length, 4);
});

test("runtime command misses use one positional-argument interactive batch", () => {
  const calls = [];
  const commands = ["alias-one", "alias two", "$(unsafe)"];
  const validator = fakeRuntimeValidator((command, args) => {
    calls.push({ command, args });
    return command === "/bin/zsh"
      ? { status: 0, signal: null, error: null, stdout: interactiveOutput(true, false, true) }
      : { status: 1, signal: null, error: null };
  });
  const result = validator.checkCommands(commands);
  assert.deepEqual([...result.values()].map(({ available }) => available), [true, false, true]);
  const interactive = calls.filter(({ command }) => command === "/bin/zsh");
  assert.equal(interactive.length, 1);
  assert.deepEqual(interactive[0].args.slice(3), commands);
  assert.ok(commands.every((command) => !interactive[0].args[1].includes(command)));
});

test("runtime command rollback switches restore strict and uncached behavior", () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "gsb-studio-command-switches-"));
  try {
    const strictValidator = fakeRuntimeValidator((command) => command === "/bin/zsh"
      ? { status: null, signal: "SIGTERM", error: { code: "ETIMEDOUT" } }
      : { status: 1, signal: null, error: null }, { env: { GSB_STUDIO_CHECK_STRICT: "on" } });
    const workbench = fixture(workspace);
    workbench.roles[0].agent = "slow-agent";
    const strict = strictValidator.validate(workbench);
    assert.equal(strict.valid, false);
    assert.ok(strict.errors.some((message) => message.includes("slow-agent") && message.includes("检查超时")));

    let calls = 0;
    const uncachedValidator = fakeRuntimeValidator(() => {
      calls += 1;
      return { status: 0, signal: null, error: null };
    }, { env: { GSB_STUDIO_CMD_CACHE: "off" } });
    uncachedValidator.checkCommands(["codex"]);
    uncachedValidator.checkCommands(["codex"]);
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
  const server = createStudioServer({ project: workspace, token, platform: "linux" });
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
