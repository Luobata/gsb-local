#!/usr/bin/env node

import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  composeRolePrompt,
  listStoredProjects,
  loadProjectState as loadStoredProjectState,
  parseRoleMap,
  PROMPT_INTENT_MARKER,
  saveProjectState as saveStoredProjectState,
  serializeAgents,
  serializeModels,
  serializeWorkbenchSidecar,
} from "./store.mjs";

export { parseRoleMap, serializeAgents, serializeModels } from "./store.mjs";

const STUDIO_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.dirname(STUDIO_DIR);
const PUBLIC_DIR = path.join(STUDIO_DIR, "public");
const ROLE_PATTERN = /^[a-z][a-z0-9-]*$/;
const SESSION_PATTERN = /^[A-Za-z0-9._-]+$/;
const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const STUDIO_API_VERSION = 2;
const SPAWN_TIMEOUT_MS = 5_000;
const INTERACTIVE_COMMAND_TIMEOUT_MS = 8_000;
const COMMAND_NEGATIVE_TTL_MS = 30_000;
const SESSION_LIST_TTL_MS = 30_000;
const COMMAND_RESULT_MARKER = "__GSB_STUDIO_COMMAND__";
const DEFAULT_CONFIG_HOME = path.join(os.homedir(), ".config", "gsb-local", "studio");

function configHome() {
  return process.env.GSB_STUDIO_CONFIG_HOME || DEFAULT_CONFIG_HOME;
}

const ROLE_DEFINITIONS = {
  hub: { name: "Hub", type: "orchestrator", description: "目标澄清、任务拆解、分发、冲突处理与最终汇总" },
  coder: { name: "Coder", type: "executor", description: "默认生产实现、测试与验证" },
  "core-bug": { name: "Core Bug", type: "specialist", description: "故障复现、根因定位和最小修复建议" },
  "ops-gov": { name: "Ops Gov", type: "governance", description: "权限、构建、依赖、CI、资源和上线风险" },
  "plan-backup": { name: "Plan Backup", type: "reviewer", description: "反证主方案，准备备选、回滚与覆盖计划" },
  ui: { name: "UI", type: "specialist", description: "产品设计、交互、视觉、响应式、可访问性和 UI 实现" },
  frontend: { name: "Frontend", type: "specialist", description: "前端界面、交互、可访问性与浏览器验证" },
  backend: { name: "Backend", type: "specialist", description: "服务接口、数据路径、兼容性与运行可靠性" },
  test: { name: "Test", type: "reviewer", description: "测试设计、缺陷复现、回归验证与覆盖评估" },
  docs: { name: "Docs", type: "specialist", description: "技术文档、可执行示例、术语一致性与读者路径" },
  fe: { base: "frontend" },
  be: { base: "backend" },
  qa: { base: "test" },
  testing: { base: "test" },
  writer: { base: "docs" },
  documentation: { base: "docs" },
};

function canonicalRole(role) {
  return ROLE_DEFINITIONS[role]?.base || role;
}

function metadataForRole(role) {
  const definition = ROLE_DEFINITIONS[canonicalRole(role)];
  return definition?.name ? definition : {};
}

const roleMeta = Object.fromEntries(Object.keys(ROLE_DEFINITIONS)
  .map((role) => [role, metadataForRole(role)])
  .filter(([, metadata]) => metadata.name));
const roleBaseAliases = Object.fromEntries(Object.entries(ROLE_DEFINITIONS)
  .filter(([, definition]) => definition.base)
  .map(([role, definition]) => [role, definition.base]));

const MODEL_SUGGESTIONS = [
  { family: "Codex", value: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  { family: "Kimi", value: "kimi-code/k3-256k", label: "Kimi K3 · 256K" },
  { family: "Kimi", value: "kimi-code/k3", label: "Kimi K3" },
  { family: "Claude", value: "opus", label: "Claude Opus alias" },
  { family: "Claude", value: "sonnet", label: "Claude Sonnet alias" },
];

export function parseArgs(argv) {
  const options = { project: "", port: 0, open: true };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--project") {
      options.project = argv[++index];
      if (!options.project) throw new Error("--project requires a path");
    }
    else if (arg === "--port") options.port = Number(argv[++index]);
    else if (arg === "--no-open") options.open = false;
    else if (arg === "--help") options.help = true;
    else throw new Error(`Unknown studio option: ${arg}`);
  }
  if (options.project) options.project = path.resolve(options.project);
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error("--port must be an integer from 0 to 65535");
  }
  return options;
}

function readText(file, fallback = "") {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return fallback;
  }
}

function atomicWrite(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, file);
}

function spawnResult(spawnImpl, command, args, options, timeout) {
  return new Promise((resolve) => {
    let child, timer;
    let stdout = "", stderr = "", settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, ...result });
    };
    try { child = spawnImpl(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { finish({ status: null, signal: null, error }); return; }
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => finish({ status: null, signal: null, error }));
    child.once("close", (status, signal) => finish({ status, signal, error: null }));
    if (!settled) {
      timer = setTimeout(() => {
        child.kill?.("SIGTERM");
        const error = Object.assign(new Error(`command exceeded ${timeout}ms`), { code: "ETIMEDOUT" });
        finish({ status: null, signal: "SIGTERM", error });
      }, timeout);
      timer.unref?.();
    }
  });
}

export function commandCacheFile({ env = process.env, home = env.HOME || os.homedir() } = {}) {
  const root = env.GSB_STUDIO_STATE_HOME ? path.join(env.GSB_STUDIO_STATE_HOME, "cache")
    : path.join(env.XDG_CACHE_HOME || path.join(home, ".cache"), "gsb-local");
  return path.join(root, "command-cache.json");
}

function loadPromptTemplates() {
  return readdirSync(path.join(ROOT_DIR, "prompts"))
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => {
      const id = name.slice(0, -3);
      return { id, name: metadataForRole(id).name || id, body: readText(path.join(ROOT_DIR, "prompts", name)) };
    });
}

export function parseProfileHeader(content, id) {
  const comments = content.split(/\r?\n/)
    .map((line) => line.match(/^\s*#\s*(.*?)\s*$/)?.[1])
    .filter((line) => line !== undefined);
  const label = comments.find((line) => /^label\s*:/i.test(line))?.replace(/^label\s*:\s*/i, "").trim();
  const description = comments.find((line) => !/^label\s*:/i.test(line)) || "";
  return { name: label || id, description };
}

function loadProfiles() {
  return readdirSync(path.join(ROOT_DIR, "profiles"))
    .filter((name) => name.endsWith(".conf"))
    .sort()
    .map((name) => {
      const id = name.slice(0, -5);
      const content = readText(path.join(ROOT_DIR, "profiles", name));
      const header = parseProfileHeader(content, id);
      return {
        id,
        ...header,
        roles: parseRoleMap(content).map(({ id: role, value: agent }) => ({ role, agent })),
      };
    });
}

function readModelMap(directory) {
  const file = path.join(directory, "models.conf");
  if (!existsSync(file)) return new Map();
  return new Map(parseRoleMap(readText(file)).map(({ id, value }) => [id, value]));
}

function codexDefaultModel() {
  const config = readText(path.join(os.homedir(), ".codex", "config.toml"));
  return config.match(/^model\s*=\s*"([^"]+)"/m)?.[1] || "gpt-5.6-sol";
}

function inferredModel(agent) {
  if (agent === "codex" || agent.startsWith("codex:")) return codexDefaultModel();
  if (agent === "kimi" || agent.startsWith("kimi:")) return "kimi-code/k3-256k";
  return "";
}

function normalizeHubExtension(value) {
  const prompt = typeof value === "string" ? value : "";
  const looksLikeLegacyCore = prompt.includes("Your responsibilities:")
    && prompt.includes("write a complete five-section contract")
    && prompt.includes("Do not claim that a Spoke has completed work");
  return looksLikeLegacyCore ? "" : prompt;
}

function templateOriginFor(workbench) {
  const explicit = workbench?.templateOrigin;
  if (explicit && PROFILE_PATTERN.test(explicit.id || "")) {
    return { id: explicit.id, version: Number.isInteger(explicit.version) ? explicit.version : "unknown" };
  }
  const inferred = typeof workbench?.profile === "string" ? workbench.profile.match(/^user:([A-Za-z0-9][A-Za-z0-9._-]*)$/) : null;
  return inferred ? { id: inferred[1], version: "unknown" } : null;
}

function normalizeWorkbench(workbench) {
  if (!workbench || typeof workbench !== "object") return workbench;
  const templateOrigin = templateOriginFor(workbench);
  return {
    ...workbench,
    ...(templateOrigin ? { templateOrigin } : {}),
    hubCore: { source: "builtin", locked: true, version: 1 },
    roles: Array.isArray(workbench.roles) ? workbench.roles.map((role) => role?.id === "hub" ? {
      ...role,
      promptTemplate: "",
      prompt: normalizeHubExtension(role.prompt),
    } : role) : workbench.roles,
  };
}

function promptLayers(body, { source, template }) {
  const content = typeof body === "string" ? body : "";
  const marker = content.indexOf(PROMPT_INTENT_MARKER);
  if (marker >= 0) {
    return {
      template,
      body: content,
      source,
      promptBase: content.slice(0, marker).trim(),
      intent: content.slice(marker + PROMPT_INTENT_MARKER.length).trim(),
      promptMode: "layered",
    };
  }
  if (source === "project") {
    return { template, body: content, source, promptBase: "", intent: "", promptMode: "custom" };
  }
  return { template, body: content, source, promptBase: content.trim(), intent: "", promptMode: "layered" };
}

function roleBaseTemplate(role, promptTemplates) {
  const template = canonicalRole(role);
  return promptTemplates.find((prompt) => prompt.id === template)
    || promptTemplates.find((prompt) => prompt.id === "generic");
}

function roleBase(role, promptTemplates) {
  const builtin = roleBaseTemplate(role, promptTemplates);
  return builtin?.body?.trim() || `You are the ${role} Spoke. Apply the most relevant domain method and produce a concrete, verified result.`;
}

function prepareWorkbenchPrompts(workbench, promptTemplates = loadPromptTemplates()) {
  return {
    ...workbench,
    roles: (workbench.roles || []).map((role) => {
      if (role.id === "hub") return role;
      if (role.promptMode === "custom" && typeof role.prompt === "string" && role.prompt.trim()) return role;
      if (role.promptMode !== "layered" && typeof role.prompt === "string" && role.prompt.trim()) {
        return { ...role, promptMode: "custom", promptBase: "", intent: "" };
      }
      const promptBase = typeof role.promptBase === "string" && role.promptBase.trim()
        ? role.promptBase.trim()
        : roleBase(role.id, promptTemplates);
      const layered = { ...role, promptMode: "layered", promptBase, intent: (role.intent || "").trim() };
      return { ...layered, prompt: composeRolePrompt(layered) };
    }),
  };
}

function promptForRole(directory, role, promptTemplates) {
  const projectPrompt = path.join(directory, "prompts", `${role}.md`);
  if (role === "hub") {
    const extension = path.join(directory, "prompts", "hub-extension.md");
    const source = existsSync(extension) ? extension : projectPrompt;
    return {
      template: "",
      body: existsSync(source) ? normalizeHubExtension(readText(source)) : "",
      source: existsSync(source) ? "project-extension" : "builtin-core-only",
    };
  }
  if (existsSync(projectPrompt)) return promptLayers(readText(projectPrompt), { template: role, source: "project" });
  const builtin = roleBaseTemplate(role, promptTemplates);
  if (builtin) return promptLayers(builtin.body, { template: builtin.id, source: builtin.id === role ? "builtin" : "builtin-fallback" });
  return promptLayers(roleBase(role, promptTemplates), { template: "", source: "generated" });
}

function defaultSession(workspace, name = "") {
  if (SESSION_PATTERN.test(name)) return name;
  const basename = path.basename(workspace);
  return SESSION_PATTERN.test(basename) ? basename : "seed-gsb";
}

function defaultWorkbench(workspace, projectName, directory, profile, promptTemplates) {
  const projectAgents = path.join(directory, "agents.conf");
  const mappings = existsSync(projectAgents)
    ? parseRoleMap(readText(projectAgents)).map(({ id: role, value: agent }) => ({ role, agent }))
    : profile.roles;
  const models = readModelMap(directory);
  return normalizeWorkbench({
    version: 1,
    projectName,
    name: projectName || `${path.basename(workspace)} workbench`,
    profile: profile.id,
    workspace,
    session: defaultSession(workspace, projectName),
    permission: "balanced",
    watchdog: true,
    rebuild: false,
    roles: mappings.map(({ role, agent }) => {
      const prompt = promptForRole(directory, role, promptTemplates);
      return {
        id: role,
        name: metadataForRole(role).name || role,
        type: metadataForRole(role).type || "specialist",
        description: metadataForRole(role).description || "自定义协作角色",
        agent,
        model: models.get(role) || inferredModel(agent),
        promptTemplate: prompt.template,
        prompt: prompt.body,
        promptBase: prompt.promptBase,
        intent: prompt.intent,
        promptMode: prompt.promptMode,
      };
    }),
  });
}

export function validateWorkbench(input) {
  const errors = [];
  const warnings = [];
  const workbench = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  if (typeof workbench.workspace !== "string" || !path.isAbsolute(workbench.workspace)) errors.push("项目路径必须是绝对路径");
  else if (!existsSync(workbench.workspace)) errors.push("项目路径不存在");
  else {
    try {
      if (!statSync(workbench.workspace).isDirectory()) errors.push("项目路径不是目录");
    } catch {
      errors.push("无法检查项目路径");
    }
  }
  const projectName = typeof workbench.projectName === "string" && workbench.projectName ? workbench.projectName : workbench.session;
  if (typeof projectName !== "string" || !SESSION_PATTERN.test(projectName)) errors.push("项目名只能包含字母、数字、点、下划线和连字符");
  if (typeof workbench.session !== "string" || !SESSION_PATTERN.test(workbench.session)) errors.push("会话名只能包含字母、数字、点、下划线和连字符");
  else if (SESSION_PATTERN.test(projectName || "") && workbench.session !== projectName) errors.push("会话名必须与项目名一致");
  if (!Array.isArray(workbench.roles) || !workbench.roles.length) errors.push("至少需要一个角色");
  const seen = new Set();
  for (const [index, role] of (workbench.roles || []).entries()) {
    if (!role || typeof role !== "object") {
      errors.push(`第 ${index + 1} 个角色配置无效`);
      continue;
    }
    if (!ROLE_PATTERN.test(role.id || "")) errors.push(`角色 ID 无效：${role.id || `<第 ${index + 1} 项>`}`);
    else if (seen.has(role.id)) errors.push(`角色重复：${role.id}`);
    else seen.add(role.id);
    if (typeof role.agent !== "string" || !role.agent.trim()) errors.push(`角色 ${role.id || index + 1} 缺少 Agent`);
    else if (CONTROL_PATTERN.test(role.agent)) errors.push(`角色 ${role.id || index + 1} 的 Agent 不能包含换行或控制字符`);
    else if (/^(claude|codex|kimi|shell):\s*$/.test(role.agent)) errors.push(`角色 ${role.id || index + 1} 的 Agent 冒号后必须提供命令`);
    if (role.model != null && typeof role.model !== "string") errors.push(`角色 ${role.id || index + 1} 的模型必须是文本`);
    else if (CONTROL_PATTERN.test(role.model || "")) errors.push(`角色 ${role.id || index + 1} 的模型不能包含换行或控制字符`);
  }
  const hubCount = (workbench.roles || []).filter((role) => role?.id === "hub").length;
  if (hubCount !== 1) errors.push("每个模板必须且只能包含一个 hub 角色");
  if (!seen.has("coder")) warnings.push("没有 coder：生产实现可能重新落回 Hub");
  const hub = (workbench.roles || []).find((role) => role.id === "hub");
  if (hub && hub.agent !== "claude-glm-5.3") warnings.push("Hub 未使用当前推荐的 claude-glm-5.3");
  if (workbench.permission === "full-access") warnings.push("Full Access 会绕过内置 Agent 的常规审批与沙箱保护");
  return { valid: errors.length === 0, errors, warnings };
}

function commandForAgent(agent) {
  if (agent === "claude" || agent === "codex" || agent === "kimi") return agent;
  if (/^(claude|codex|kimi):/.test(agent)) return agent.slice(agent.indexOf(":") + 1).trim();
  if (agent.startsWith("shell:")) return null;
  return agent;
}

export function createRuntimeValidator({
  spawnImpl = spawn,
  spawnSyncImpl = spawnSync,
  now = Date.now,
  env = process.env,
  home = env.HOME || os.homedir(),
  statImpl = statSync,
  atomicWriteImpl = atomicWrite,
  cacheFile,
  hasZsh = existsSync("/bin/zsh"),
  listSessionOptionsImpl = listSessionOptions,
} = {}) {
  const commandCache = new Map();
  const inFlight = new Map();
  let loadedFingerprint = null;
  let loadedCacheFile = null;

  function shellFingerprint() {
    // Indirect files sourced by these shell entrypoints are intentionally not
    // tracked: following arbitrary source/eval chains would require shell parsing.
    return [".zshrc", ".zshenv"].map((name) => {
      try {
        const stat = statImpl(path.join(home, name));
        return `${stat.mtimeMs}:${stat.size}`;
      } catch {
        return "missing";
      }
    }).join("|");
  }

  function persistentCacheFile() {
    return cacheFile === false ? "" : (cacheFile || commandCacheFile({ env, home }));
  }

  function ensurePersistentCache() {
    if (env.GSB_STUDIO_CMD_CACHE === "off") return;
    const file = persistentCacheFile();
    const fingerprint = shellFingerprint();
    if (loadedCacheFile === file && loadedFingerprint === fingerprint) return;
    commandCache.clear();
    loadedCacheFile = file;
    loadedFingerprint = fingerprint;
    if (!file) return;
    try {
      const stored = JSON.parse(readText(file, "{}"));
      if (stored.fingerprint !== fingerprint || !stored.commands || typeof stored.commands !== "object") return;
      for (const [command, available] of Object.entries(stored.commands)) {
        if (available === true) commandCache.set(command, { available: true, ts: now() });
      }
    } catch {
      // A missing or damaged cache is rebuilt by the next successful probe.
    }
  }

  function persistPositiveCommands() {
    const file = persistentCacheFile();
    if (!file || env.GSB_STUDIO_CMD_CACHE === "off") return;
    const commands = Object.fromEntries([...commandCache]
      .filter(([, cached]) => cached.available)
      .map(([command]) => [command, true]));
    try {
      atomicWriteImpl(file, `${JSON.stringify({ fingerprint: loadedFingerprint, commands }, null, 2)}\n`);
    } catch {
      // Persistent command caching is best-effort; the in-memory result remains valid.
    }
  }

  function cachedCommand(command) {
    if (env.GSB_STUDIO_CMD_CACHE === "off") return null;
    ensurePersistentCache();
    const cached = commandCache.get(command);
    if (!cached) return null;
    if (cached.available || now() - cached.ts < COMMAND_NEGATIVE_TTL_MS) {
      return { available: cached.available, uncertain: false };
    }
    commandCache.delete(command);
    return null;
  }

  function cacheCommand(command, available) {
    if (env.GSB_STUDIO_CMD_CACHE === "off") return;
    ensurePersistentCache();
    commandCache.set(command, { available, ts: now() });
    if (available) persistPositiveCommands();
  }

  function runProcess(command, args, options, timeout) {
    if (env.GSB_STUDIO_VALIDATE_SYNC === "1") {
      return Promise.resolve(spawnSyncImpl(command, args, { ...options, timeout }));
    }
    return spawnResult(spawnImpl, command, args, options, timeout);
  }

  async function precheckCommand(command) {
    const checked = await runProcess("/bin/sh", [
      "-c",
      'command -v "$1" >/dev/null 2>&1',
      "gsb-studio",
      command,
    ], {}, SPAWN_TIMEOUT_MS);
    return checked.status === 0;
  }

  async function interactiveCommandResults(commands) {
    if (!commands.length) return new Map();
    const lookup = hasZsh ? 'whence -w -- "$command"' : 'command -v "$command"';
    const script = `for command in "$@"; do if ${lookup} >/dev/null 2>&1; then printf '${COMMAND_RESULT_MARKER}1\\n'; else printf '${COMMAND_RESULT_MARKER}0\\n'; fi; done`;
    const checked = await runProcess(hasZsh ? "/bin/zsh" : "/bin/sh", [
      hasZsh ? "-ic" : "-c",
      script,
      "gsb-studio",
      ...commands,
    ], {}, INTERACTIVE_COMMAND_TIMEOUT_MS);
    if (checked.error || checked.signal) {
      const reason = checked.error?.code === "ETIMEDOUT" ? "检查超时" : "检查失败";
      return new Map(commands.map((command) => [command, { available: false, uncertain: true, reason }]));
    }
    if (checked.status !== 0) {
      return new Map(commands.map((command) => [command, { available: false, uncertain: false }]));
    }
    const matches = [...String(checked.stdout || "").matchAll(new RegExp(`^${COMMAND_RESULT_MARKER}([01])$`, "gm"))];
    return new Map(commands.map((command, index) => {
      const match = matches[index];
      return [command, match
        ? { available: match[1] === "1", uncertain: false }
        : { available: false, uncertain: true, reason: "检查失败" }];
    }));
  }

  async function probeCommands(commands) {
    const results = new Map();
    const interactive = [];
    const prechecked = await Promise.all(commands.map(async (command) => [command, await precheckCommand(command)]));
    for (const [command, availableOnPath] of prechecked) {
      if (availableOnPath) {
        const available = { available: true, uncertain: false };
        cacheCommand(command, true);
        results.set(command, available);
      } else {
        interactive.push(command);
      }
    }
    for (const [command, checked] of await interactiveCommandResults(interactive)) {
      if (!checked.uncertain) cacheCommand(command, checked.available);
      results.set(command, checked);
    }
    return results;
  }

  async function checkCommands(commands) {
    const unique = [...new Set(commands.filter(Boolean))];
    const results = new Map();
    const pending = new Map();
    const fresh = [];
    for (const command of unique) {
      const cached = cachedCommand(command);
      if (cached) results.set(command, cached);
      else if (env.GSB_STUDIO_CMD_CACHE !== "off" && inFlight.has(command)) pending.set(command, inFlight.get(command));
      else fresh.push(command);
    }
    if (fresh.length) {
      const batch = probeCommands(fresh);
      for (const command of fresh) {
        let promise = batch.then((checked) => checked.get(command));
        if (env.GSB_STUDIO_CMD_CACHE !== "off") {
          promise = promise.finally(() => {
            if (inFlight.get(command) === promise) inFlight.delete(command);
          });
          inFlight.set(command, promise);
        }
        pending.set(command, promise);
      }
    }
    await Promise.all([...pending].map(async ([command, promise]) => results.set(command, await promise)));
    return new Map(unique.map((command) => [command, results.get(command)]));
  }

  async function validate(workbench) {
    const result = validateWorkbench(workbench);
    await Promise.resolve();
    const roles = workbench?.roles || [];
    const roleCommands = roles.map((role) => ({
      role,
      command: commandForAgent(typeof role?.agent === "string" ? role.agent : ""),
    }));
    const commands = await checkCommands(roleCommands.map(({ command }) => command));
    for (const { role, command } of roleCommands) {
      if (!command) continue;
      const checked = commands.get(command);
      if (checked?.uncertain) {
        const message = `${role.id}: 无法确认命令 ${command}（${checked.reason}）；如已安装可继续启动`;
        (env.GSB_STUDIO_CHECK_STRICT === "on" ? result.errors : result.warnings).push(message);
      } else if (!checked?.available) {
        result.errors.push(`${role.id}: 找不到命令或 alias ${command}`);
      }
    }
    if (SESSION_PATTERN.test(workbench?.session || "")) {
      const existing = (await listSessionOptionsImpl()).find((session) => session.name === workbench.session);
      if (existing?.workspace && existing.workspace !== workbench.workspace) {
        result.errors.push(`会话 ${workbench.session} 属于另一项目 ${existing.workspace}；请更换会话名称，或用 gsb-local open ${workbench.session} 打开原会话`);
      } else if (existing?.status === "running" && !workbench.rebuild) {
        result.warnings.push(`会话 ${workbench.session} 已在运行；当前配置不会覆盖它。请勾选「重建同名会话」或更换会话名称`);
      }
    }
    result.valid = result.errors.length === 0;
    return result;
  }

  return { checkCommands, validate };
}

const runtimeValidator = createRuntimeValidator();

async function validationWithRuntime(workbench) {
  const result = await runtimeValidator.validate(workbench);
  const conflict = workbench?.projectName
    ? projectNameConflict(workbench.workspace, workbench.projectName)
    : "";
  if (conflict) result.errors.push(conflict);
  result.valid = result.errors.length === 0;
  return result;
}

function configPreview(workbench) {
  return {
    agents: serializeAgents(workbench),
    models: serializeModels(workbench),
    manifest: serializeWorkbenchSidecar(workbench),
  };
}

async function persistProjectState(workbench) {
  const normalized = prepareWorkbenchPrompts(normalizeWorkbench(workbench));
  const validation = await validationWithRuntime(normalized);
  if (!validation.valid) return { validation };
  saveStoredProjectState(normalized);
  rememberProject(normalized.workspace, normalized.projectName || normalized.session);
  const origin = templateOriginFor(normalized);
  const template = origin && loadUserTemplates().find((item) => item.id === origin.id);
  const templateOverwriteOffer = template ? {
    id: template.id,
    name: template.name,
    currentVersion: template.version,
    nextVersion: template.version + 1,
  } : null;
  return { validation, files: configPreview(normalized), templateOverwriteOffer };
}

function recentProjectsFile() {
  return path.join(configHome(), "recent-projects.json");
}

function normalizedProjectRef(value) {
  const projectPath = typeof value === "string" ? value : value?.path;
  if (typeof projectPath !== "string" || !path.isAbsolute(projectPath) || !existsSync(projectPath)) return null;
  const requestedName = typeof value === "object" ? value?.name : path.basename(projectPath);
  const name = SESSION_PATTERN.test(requestedName || "") ? requestedName : defaultSession(projectPath);
  return { path: projectPath, name };
}

function projectKey(project) {
  return `${project.path}\0${project.name}`;
}

function loadRecentProjects() {
  try {
    const rows = JSON.parse(readText(recentProjectsFile(), "[]"));
    if (!Array.isArray(rows)) return [];
    const seen = new Set();
    return rows.flatMap((item) => {
      const project = normalizedProjectRef(item);
      if (!project || seen.has(projectKey(project))) return [];
      seen.add(projectKey(project));
      return [project];
    }).slice(0, 12);
  } catch {
    return [];
  }
}

function rememberProject(projectPath, name) {
  const project = normalizedProjectRef({ path: projectPath, name });
  if (!project) return;
  const next = [project, ...loadRecentProjects().filter((item) => projectKey(item) !== projectKey(project))].slice(0, 12);
  atomicWrite(recentProjectsFile(), `${JSON.stringify(next, null, 2)}\n`);
}

function projectNameConflict(workspace, name, { creating = false } = {}) {
  if (typeof workspace !== "string" || !path.isAbsolute(workspace) || !SESSION_PATTERN.test(name || "")) return "";
  const sameProject = listStoredProjects(workspace).some((project) => project.name === name);
  if (creating && sameProject) return `项目名 ${name} 已在该目录中使用`;
  const known = [];
  const paths = new Set([workspace, ...loadRecentProjects().map((project) => project.path)]);
  for (const projectPath of paths) {
    const stored = listStoredProjects(projectPath);
    known.push(...(stored.length ? stored : loadRecentProjects().filter((project) => project.path === projectPath)));
  }
  const duplicate = known.find((project) => project.name === name && project.path !== workspace);
  if (duplicate) return `项目名 ${name} 已被 ${duplicate.path} 使用；项目名必须全局唯一`;
  if (!sameProject && existsSync(path.join(stateRoot(), name))) return `项目名 ${name} 与现存会话重名；请更换项目名`;
  return "";
}

function normalizeTemplateName(name) {
  const source = String(name || "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!source) throw new Error("模板名称不能为空");
  return source;
}

function templateSlug(name) {
  const source = normalizeTemplateName(name);
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 10);
  let slug = source
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) slug = `template-${digest}`;
  else if (!PROFILE_PATTERN.test(slug)) slug = `template-${slug}`;
  if (slug.length > 72) slug = `${slug.slice(0, 58).replace(/[._-]+$/g, "")}-${digest}`;
  return slug;
}

function loadUserTemplates() {
  const directory = path.join(configHome(), "templates");
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .flatMap((name) => {
      try {
        const template = JSON.parse(readText(path.join(directory, name)));
        return [{ ...template, id: name.slice(0, -5), version: Number.isInteger(template.version) ? template.version : 0 }];
      } catch {
        return [];
      }
    });
}

function saveTemplate(name, workbench, preferredId = "") {
  const normalizedName = normalizeTemplateName(name);
  const slug = preferredId && PROFILE_PATTERN.test(preferredId) ? preferredId : templateSlug(normalizedName);
  const normalized = normalizeWorkbench(workbench);
  const validation = validateWorkbench(normalized);
  const relevantErrors = validation.errors.filter((error) => !error.startsWith("项目路径"));
  if (relevantErrors.length) throw new Error(relevantErrors.join("；"));
  const file = path.join(configHome(), "templates", `${slug}.json`);
  let existing = null;
  if (existsSync(file)) {
    try { existing = JSON.parse(readText(file)); } catch { /* handled as a collision below */ }
  }
  const template = {
    name: normalizedName,
    version: Number.isInteger(existing?.version) ? existing.version + 1 : 1,
    hubCore: normalized.hubCore,
    permission: normalized.permission,
    watchdog: normalized.watchdog,
    roles: normalized.roles,
    savedAt: new Date().toISOString(),
  };
  if (!preferredId && existsSync(file)) {
    if (existing?.name !== normalizedName) {
      const error = new Error(`模板标识 ${slug} 已被「${existing?.name || "未知模板"}」使用，请换一个名称`);
      error.statusCode = 400;
      throw error;
    }
  }
  atomicWrite(file, `${JSON.stringify(template, null, 2)}\n`);
  return { id: slug, ...template };
}

function rolePromptBase(role) {
  return String(role?.id === "hub" ? role.prompt || "" : role.promptBase || role.prompt || "").trim();
}

function templateDiff(before, after) {
  const changes = [];
  const add = (label, left, right, preserve = false) => {
    if (JSON.stringify(left) !== JSON.stringify(right)) changes.push({ label, before: String(left ?? "—"), after: String(right ?? "—"), preserve });
  };
  add("permission", before?.permission, after.permission);
  add("watchdog", before?.watchdog, after.watchdog);
  const oldRoles = new Map((before?.roles || []).map((role) => [role.id, role]));
  const newRoles = new Map((after.roles || []).map((role) => [role.id, role]));
  for (const id of oldRoles.keys()) if (!newRoles.has(id)) changes.push({ label: `移除角色 ${id}`, before: "存在", after: "移除" });
  for (const [id, role] of newRoles) {
    const old = oldRoles.get(id);
    if (!old) { changes.push({ label: `新增角色 ${id}`, before: "—", after: role.agent || "已添加" }); continue; }
    add(`${id} · agent`, old.agent, role.agent);
    add(`${id} · model`, old.model, role.model);
    add(`${id} · prompt base`, rolePromptBase(old), rolePromptBase(role));
    add(`${id} · intent（保留项目自定义）`, old.intent, role.intent, true);
  }
  return changes;
}

export function projectsUsingTemplate(templateId, extraWorkspaces = []) {
  const projects = [];
  const seen = new Set();
  const workspaces = new Set([...extraWorkspaces, ...loadRecentProjects().map((project) => project.path)]);
  for (const workspace of workspaces) {
    if (!workspace || !existsSync(workspace)) continue;
    for (const stored of listStoredProjects(workspace)) {
      const key = projectKey(stored);
      if (seen.has(key)) continue;
      try {
        const workbench = loadProjectState(stored.path, stored.name);
        const origin = templateOriginFor(workbench);
        if (origin?.id !== templateId) continue;
        seen.add(key);
        projects.push({ path: stored.path, name: stored.name, originVersion: origin.version, legacy: stored.legacy });
      } catch { /* Ignore unreadable projects; they cannot be safely upgraded. */ }
    }
  }
  return projects;
}

function workbenchWithTemplate(project, template) {
  const currentRoles = new Map((project.roles || []).map((role) => [role.id, role]));
  const roles = (template.roles || []).map((role) => {
    if (role.id === "hub") return { ...role };
    const layered = {
      ...role,
      promptMode: "layered",
      promptBase: rolePromptBase(role),
      intent: currentRoles.get(role.id)?.intent || "",
    };
    return { ...layered, prompt: composeRolePrompt(layered) };
  });
  return prepareWorkbenchPrompts(normalizeWorkbench({
    ...project,
    profile: `user:${template.id}`,
    templateOrigin: { id: template.id, version: template.version },
    permission: template.permission,
    watchdog: template.watchdog,
    roles,
  }));
}

export function applyTemplateUpgrade(templateId, selectedProjects) {
  const template = loadUserTemplates().find((item) => item.id === templateId);
  if (!template) throw requestError("模板不存在");
  const candidates = new Map(projectsUsingTemplate(templateId, (selectedProjects || []).map((project) => project?.path)).map((project) => [projectKey(project), project]));
  const requested = [...new Map((selectedProjects || []).map((project) => [projectKey(project), project])).keys()];
  const selected = requested.map((key) => candidates.get(key)).filter(Boolean);
  if (selected.length !== requested.length) throw requestError("部分项目已不再使用该模板，请重新打开升级清单");
  const changes = selected.map((project) => {
    const before = loadProjectState(project.path, project.name);
    const after = workbenchWithTemplate(before, template);
    const validation = validateWorkbench(after);
    if (!validation.valid) throw requestError(`${project.name} 无法升级：${validation.errors.join("；")}`);
    return { project, before, after };
  });
  const touched = [];
  try {
    for (const change of changes) {
      touched.push(change);
      saveStoredProjectState(change.after);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const change of touched.reverse()) {
      try { saveStoredProjectState(change.before); } catch (rollback) { rollbackErrors.push(rollback.message); }
    }
    throw new Error(rollbackErrors.length ? `模板升级失败且回滚不完整：${rollbackErrors.join("；")}` : `模板升级失败，已回滚：${error.message}`);
  }
  return { applied: selected, message: `已更新 ${selected.length} 个项目；变更将在项目下次重启/重建时生效` };
}

export function gsbSocketDir({ env = process.env, home = os.homedir() } = {}) {
  if (env.GSB_SOCKET_DIR_OVERRIDE) return env.GSB_SOCKET_DIR_OVERRIDE;
  return path.join(env.XDG_CACHE_HOME || path.join(home, ".cache"), "gsb-zsock");
}

export function defaultZellijSocketDir({ env = process.env, uid = process.getuid?.() ?? 0 } = {}) {
  return path.join(env.TMPDIR || os.tmpdir(), `zellij-${uid}`);
}

export function zellijSocketPathInfo(socketDir, session) {
  const socketPath = path.join(socketDir, "contract_version_1", session);
  const length = Buffer.byteLength(socketPath);
  return { path: socketPath, length, valid: length <= 103 };
}

function savedSessionSocketDirs() {
  const dirs = [];
  try {
    for (const entry of readdirSync(stateRoot(), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const match = readText(path.join(stateRoot(), entry.name, "session.env")).match(/^export ZELLIJ_SOCKET_DIR=(.+)$/m);
      if (match && !match[1].startsWith("$'")) dirs.push(match[1].replace(/\\(.)/g, "$1"));
    }
  } catch {
    // Sessions created before W12 legitimately have no saved socket directory.
  }
  return dirs;
}

const sessionListCache = new Map();

export function invalidateSessionCache(cache = sessionListCache) {
  cache.clear();
}

export function mergeSessionLines(outputs, dirs) {
  const selected = new Map();
  const observations = new Map();
  outputs.forEach((output, index) => {
    for (const line of output) {
      const name = line.split(/\s+/, 1)[0];
      const exited = /\bEXITED\b/.test(line);
      const observed = observations.get(name) || { sawRunning: false, sawExited: false };
      if (exited) observed.sawExited = true;
      else observed.sawRunning = true;
      observations.set(name, observed);
      const current = selected.get(name);
      if (!current || (current.exited && !exited)) {
        selected.set(name, { line, socketDir: dirs[index] || null, exited });
      }
    }
  });
  const byName = new Map([...selected].map(([name, value]) => {
    const observed = observations.get(name);
    return [name, {
      line: value.line,
      socketDir: value.socketDir,
      crossSocketExited: observed.sawRunning && observed.sawExited,
      exitedEverywhere: !observed.sawRunning,
    }];
  }));
  return { lines: [...selected.values()].map(({ line }) => line), byName };
}

function cloneSessionListing(listing) {
  return {
    lines: [...listing.lines],
    byName: new Map([...listing.byName].map(([name, value]) => [name, { ...value }])),
  };
}

export async function listSessionsDetailed({
  spawnImpl = spawn,
  spawnSyncImpl = spawnSync,
  env = process.env,
  home,
  uid,
  socketDirs,
  cache = sessionListCache,
  now = Date.now,
} = {}) {
  const unified = gsbSocketDir({ env, home });
  const legacy = defaultZellijSocketDir({ env, uid });
  const dirs = [...new Set(socketDirs || [unified, legacy, ...savedSessionSocketDirs()])];
  const cacheKey = JSON.stringify([dirs, env.GSB_STUDIO_VALIDATE_SYNC === "1"]);
  const cached = cache.get(cacheKey);
  if (cached?.value && now() < cached.expiresAt) return cloneSessionListing(cached.value);
  if (cached?.pending) return cloneSessionListing(await cached.pending);

  const pending = Promise.all(dirs.map(async (socketDir) => {
    const childEnv = { ...env };
    delete childEnv.ZELLIJ_SESSION_NAME;
    delete childEnv.ZELLIJ_SESSION_DIR;
    if (socketDir === legacy) delete childEnv.ZELLIJ_SOCKET_DIR;
    else childEnv.ZELLIJ_SOCKET_DIR = socketDir;
    const result = env.GSB_STUDIO_VALIDATE_SYNC === "1"
      ? spawnSyncImpl("zellij", ["list-sessions", "--no-formatting"], { encoding: "utf8", env: childEnv, timeout: SPAWN_TIMEOUT_MS })
      : await spawnResult(spawnImpl, "zellij", ["list-sessions", "--no-formatting"], { env: childEnv }, SPAWN_TIMEOUT_MS);
    return String(result.stdout || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  })).then((outputs) => mergeSessionLines(outputs, dirs));
  cache.set(cacheKey, { pending });
  try {
    const value = await pending;
    cache.set(cacheKey, { value, expiresAt: now() + SESSION_LIST_TTL_MS });
    return cloneSessionListing(value);
  } catch (error) {
    cache.delete(cacheKey);
    throw error;
  }
}

export async function listSessions(options = {}) {
  return (await listSessionsDetailed(options)).lines;
}

async function activeSessionLine(session) {
  return (await listSessions()).find((line) => line.split(/\s+/, 1)[0] === session && !/\bEXITED\b/.test(line));
}

function stateRoot() {
  return process.env.GSB_STUDIO_STATE_HOME
    || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "gsb-local");
}

function shortSocketDir(socketDir, home) {
  const prefix = `${home}${path.sep}`;
  return socketDir === home ? "~" : (socketDir.startsWith(prefix) ? `~/${socketDir.slice(prefix.length)}` : socketDir);
}

export function sessionSocketLabel(socketDir, { env = process.env, home = os.homedir(), uid } = {}) {
  if (!socketDir) return null;
  const display = shortSocketDir(socketDir, home);
  if (socketDir === gsbSocketDir({ env, home })) return `统一目录 (${display})`;
  if (socketDir === defaultZellijSocketDir({ env, uid })) return `默认目录 (${display})`;
  return display;
}

function shellWord(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:-]+$/.test(text) ? text : `'${text.replaceAll("'", `'"'"'`)}'`;
}

export function watchdogHeartbeatAgeMs(directory, now = Date.now()) {
  const match = readText(path.join(directory, "watchdog.heartbeat")).trim().match(/^\d+ (\d+) \d+$/);
  if (!match) return null;
  const timestampMs = Number(match[1]) * 1000;
  return Number.isSafeInteger(timestampMs) && timestampMs > 0 ? Math.max(0, now - timestampMs) : null;
}

export function sessionState(name, directory, liveLine = "", provenance = null, {
  env = process.env,
  home = os.homedir(),
  uid,
} = {}) {
  const roster = readText(path.join(directory, "ROLES.md"));
  const task = readText(path.join(directory, "TASK.md"));
  const workspace = roster.match(/^Workspace:\s*(.+)$/m)?.[1]?.trim()
    || task.match(/^Workspace:\s*(.+)$/m)?.[1]?.trim()
    || "";
  const roles = [...roster.matchAll(/^- ([a-z][a-z0-9-]*):/gm)].map((match) => match[1]);
  let updatedAt = 0;
  try {
    updatedAt = statSync(directory).mtimeMs;
  } catch {
    // A disappearing state directory is simply omitted from freshness sorting.
  }
  const status = liveLine ? (/\bEXITED\b/.test(liveLine) ? "exited" : "running") : "saved";
  const state = {
    name,
    status,
    workspace,
    roles,
    updatedAt,
    raw: liveLine,
  };
  if (env.GSB_STUDIO_SESSION_PROVENANCE !== "false") {
    const socketDir = provenance?.socketDir || null;
    state.socketDir = socketDir;
    state.socketLabel = sessionSocketLabel(socketDir, { env, home, uid });
    state.crossSocketExited = Boolean(provenance?.crossSocketExited);
    state.attachHint = socketDir && (status === "running" || state.crossSocketExited)
      ? `ZELLIJ_SOCKET_DIR=${shellWord(socketDir)} zellij attach ${name}`
      : null;
    state.watchdogHeartbeatMs = watchdogHeartbeatAgeMs(directory);
  }
  return state;
}

async function listSessionOptions() {
  const { lines: liveLines, byName: provenanceByName } = await listSessionsDetailed();
  const liveByName = new Map(liveLines.map((line) => [line.split(/\s+/, 1)[0], line]));
  const options = new Map();
  const root = stateRoot();
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "cache" || !SESSION_PATTERN.test(entry.name)) continue;
      options.set(entry.name, sessionState(
        entry.name,
        path.join(root, entry.name),
        liveByName.get(entry.name) || "",
        provenanceByName.get(entry.name),
      ));
    }
  } catch {
    // A first-time Studio user can legitimately have no GSB state directory.
  }
  for (const [name, line] of liveByName) {
    if (!SESSION_PATTERN.test(name) || options.has(name)) continue;
    options.set(name, sessionState(name, path.join(root, name), line, provenanceByName.get(name)));
  }
  const rank = { running: 0, exited: 1, saved: 2 };
  return [...options.values()].sort((left, right) => (
    rank[left.status] - rank[right.status]
    || right.updatedAt - left.updatedAt
    || left.name.localeCompare(right.name)
  ));
}

function listProjectOptions(currentProject, sessions) {
  const projects = [];
  const seen = new Set();
  const append = (project) => {
    const normalized = normalizedProjectRef(project);
    if (!normalized || seen.has(projectKey(normalized))) return;
    try {
      if (!statSync(normalized.path).isDirectory()) return;
    } catch {
      return;
    }
    seen.add(projectKey(normalized));
    projects.push(normalized);
  };
  const appendWorkspace = (project) => {
    const normalized = normalizedProjectRef(project);
    if (!normalized) return;
    const stored = listStoredProjects(normalized.path);
    if (stored.length) stored.forEach(append);
    else append(normalized);
  };
  if (currentProject) appendWorkspace(currentProject);
  loadRecentProjects().forEach(appendWorkspace);
  sessions.forEach((session) => session.workspace && appendWorkspace({ path: session.workspace, name: session.name }));
  return projects.map((project) => {
    const stored = listStoredProjects(project.path).find((candidate) => candidate.name === project.name);
    const related = sessions.filter((session) => session.workspace === project.path && session.name === project.name);
    return {
      ...project,
      configured: Boolean(stored && existsSync(path.join(stored.directory, "agents.conf"))),
      sessions: related.length,
      running: related.filter((session) => session.status === "running").length,
      legacy: stored?.legacy === true,
    };
  });
}

export function loadProjectState(workspace, name = "", profiles = loadProfiles(), prompts = loadPromptTemplates()) {
  return loadStoredProjectState(workspace, name, {
    profiles,
    prompts,
    roleMeta,
    roleBaseAliases,
    defaultWorkbench,
    promptForRole,
    normalizeWorkbench,
    validateWorkbench,
  });
}

async function bootstrap(project) {
  const profiles = loadProfiles();
  const prompts = loadPromptTemplates();
  const userTemplates = loadUserTemplates().map((template) => ({ ...template, ...normalizeWorkbench(template) }));
  const sessionOptions = await listSessionOptions();
  const recent = loadRecentProjects();
  const stored = project ? listStoredProjects(project) : [];
  const selected = project ? (recent.find((item) => item.path === project && stored.some((candidate) => candidate.name === item.name))
    || stored[0]
    || normalizedProjectRef(project)) : null;
  const recentProjects = selected ? [selected, ...recent.filter((item) => projectKey(item) !== projectKey(selected))] : recent;
  return {
    product: { name: "GSB Studio", version: 1, apiVersion: STUDIO_API_VERSION },
    platform: process.platform,
    profiles,
    prompts,
    roleMeta,
    roleBaseAliases,
    modelSuggestions: MODEL_SUGGESTIONS,
    recentProjects,
    userTemplates,
    sessions: sessionOptions.filter((session) => session.raw).map((session) => session.raw),
    sessionOptions,
    projectOptions: listProjectOptions(selected || project, sessionOptions),
    workbench: selected ? loadProjectState(selected.path, selected.name, profiles, prompts) : null,
  };
}

function requestError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

async function projectWorkbench(workspace, name = "", { remember = true, create = false } = {}) {
  if (typeof workspace !== "string" || !path.isAbsolute(workspace)) throw requestError("项目路径必须是绝对路径");
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) throw requestError("项目路径不存在或不是目录");
  if (name && !SESSION_PATTERN.test(name)) throw requestError("项目名只能包含字母、数字、点、下划线和连字符");
  if (create && !name) throw requestError("新建项目必须填写项目名");
  const conflict = name ? projectNameConflict(workspace, name, { creating: create }) : "";
  if (conflict) throw requestError(conflict);
  const profiles = loadProfiles();
  const prompts = loadPromptTemplates();
  const workbench = loadProjectState(workspace, name, profiles, prompts);
  if (remember) rememberProject(workspace, workbench.projectName || workbench.session);
  const sessionOptions = await listSessionOptions();
  return {
    workbench,
    sessionOptions,
    recentProjects: loadRecentProjects(),
    projectOptions: listProjectOptions({ path: workspace, name: workbench.projectName || workbench.session }, sessionOptions),
  };
}

async function runtimeResources(project) {
  const sessionOptions = await listSessionOptions();
  return {
    sessionOptions,
    recentProjects: loadRecentProjects(),
    projectOptions: listProjectOptions(project, sessionOptions),
  };
}

function jsonResponse(response, status, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("请求内容过大"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("JSON 格式无效"));
      }
    });
    request.on("error", reject);
  });
}

function staticFile(response, pathname) {
  const files = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/index.html": ["index.html", "text/html; charset=utf-8"],
    "/styles.css": ["styles.css", "text/css; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  };
  const entry = files[pathname];
  if (!entry) return false;
  const body = readFileSync(path.join(PUBLIC_DIR, entry[0]));
  response.writeHead(200, {
    "content-type": entry[1],
    "content-length": body.length,
    "cache-control": "no-store",
    "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
  return true;
}

function pickDirectory() {
  if (process.platform !== "darwin") throw new Error("当前平台请直接输入绝对项目路径");
  const result = spawnSync("osascript", ["-e", 'POSIX path of (choose folder with prompt "选择 GSB 项目目录")'], { encoding: "utf8", timeout: 10_000 });
  if (result.error?.code === "ETIMEDOUT") throw new Error("目录选择超时，请直接输入绝对项目路径");
  if (result.status !== 0) throw new Error("已取消目录选择");
  return result.stdout.trim().replace(/\/$/, "");
}

export function studioLaunchEnv(sourceEnv, watchdogEnabled) {
  const passthrough = sourceEnv.GSB_STUDIO_ENV_PASSTHROUGH === "1";
  const env = passthrough
    ? { ...sourceEnv }
    : Object.fromEntries(Object.entries(sourceEnv).filter(([name]) => !/^(GSB_|ZELLIJ_)/.test(name)));
  env.GSB_WATCHDOG_ENABLED = watchdogEnabled ? "true" : "false";
  return env;
}

export async function launchWorkbench(workbench, {
  spawnSyncImpl = spawnSync,
  sourceEnv = process.env,
  activeSessionLineImpl = activeSessionLine,
  invalidateSessionCacheImpl = invalidateSessionCache,
} = {}) {
  const saved = await persistProjectState(workbench);
  if (!saved.validation.valid) return { ...saved, launched: false };
  const args = ["--background"];
  if (workbench.rebuild) args.push("--rebuild");
  if (workbench.permission === "full-access") args.push("--full-access");
  args.push(workbench.workspace, workbench.session);
  const command = ["gsb-local", ...args].map((part) => (/^[A-Za-z0-9_./-]+$/.test(part) ? part : JSON.stringify(part))).join(" ");
  const openCommand = `gsb-local open ${workbench.session}`;
  const existing = await activeSessionLineImpl(workbench.session);
  if (existing && !workbench.rebuild) {
    return {
      ...saved,
      launched: false,
      command,
      openCommand,
      stdout: "",
      stderr: `同名 Zellij 会话已在运行：${workbench.session}\n请勾选「重建同名会话」以应用当前配置，或换一个会话名称以保留旧会话。\n`,
      status: 64,
      error: "当前配置没有启动：同名旧会话仍在运行",
    };
  }
  const env = studioLaunchEnv(sourceEnv, workbench.watchdog !== false);
  const result = spawnSyncImpl(path.join(ROOT_DIR, "gsb"), args, { encoding: "utf8", env, timeout: 45_000 });
  if (result.status === 0) invalidateSessionCacheImpl();
  return {
    ...saved,
    launched: result.status === 0,
    command,
    openCommand,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status,
  };
}

export function openTerminalSession(session, { platform = process.platform, spawnImpl = spawn } = {}) {
  if (typeof session !== "string" || !SESSION_PATTERN.test(session)) {
    const error = new Error("会话名只能包含字母、数字、点、下划线和连字符");
    error.statusCode = 400;
    throw error;
  }
  const command = `gsb-local open ${session}`;
  if (platform !== "darwin") return { command, opened: false };
  const script = `tell application "Terminal" to do script "${command}"`;
  const terminal = spawnImpl("osascript", ["-e", script], { detached: true, stdio: "ignore" });
  terminal.unref();
  return { command, opened: true };
}

export function createStudioServer({ project, token, platform = process.platform, terminalSpawner = spawn, validator = runtimeValidator }) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      if (!url.pathname.startsWith("/api/")) {
        if (!staticFile(response, url.pathname)) jsonResponse(response, 404, { error: "Not found" });
        return;
      }
      if (request.headers["x-gsb-token"] !== token) {
        jsonResponse(response, 403, { error: "Invalid Studio token" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/bootstrap") {
        jsonResponse(response, 200, await bootstrap(project));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/resources") {
        const requestedPath = url.searchParams.get("project") || project;
        const requestedProject = requestedPath ? { path: requestedPath, name: url.searchParams.get("name") || defaultSession(requestedPath) } : null;
        jsonResponse(response, 200, await runtimeResources(requestedProject));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/project") {
        const body = await readJson(request);
        jsonResponse(response, 200, await projectWorkbench(body.workspace, body.name || "", {
          remember: body.remember !== false,
          create: body.create === true,
        }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/validate") {
        const body = await readJson(request);
        jsonResponse(response, 200, { validation: await validator.validate(body.workbench), files: configPreview(body.workbench) });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/save") {
        const body = await readJson(request);
        const result = await persistProjectState(body.workbench);
        jsonResponse(response, result.validation.valid ? 200 : 422, result);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/launch") {
        const body = await readJson(request);
        const result = await launchWorkbench(body.workbench);
        jsonResponse(response, result.launched ? 200 : 422, result);
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/open-terminal") {
        const body = await readJson(request);
        jsonResponse(response, 200, openTerminalSession(body.session, { platform, spawnImpl: terminalSpawner }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/templates") {
        const body = await readJson(request);
        if (body.id && !PROFILE_PATTERN.test(body.id)) throw requestError("模板 ID 无效");
        const id = body.id || templateSlug(body.name);
        const before = loadUserTemplates().find((template) => template.id === id) || null;
        const template = saveTemplate(body.name, body.workbench, body.id || "");
        const projects = projectsUsingTemplate(template.id, [body.workbench?.workspace]);
        jsonResponse(response, 200, {
          template,
          templates: loadUserTemplates(),
          upgradePlan: projects.length ? {
            template: { id: template.id, name: template.name, fromVersion: before?.version ?? 0, toVersion: template.version },
            projects,
            diff: templateDiff(before, template),
          } : null,
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/template-upgrade") {
        const body = await readJson(request);
        jsonResponse(response, 200, applyTemplateUpgrade(body.templateId, body.projects));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/pick-directory") {
        jsonResponse(response, 200, { path: pickDirectory() });
        return;
      }
      jsonResponse(response, 404, { error: "Unknown API route" });
    } catch (error) {
      jsonResponse(response, Number.isInteger(error?.statusCode) ? error.statusCode : 500, { error: error?.message || String(error) });
    }
  });
}

export function warmupRuntimeCommands(validator = runtimeValidator) { return validator.checkCommands(["claude-glm-5.3", "claude-0812", "claude-relay", "codex", "claude", "kimi"]); }

function printHelp() {
  console.log(`Usage: gsb-local studio [--project PATH] [--port PORT] [--no-open]

Starts the local-only GSB Studio configuration UI. Port 0 chooses a free port.`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.project && !existsSync(options.project)) throw new Error(`Project does not exist: ${options.project}`);
  const token = randomBytes(24).toString("hex");
  const server = createStudioServer({ project: options.project, token });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", resolve);
  });
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/?token=${token}`;
  console.log(`GSB Studio: ${url}`);
  console.log("Only this local machine can connect. Press Ctrl-C to stop Studio; running Zellij sessions continue.");
  setImmediate(() => { warmupRuntimeCommands().catch(() => {}); listSessions().catch(() => {}); });
  if (options.open && process.platform === "darwin") {
    const opener = spawn("open", [url], { detached: true, stdio: "ignore" });
    opener.unref();
  }
}

function isMainModule(entry) {
  const source = fileURLToPath(import.meta.url);
  try { return realpathSync(entry) === realpathSync(source); } catch { return Boolean(entry) && path.resolve(entry) === source; }
}

if (isMainModule(process.argv[1])) {
  main().catch((error) => {
    console.error(`gsb-studio: ${error.message}`);
    process.exit(1);
  });
}
