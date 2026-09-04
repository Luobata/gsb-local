const token = new URLSearchParams(window.location.search).get("token") || "";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const clone = (value) => JSON.parse(JSON.stringify(value));

const sectionIds = ["sec-templates", "sec-roster", "sec-runtime", "sec-validation"];
const promptIntentMarker = "<!-- gsb:intent -->";

const hubCapabilitySnippets = {
  architecture: `## 架构决策能力

- 在分发前识别架构边界、依赖方向和高风险接口。
- 要求相关角色提供备选方案、取舍依据和迁移影响。
- 对跨模块决策形成明确结论并记录在任务板。`,
  quality: `## 质量门禁能力

- 为每个实施合同定义与风险匹配的验证证据。
- 在汇总前检查测试、静态分析和关键回归是否真实完成。
- 证据不足时不得宣称完成，必须重新派发验证或明确披露。`,
  delivery: `## 进度治理能力

- 维护任务依赖、阻塞项、负责人和可观察完成条件。
- 优先解除关键路径阻塞，避免向繁忙角色重复注入任务。
- 在里程碑处向用户汇报已完成、进行中和待决策事项。`,
  product: `## 产品判断能力

- 拆解任务时同时识别用户目标、体验约束和验收口径。
- 遇到技术可行但产品价值不清的方案时，要求补充影响分析。
- 最终汇总必须说明用户可感知变化、边界与剩余风险。`,
};

let bootstrap;
let workbench;
let currentRole = 0;
let previewKind = "agents";
let sessionFilter = "project";
let loadedWorkspace = "";
let loadedProjectKey = "";
let validationResult = null;
let previewFiles = { agents: "", models: "", manifest: "" };
let viewportRevision = 0;
let cleanWorkbenchFingerprint = "";
let cleanWorkbenchSnapshot = null;
let validatedWorkbenchFingerprint = "";
let validationTimer = null;
let validationRevision = 0;
let validationPending = false;
let launchPending = false;
let persistentError = "";
let detailView = null;
let detailReturnFocus = null;
let currentStep = 0;
let visitedSteps = new Set([0]);
const projectLaunchCache = new Map();
let landingNameTimer = null;
let pendingTemplateUpgrade = null;
let templateEditMode = null;

function projectRef(value) {
  if (typeof value === "string") return { path: value, name: value.split("/").filter(Boolean).at(-1) || value };
  return { path: value?.path || "", name: value?.name || "" };
}

function projectKey(value) {
  const project = projectRef(value);
  return `${project.path}\0${project.name}`;
}

function workbenchProject(value = workbench) {
  return { path: value?.workspace || "", name: value?.projectName || value?.session || "" };
}

function updateInPlace(update) {
  const left = window.scrollX;
  const top = window.scrollY;
  const revision = ++viewportRevision;
  update();
  const restore = () => {
    if (revision !== viewportRevision) return;
    window.scrollTo({ left, top, behavior: "auto" });
  };
  restore();
  requestAnimationFrame(() => requestAnimationFrame(restore));
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-gsb-token": token,
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) {
    const error = new Error(payload.error || payload.validation?.errors?.join("；") || `HTTP ${response.status}`);
    error.payload = payload;
    throw error;
  }
  return payload;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function toast(message, kind = "info") {
  const node = element("div", `toast${kind === "error" ? " error" : ""}`, message);
  if (kind === "error") {
    node.setAttribute("role", "alert");
    const close = element("button", "text-button", "关闭");
    close.type = "button";
    close.setAttribute("aria-label", "关闭错误提示");
    close.addEventListener("click", () => node.remove());
    node.append(" ", close);
  }
  $("#toast-region").append(node);
  if (kind !== "error") setTimeout(() => node.remove(), 4200);
}

function confirmInStudio({ title, message, confirmLabel, cancelMessage }) {
  const dialog = $("#confirm-dialog");
  // Another confirm is already up: resolve as "cancelled" rather than
  // returning a bare false, so `await` callers still see a boolean.
  if (dialog.open) return Promise.resolve(false);
  const cancel = $("#cancel-confirm");
  const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  $("#confirm-dialog-title").textContent = title;
  $("#confirm-dialog-message").textContent = message;
  $("#confirm-action").textContent = confirmLabel;
  dialog.returnValue = "cancel";
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      const confirmed = dialog.returnValue === "confirm";
      if (!confirmed) toast(cancelMessage);
      if (trigger && document.contains(trigger)) trigger.focus();
      resolve(confirmed);
    }, { once: true });
    dialog.showModal();
    cancel.focus();
  });
}

async function openSessionInTerminal(session, button) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "打开中…";
  try {
    const result = await api("/api/open-terminal", {
      method: "POST",
      body: JSON.stringify({ session }),
    });
    button.title = result.command;
    if (result.opened) {
      toast(`已在 Terminal 打开 ${session}`);
      return;
    }
    let copied = false;
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(result.command);
        copied = true;
      } catch {
        // The visible command remains available when clipboard permission is unavailable.
      }
    }
    toast(copied ? `命令已复制：${result.command}` : `请在终端运行：${result.command}`);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

function terminalOpenButton(session) {
  const button = element("button", "secondary-button terminal-open-button", "在终端打开");
  button.type = "button";
  button.title = `在系统终端进入 ${session}`;
  button.setAttribute("aria-label", `在终端打开会话 ${session}`);
  button.addEventListener("click", () => openSessionInTerminal(session, button));
  return button;
}

function terminalCommandRow(session, command) {
  const row = element("div", "terminal-open-row");
  row.append(element("code", "", `进入工作台：${command}`), terminalOpenButton(session));
  return row;
}

function detailTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("zh-CN", { hour12: false });
}

function watchdogHeartbeat(value) {
  if (!Number.isFinite(value)) return "未运行";
  const age = `${Math.floor(value / 1000)} 秒前`;
  return value >= 150_000 ? `过期 · ${age}` : age;
}

function sessionDetailView(session) {
  const target = clone(session);
  const hasProvenance = Object.hasOwn(target, "crossSocketExited");
  let summary = "当前编辑中的工作台保持不变。只有点击下方显式动作，才会切换到此会话关联的项目。";
  if (hasProvenance && target.crossSocketExited) {
    summary += " Zellij 在其他 Socket 目录可能把它显示为 EXITED；合并视图已确认它仍在下方归属目录运行。";
  } else if (hasProvenance && target.status === "exited") {
    summary += " 各已知 Socket 目录均无活记录；会话已退出，可用 gsb-local open 重建。";
  }
  const groups = [{
    title: "ACTIVE ROLES",
    items: (target.roles || []).map((role) => ({ title: role, meta: "会话记录中的活动角色" })),
    empty: "该会话没有记录角色清单。",
  }];
  if (target.attachHint && (target.status === "running" || target.crossSocketExited)) {
    groups.push({
      title: "ATTACH / READ ONLY",
      items: [{ title: "按 Socket 归属进入", code: target.attachHint }],
      empty: "",
    });
  }
  return {
    kind: "session",
    eyebrow: "SESSION / STATE SNAPSHOT",
    title: target.name,
    summary,
    facts: [
      ["状态", (target.status || "unknown").toUpperCase()],
      ["关联项目", target.workspace || "未记录关联项目"],
      ...(target.socketLabel ? [["Socket 归属", target.socketLabel]] : []),
      ...(Object.hasOwn(target, "watchdogHeartbeatMs") ? [["Watchdog 心跳", watchdogHeartbeat(target.watchdogHeartbeatMs)]] : []),
      ["更新时间", detailTime(target.updatedAt)],
      ["角色数量", String(target.roles?.length || 0)],
    ],
    groups,
    target,
  };
}

function firstContentLine(value) {
  return String(value || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
}

function rolePromptSummary(role) {
  if (role.id === "hub") return firstContentLine(role.prompt) || "使用内置 Hub 核心，无额外能力扩展";
  const layered = role.promptMode === "layered" || typeof role.intent === "string" || typeof role.promptBase === "string";
  if (layered) return firstContentLine(role.intent) || `系统基座：${role.promptTemplate || role.id || "generic"}`;
  return `自定义全文：${firstContentLine(role.prompt) || "（空）"}`;
}

function templateOrigin(value = workbench) {
  if (value?.templateOrigin?.id) return value.templateOrigin;
  const match = typeof value?.profile === "string" ? value.profile.match(/^user:(.+)$/) : null;
  return match ? { id: match[1], version: "unknown" } : null;
}

function templateStatus(value) {
  const origin = templateOrigin(value);
  if (!origin) return "";
  const template = bootstrap.userTemplates.find((item) => item.id === origin.id);
  const name = template?.name || origin.id;
  if (template && origin.version !== template.version) {
    return `基于模板 ${name} · 模板已更新（v${origin.version === "unknown" ? "?" : origin.version}→v${template.version}）`;
  }
  return `基于模板 ${name}${template ? ` · v${template.version}` : ""}`;
}

function templateDetailView(template, currentProfile = "") {
  const target = clone(template);
  const source = target.source === "user" ? "我的模板" : "内置模板";
  return {
    kind: "template",
    eyebrow: "TEMPLATE / TOPOLOGY SNAPSHOT",
    title: target.name,
    summary: "模板内容仅供检查，不会替换当前工作台。使用或直接启动都必须点击下方显式动作。",
    facts: [
      ["来源", source],
      ["模板 ID", target.id],
      ["角色数量", String(target.roles?.length || 0)],
      ["当前状态", currentProfile === target.profileId ? "正在编辑此模板" : "未载入编辑器"],
    ],
    groups: [{
      title: "ROLE / AGENT / PROMPT",
      items: (target.roles || []).map((role) => ({
        title: `${role.id} · ${role.name || role.id} · ${role.type || "specialist"}`,
        meta: `${role.agent || "agent 未设置"} · ${role.model || "agent 默认模型"}\n${rolePromptSummary(role)}`,
      })),
      empty: "该模板没有角色。",
    }],
    target,
  };
}

function projectDetailView(project, state, sessions, profileName, { landing = false } = {}) {
  const targetProject = clone(project);
  const targetWorkbench = clone(state.workbench);
  const targetValidation = state.validation ? clone(state.validation) : null;
  const related = clone(sessions);
  const running = related.find((session) => session.status === "running") || null;
  const lastSession = [...related].sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))[0] || null;
  const errors = targetValidation?.errors || [];
  const warnings = targetValidation?.warnings || [];
  const validationPending = !targetValidation;
  return {
    kind: "project",
    key: `project:${projectKey(targetProject)}`,
    eyebrow: "PROJECT / CONFIG SNAPSHOT",
    title: targetProject.name,
    summary: "项目配置通过只读路径载入；当前编辑草稿、最近项目顺序和 LIVE SPEC 状态均未改变。",
    facts: [
      ["项目路径", targetProject.path],
      ["配置状态", targetProject.configured ? "已配置" : "尚未保存项目配置"],
      ["记忆会话", targetWorkbench.session || lastSession?.name || "—"],
      ["运行状态", running ? `运行中 · ${running.name}` : lastSession ? `${lastSession.status} · ${lastSession.name}` : "无会话记录"],
      ["模板来源", templateStatus(targetWorkbench) || profileName || targetWorkbench.profile || "CUSTOM"],
      ["校验概览", validationPending ? "校验中…" : `${errors.length} errors · ${warnings.length} warnings`],
    ],
    groups: [
      {
        title: "ROLE / AGENT / MODEL",
        items: (targetWorkbench.roles || []).map((role) => ({
          title: `${role.id} · ${role.name || role.id}`,
          meta: `${role.agent || "agent 未设置"} · ${role.model || "agent 默认模型"}`,
        })),
        empty: "该项目没有可显示的角色。",
      },
      {
        title: "VALIDATION NOTES",
        items: validationPending
          ? [{ title: "校验中…", meta: "命令与配置检查完成后会自动更新", pending: true }]
          : [
            ...errors.map((message) => ({ title: `ERROR · ${message}` })),
            ...warnings.map((message) => ({ title: `WARN · ${message}` })),
          ],
        empty: "当前配置没有错误或警告。",
      },
    ],
    target: { project: targetProject, workbench: targetWorkbench, validation: targetValidation, running, landing },
  };
}

function projectLoadingDetailView(project, { landing = false } = {}) {
  return {
    kind: "project-loading",
    key: `project:${projectKey(project)}`,
    eyebrow: "PROJECT / READ-ONLY FETCH",
    title: project.name,
    summary: "正在通过只读配置路径读取角色、会话与校验结果…",
    facts: [["项目路径", project.path], ["读取方式", "remember:false · 不载入编辑器"]],
    groups: [],
    target: { project: clone(project), landing },
  };
}

function renderDetailEditState() {
  const node = $("#detail-edit-state");
  if (!node) return;
  const dirty = Boolean(workbench) && hasUnsavedChanges();
  node.textContent = workbench ? `EDIT STATE · 草稿 ${dirty ? "● 未保存" : "✓ 已写入"}` : "EDIT STATE · 未载入项目";
  node.classList.toggle("is-dirty", dirty);
}

function detailActionButtons(view) {
  const actions = [];
  if (view.kind === "session") {
    if (view.target.status === "running") actions.push(terminalOpenButton(view.target.name));
    const select = element("button", "primary-button", "打开关联项目");
    select.type = "button";
    select.addEventListener("click", async () => {
      if (await selectSession(view.target)) toggleDetail(false);
    });
    actions.push(select);
  }
  if (view.kind === "template") {
    const launch = element("button", "secondary-button", "校验中…");
    launch.type = "button";
    launch.disabled = true;
    launch.addEventListener("click", async () => {
      if (await quickLaunchTemplate(view.target, launch)) toggleDetail(false);
    });
    prepareTemplateQuickLaunch(view.target, launch);
    const use = element("button", "primary-button", "使用此模板");
    use.type = "button";
    use.addEventListener("click", async () => {
      if (await applyTemplate(view.target)) toggleDetail(false);
    });
    actions.push(launch, use);
  }
  if (view.kind === "project") {
    if (view.target.running) actions.push(terminalOpenButton(view.target.running.name));
    const launch = element("button", "secondary-button", "▶ 用上次配置启动");
    launch.type = "button";
    const validationPending = !view.target.validation;
    const error = view.target.validation?.errors?.[0];
    launch.disabled = validationPending || !view.target.project.configured || Boolean(error);
    launch.title = validationPending ? "正在校验项目配置" : !view.target.project.configured ? "项目尚未配置" : (error || `启动 ${view.target.workbench.session}`);
    if (validationPending) launch.textContent = "校验中…";
    if (!view.target.project.configured) launch.textContent = "先配置项目";
    else if (error) launch.textContent = "配置需修正";
    launch.addEventListener("click", async () => {
      const result = await executeQuickLaunch(view.target.workbench, launch);
      if (!result) return;
      projectLaunchCache.delete(projectKey(view.target.project));
      view.target.running = { name: view.target.workbench.session, status: "running" };
      renderDetail(view);
    });
    const edit = element("button", "primary-button", "编辑此项目");
    edit.type = "button";
    edit.addEventListener("click", async () => {
      if (projectKey(view.target.project) === loadedProjectKey) {
        toggleDetail(false);
        if (view.target.landing) enterEditor();
        else toast("当前项目已在编辑器中");
        return;
      }
      if (!await loadProject(view.target.project)) return;
      toggleDetail(false);
      if (view.target.landing) enterEditor();
    });
    actions.push(launch, edit);
  }
  if (view.kind === "project-error") {
    const edit = element("button", "primary-button", "仍然编辑此项目");
    edit.type = "button";
    edit.addEventListener("click", async () => {
      if (projectKey(view.target.project) === loadedProjectKey) {
        toggleDetail(false);
        if (view.target.landing) enterEditor();
        else toast("当前项目已在编辑器中");
        return;
      }
      if (!await loadProject(view.target.project)) return;
      toggleDetail(false);
      if (view.target.landing) enterEditor();
    });
    actions.push(edit);
  }
  return actions;
}

function renderDetail(view = detailView) {
  if (!view) return;
  $("#detail-kind").textContent = view.eyebrow;
  $("#detail-heading").textContent = view.title;
  $("#detail-summary").textContent = view.summary;
  $("#detail-facts").replaceChildren(...view.facts.map(([label, value]) => {
    const row = element("div");
    row.append(element("dt", "", label), element("dd", "", value));
    return row;
  }));
  $("#detail-content").replaceChildren(...view.groups.map((group) => {
    const section = element("section", "detail-group");
    section.append(element("h3", "", group.title));
    if (!group.items.length) {
      section.append(element("p", "detail-empty", group.empty));
      return section;
    }
    const list = element("ul", "detail-list");
    group.items.forEach((item) => {
      const row = element("li");
      row.classList.toggle("is-pending", Boolean(item.pending));
      row.append(element("b", "", item.title));
      if (item.meta) row.append(element("small", "", item.meta));
      if (item.code) row.append(element("code", "detail-code", item.code));
      list.append(row);
    });
    section.append(list);
    return section;
  }));
  $("#detail-actions").replaceChildren(...detailActionButtons(view));
  renderDetailEditState();
}

function toggleDetail(force, { restoreFocus = true } = {}) {
  const panel = $("#detail-panel");
  const backdrop = $("#detail-backdrop");
  const open = force ?? !panel.classList.contains("is-open");
  panel.classList.toggle("is-open", open);
  backdrop.classList.toggle("is-open", open);
  backdrop.setAttribute("aria-hidden", String(!open));
  document.body.classList.toggle("has-detail-open", open);
  panel.toggleAttribute("inert", !open);
  panel.setAttribute("aria-hidden", String(!open));
  if (open) {
    $("#detail-heading").focus();
    return;
  }
  detailView = null;
  if (restoreFocus && detailReturnFocus && document.contains(detailReturnFocus)) detailReturnFocus.focus();
  detailReturnFocus = null;
}

function openDetail(view, trigger = document.activeElement) {
  detailView = view;
  detailReturnFocus = trigger instanceof HTMLElement ? trigger : null;
  renderDetail(view);
  toggleValidation(false);
  toggleDetail(true);
}

function workbenchFingerprint() {
  return JSON.stringify(workbench);
}

function resetValidationState() {
  clearTimeout(validationTimer);
  validationRevision++;
  validationResult = null;
  validatedWorkbenchFingerprint = "";
  validationPending = false;
}

function hasUnsavedChanges() {
  return Boolean(cleanWorkbenchFingerprint) && workbenchFingerprint() !== cleanWorkbenchFingerprint;
}

function renderSaveState() {
  const dirty = hasUnsavedChanges();
  $("#summary-save-state").textContent = `LIVE SPEC · 草稿${dirty ? " ● 未保存" : " ✓ 已写入"}`;
  $("#discard-changes").hidden = !dirty || !cleanWorkbenchSnapshot;
  renderDetailEditState();
}

function markWorkbenchClean() {
  // renderRoleEditor() runs ensurePromptState(), which fills promptMode/prompt
  // in place. Normalize every role first so the snapshot matches what render
  // produces; otherwise a freshly loaded project reads as dirty and every
  // "返回项目列表" hits a bogus 放弃修改 confirm.
  (workbench?.roles || []).forEach(ensurePromptState);
  cleanWorkbenchSnapshot = workbench ? clone(workbench) : null;
  cleanWorkbenchFingerprint = workbenchFingerprint();
  renderSaveState();
}

async function confirmDiscard(action) {
  const consequence = action.includes("放弃") ? action : `${action}并放弃这些修改`;
  if (!hasUnsavedChanges()) return true;
  return confirmInStudio({
    title: `确定要${consequence}吗？`,
    message: "当前工作台有未保存修改；继续后无法恢复这些修改。",
    confirmLabel: "放弃修改并继续",
    cancelMessage: `已取消${action}；未保存修改仍保留`,
  });
}

async function discardChanges() {
  if (!hasUnsavedChanges() || !cleanWorkbenchSnapshot) return false;
  if (!await confirmDiscard("放弃所有未保存修改")) return false;
  workbench = clone(cleanWorkbenchSnapshot);
  loadedWorkspace = workbench.workspace || loadedWorkspace;
  loadedProjectKey = projectKey(workbenchProject());
  currentRole = Math.min(currentRole, Math.max(0, workbench.roles.length - 1));
  resetValidationState();
  renderAll();
  markWorkbenchClean();
  toast("已恢复到上次保存或载入的状态");
  return true;
}

function setPersistentError(message = "") {
  persistentError = message;
  if (workbench) renderSummary();
  else renderProjectLanding();
}

function promptFor(id) {
  return bootstrap.prompts.find((prompt) => prompt.id === id);
}

function basePromptForRole(id) {
  return promptFor(bootstrap.roleBaseAliases?.[id] || id) || promptFor("generic");
}

function composeLayeredPrompt(role) {
  const base = (role.promptBase || "").trim();
  const intent = (role.intent || "").trim();
  return `${base}\n\n${promptIntentMarker}${intent ? `\n\n${intent}` : ""}`;
}

function finalPromptForRole(role) {
  if (!role || role.id === "hub") return "";
  return role.promptMode === "custom" ? (role.prompt || "") : composeLayeredPrompt(role);
}

function renderFinalPromptPreview(role = workbench?.roles[currentRole]) {
  const preview = $("#role-final-prompt");
  if (preview) preview.textContent = finalPromptForRole(role) || "（最终提示词为空）";
}

function ensurePromptState(role) {
  if (!role || role.id === "hub") return;
  if (role.promptMode === "layered") {
    if (!role.promptBase?.trim()) role.promptBase = (promptFor(role.promptTemplate) || basePromptForRole(role.id))?.body?.trim() || "";
    role.intent = typeof role.intent === "string" ? role.intent : "";
    role.prompt = composeLayeredPrompt(role);
    return;
  }
  if (role.promptMode !== "custom") {
    if (typeof role.promptBase === "string" || typeof role.intent === "string") {
      role.promptMode = "layered";
      ensurePromptState(role);
      return;
    }
    role.promptMode = "custom";
  }
  role.prompt = typeof role.prompt === "string" ? role.prompt : "";
  role.promptBase = "";
  role.intent = "";
}

function roleFromMapping(mapping) {
  const meta = bootstrap.roleMeta[mapping.role] || {};
  const isHub = mapping.role === "hub";
  const prompt = isHub ? null : basePromptForRole(mapping.role);
  const promptBase = isHub ? "" : (prompt?.body?.trim() || `You are the ${mapping.role} Spoke. Apply the most relevant domain method and produce a concrete, verified result.`);
  return {
    id: mapping.role,
    name: meta.name || mapping.role,
    type: meta.type || "specialist",
    description: meta.description || "自定义协作角色",
    agent: mapping.agent,
    model: "",
    promptTemplate: isHub ? "" : (prompt?.id || ""),
    prompt: isHub ? "" : promptBase,
    ...(isHub ? {} : { promptBase, intent: "", promptMode: "layered" }),
  };
}

function minimalHubRole() {
  const meta = bootstrap.roleMeta.hub || {};
  return {
    id: "hub",
    name: meta.name || "Hub",
    type: meta.type || "orchestrator",
    description: meta.description || "目标澄清、任务拆解、分发、冲突处理与最终汇总",
    agent: "claude-glm-5.3",
    model: "",
    promptTemplate: "",
    prompt: "",
  };
}

async function createIndependentTemplate(name) {
  if (!await confirmDiscard("创建空白模板")) return false;
  const nextWorkbench = {
    ...workbench,
    version: 1,
    name,
    profile: "draft",
    permission: "balanced",
    watchdog: true,
    rebuild: false,
    roles: [minimalHubRole()],
  };
  const result = await api("/api/templates", {
    method: "POST",
    body: JSON.stringify({ name, workbench: nextWorkbench }),
  });
  bootstrap.userTemplates = result.templates;
  const savedName = result.template.name;
  nextWorkbench.name = savedName;
  nextWorkbench.profile = `user:${result.template.id}`;
  nextWorkbench.templateOrigin = { id: result.template.id, version: result.template.version };
  nextWorkbench.source = "user";
  nextWorkbench.hubCore = result.template.hubCore;
  workbench = nextWorkbench;
  currentRole = 0;
  resetValidationState();
  renderAll();
  scheduleValidation();
  goToStep("sec-roster");
  toast(`独立模板「${savedName}」已创建，现在可以逐个配置角色`);
  return true;
}

function workbenchForTemplate(template) {
  const runtime = {
    workspace: workbench.workspace,
    session: workbench.session,
    name: workbench.name,
    permission: workbench.permission,
    watchdog: workbench.watchdog,
    rebuild: workbench.rebuild,
  };
  return {
    ...workbench,
    ...runtime,
    source: template.source,
    profile: template.profileId,
    templateOrigin: template.source === "user" ? { id: template.id, version: template.version } : null,
    permission: template.source === "user" ? (template.permission || runtime.permission) : runtime.permission,
    watchdog: template.source === "user" ? template.watchdog !== false : runtime.watchdog,
    roles: clone(template.roles || []),
  };
}

// Template edit mode: the workbench holds a template, not a project. Runtime
// fields are placeholders that validate cleanly and are never written to disk.
function workbenchForTemplateEdit(template) {
  const roles = clone(template.roles || []);
  return {
    version: 1,
    workspace: "",
    projectName: "",
    session: "template-edit",
    name: template.name,
    source: "user",
    profile: `user:${template.id}`,
    templateOrigin: { id: template.id, version: template.version },
    hubCore: template.hubCore,
    permission: template.permission || "balanced",
    watchdog: template.watchdog !== false,
    rebuild: false,
    roles,
  };
}

async function editTemplate(template) {
  if (template.source !== "user") {
    toast(`内置模板 ${template.name} 只读；请先「使用此模板」再另存为个人模板`, "error");
    return false;
  }
  if (!await confirmDiscard(`编辑模板 ${template.name}`)) return false;
  templateEditMode = { id: template.id, name: template.name };
  workbench = workbenchForTemplateEdit(template);
  currentRole = 0;
  loadedProjectKey = "";
  resetValidationState();
  markWorkbenchClean();
  setWorkspaceReady(true);
  renderAll();
  scheduleValidation();
  goToStep("sec-roster");
  toast(`正在编辑模板「${template.name}」v${template.version}`);
  return true;
}

async function saveTemplateEdits() {
  if (!templateEditMode) return false;
  const button = $("#save-template-mode");
  button.disabled = true;
  try {
    const result = await api("/api/templates", {
      method: "POST",
      body: JSON.stringify({ id: templateEditMode.id, name: templateEditMode.name, workbench }),
    });
    bootstrap.userTemplates = result.templates;
    workbench.templateOrigin = { id: result.template.id, version: result.template.version };
    templateEditMode = { id: result.template.id, name: result.template.name };
    markWorkbenchClean();
    renderAll();
    toast(`模板「${result.template.name}」已保存为 v${result.template.version}`);
    if (!openTemplateUpgrade(result.upgradePlan)) toast("没有项目使用该模板，无需同步");
    return true;
  } catch (error) {
    toast(error.message, "error");
    return false;
  } finally {
    button.disabled = false;
  }
}

function templateLandingEntry(template) {
  const entry = element("div", "project-launch-row");
  const main = element("button", "resource-item project-resource landing-project-resource");
  main.type = "button";
  main.title = `只读预览模板：${template.name}`;
  main.append(element("span", "resource-glyph", "TP"));
  const copy = element("span", "resource-copy");
  copy.append(element("b", "", template.name), element("small", "", `我的 / ${template.id}`));
  const consumers = templateConsumerCount(template.id);
  copy.append(element("small", "template-resource-version", `v${template.version} · ${consumers} 个项目在用`));
  const meta = element("span", "resource-meta");
  meta.append(element("span", "resource-stat", `${String((template.roles || []).length).padStart(2, "0")} ROLES`));
  main.append(copy, meta);
  main.addEventListener("click", () => openDetail(templateDetailView(template, workbench?.profile || ""), main));
  const actions = element("span", "project-quick-actions");
  const editButton = element("button", "secondary-button project-quick-edit", "编辑");
  editButton.type = "button";
  editButton.title = `编辑模板 ${template.name}，保存后可同步关联项目`;
  editButton.addEventListener("click", () => editTemplate(template));
  actions.append(editButton);
  entry.append(main, actions);
  return entry;
}

function templateConsumerCount(templateId) {
  return (bootstrap.projectOptions || []).filter((project) => project.templateId === templateId).length;
}

function renderTemplateLanding() {
  const templates = (bootstrap.userTemplates || []).map((template) => toTemplate(template, "user"));
  $("#landing-template-count").textContent = String(templates.length).padStart(2, "0");
  $("#landing-template-options").replaceChildren(...(templates.length
    ? templates.map(templateLandingEntry)
    : [resourceEmpty("还没有个人模板", "在工作台里点「保存为模板」，或用空白模板从最小 Hub 开始")]));
}

async function applyTemplate(template) {
  if (workbench.profile === template.profileId && (template.source !== "user" || templateOrigin()?.version === template.version)) {
    toast(`正在编辑${template.source === "user" ? "模板 " : " "}${template.name}，已保留当前修改`);
    return false;
  }
  if (!await confirmDiscard(`载入${template.source === "user" ? "模板 " : " "}${template.name}`)) return false;
  workbench = workbenchForTemplate(template);
  currentRole = 0;
  renderAll();
  scheduleValidation();
  toast(`已载入${template.source === "user" ? "模板 " : " "}${template.name}`);
  return true;
}

async function prepareTemplateQuickLaunch(template, button) {
  button.disabled = true;
  button.textContent = "校验中…";
  try {
    const target = workbenchForTemplate(template);
    const checked = await api("/api/validate", { method: "POST", body: JSON.stringify({ workbench: target }) });
    const error = checked.validation.errors?.[0];
    button.disabled = Boolean(error);
    button.textContent = error ? "配置需修正" : "▶ 用此模板直接启动";
    button.title = error || `以 ${template.name} 启动 ${target.session}`;
  } catch (error) {
    button.disabled = true;
    button.textContent = "无法校验";
    button.title = error.message;
  }
}

async function quickLaunchTemplate(template, button) {
  if (!await confirmDiscard(`用模板 ${template.name} 直接启动`)) return false;
  try {
    const target = workbenchForTemplate(template);
    const checked = await api("/api/validate", { method: "POST", body: JSON.stringify({ workbench: target }) });
    if (!checked.validation.valid) {
      button.disabled = true;
      button.textContent = "配置需修正";
      button.title = checked.validation.errors[0];
      return false;
    }
    const result = await executeQuickLaunch(target, button);
    if (!result) return false;
    workbench = target;
    currentRole = 0;
    validationResult = result.validation;
    previewFiles = result.files;
    validatedWorkbenchFingerprint = workbenchFingerprint();
    projectLaunchCache.delete(projectKey(workbenchProject()));
    renderAll();
    markWorkbenchClean();
    return true;
  } catch (error) {
    button.disabled = true;
    button.textContent = "无法校验";
    button.title = error.message;
    toast(error.message, "error");
    return false;
  }
}

function openTemplateUpgrade(plan) {
  if (!plan?.projects?.length) return false;
  pendingTemplateUpgrade = plan;
  $("#template-upgrade-title").textContent = `升级使用「${plan.template.name}」的项目`;
  $("#template-upgrade-copy").textContent = `模板 v${plan.template.fromVersion} → v${plan.template.toVersion}；选择要写入磁盘的项目。运行中的会话不会改变。`;
  $("#template-upgrade-projects").replaceChildren(...plan.projects.map((project, index) => {
    const label = element("label", "upgrade-project");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = true;
    input.value = String(index);
    const copy = element("span");
    copy.append(element("b", "", project.name), element("small", "", `${project.path} · 当前 v${project.originVersion === "unknown" ? "?" : project.originVersion}`));
    label.append(input, copy);
    return label;
  }));
  $("#template-upgrade-diff").replaceChildren(...(plan.diff.length ? plan.diff : [{ label: "模板内容无结构变化" }]).map((change) => {
    const item = element("li", change.preserve ? "is-preserved" : "");
    const compact = (value) => String(value || "—").replace(/\s+/g, " ").slice(0, 120);
    item.append(element("b", "", change.label), element("small", "", `${compact(change.before)} → ${compact(change.after)}`));
    return item;
  }));
  $("#template-upgrade-body").hidden = false;
  $("#template-upgrade-result").hidden = true;
  $("#template-upgrade-launch").hidden = true;
  $("#confirm-template-upgrade").hidden = false;
  $("#close-template-upgrade").textContent = "暂不升级";
  const dialog = $("#template-upgrade-dialog");
  if (!dialog.open) dialog.showModal();
  return true;
}

// After an upgrade the new config is on disk but a running Zellij session was
// started from the old one; only --rebuild re-creates its panes. These rows
// launch each project with the right flag instead of leaving the user to
// retype a command in a terminal.
function upgradeLaunchRow(project) {
  const row = element("div", "upgrade-launch-row");
  const running = sessionsForProject(project).find((session) => session.status === "running");
  const command = `gsb-local ${running ? "--rebuild " : ""}${project.path} ${project.name}`;
  const copy = element("span");
  copy.append(element("b", "", project.name));
  copy.append(element("small", running ? "is-running" : "", running ? `运行中 · 需重建才会应用新配置` : "未运行 · 直接启动即可"));
  copy.append(element("small", "", command));
  const launchButton = element("button", "secondary-button", running ? "↻ 重建并启动" : "▶ 启动");
  launchButton.type = "button";
  launchButton.title = command;
  launchButton.addEventListener("click", () => launchUpgradedProject(project, Boolean(running), launchButton));
  const copyButton = element("button", "text-button copy-command-button", "复制命令");
  copyButton.type = "button";
  copyButton.title = command;
  copyButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(command);
      toast(`已复制：${command}`);
    } catch {
      toast("复制失败，请手动选择命令文本", "error");
    }
  });
  row.append(copy, launchButton, copyButton);
  return row;
}

async function launchUpgradedProject(project, running, button) {
  if (running && !await confirmInStudio({
    title: `确定要重建 ${project.name} 吗？`,
    message: "重建会关闭该会话现有的 pane，正在运行的 agent 会被中断。TASK、合同和报告仍然保留。",
    confirmLabel: "重建并启动",
    cancelMessage: `已取消重建 ${project.name}；旧会话仍在运行`,
  })) return false;
  projectLaunchCache.delete(projectKey(project));
  let state;
  try {
    state = await projectLaunchState(project);
  } catch (error) {
    toast(error.message, "error");
    return false;
  }
  if (!state.validation.valid) {
    toast(state.validation.errors[0] || `${project.name} 配置校验未通过`, "error");
    return false;
  }
  // rebuild is a per-launch decision here, not a stored preference: only write
  // it onto the payload we send, never back into the project's saved config.
  const result = await executeQuickLaunch({ ...state.workbench, rebuild: running }, button);
  if (result) await refreshResources({ silent: true });
  return Boolean(result);
}

function renderUpgradeLaunch(applied) {
  const section = $("#template-upgrade-launch");
  const rows = $("#template-upgrade-launch-rows");
  section.hidden = !applied?.length;
  if (!applied?.length) return;
  rows.replaceChildren(...applied.map(upgradeLaunchRow));
}

async function applyPendingTemplateUpgrade() {
  if (!pendingTemplateUpgrade) return;
  const button = $("#confirm-template-upgrade");
  const projects = $$("#template-upgrade-projects input:checked").map((input) => pendingTemplateUpgrade.projects[Number(input.value)]);
  button.disabled = true;
  try {
    const result = await api("/api/template-upgrade", {
      method: "POST",
      body: JSON.stringify({ templateId: pendingTemplateUpgrade.template.id, projects }),
    });
    if (result.applied.some((project) => projectKey(project) === projectKey(workbenchProject()))) {
      const current = workbenchProject();
      const state = await api("/api/project", { method: "POST", body: JSON.stringify({ workspace: current.path, name: current.name, remember: false }) });
      workbench = clone(state.workbench);
      bootstrap.projectOptions = state.projectOptions;
      bootstrap.sessionOptions = state.sessionOptions;
      bootstrap.recentProjects = state.recentProjects;
      currentRole = Math.min(currentRole, Math.max(0, workbench.roles.length - 1));
      resetValidationState();
      markWorkbenchClean();
    }
    renderAll();
    $("#template-upgrade-body").hidden = true;
    $("#template-upgrade-result").hidden = false;
    $("#template-upgrade-result").textContent = `已更新 ${result.applied.length} 个项目`;
    renderUpgradeLaunch(result.applied);
    button.hidden = true;
    $("#close-template-upgrade").textContent = "完成";
    scheduleValidation();
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function offerTemplateOverwrite(offer) {
  if (!offer || !await confirmInStudio({
    title: `是否覆盖模板「${offer.name}」？`,
    message: `项目已保存。覆盖后模板将从 v${offer.currentVersion} 升到 v${offer.nextVersion}，随后可选择要升级的项目。`,
    confirmLabel: "覆盖模板并继续",
    cancelMessage: "项目已保存，模板未改变",
  })) return;
  try {
    const result = await api("/api/templates", { method: "POST", body: JSON.stringify({ id: offer.id, name: offer.name, workbench }) });
    bootstrap.userTemplates = result.templates;
    renderProfiles();
    renderEditorProjectBar();
    renderSummary();
    openTemplateUpgrade(result.upgradePlan);
  } catch (error) {
    toast(error.message, "error");
  }
}

function toTemplate(entry, source) {
  return {
    ...entry,
    source,
    profileId: source === "user" ? `user:${entry.id}` : entry.id,
    roles: source === "builtin" ? (entry.roles || []).map(roleFromMapping) : clone(entry.roles || []),
  };
}

function profileCard(template) {
  const entry = element("div", "profile-entry");
  const button = element("button", `profile-card${workbench.profile === template.profileId ? " is-selected" : ""}`);
  button.type = "button";
  const code = element("span", "profile-code", `${template.source === "user" ? "我的" : "内置"} / ${template.id}`);
  const title = element("h3", "", template.name);
  const copy = element("p", "", template.description || (template.source === "user" ? "保存的可复用角色、模型与提示词组合" : "预设协作拓扑"));
  const row = element("div", "profile-role-row");
  const roles = template.roles || [];
  row.append(element("span", "", `${String(roles.length).padStart(2, "0")} ACTIVE ROLES`));
  const stack = element("div", "profile-agent-stack");
  roles.slice(0, 6).forEach((role) => stack.append(element("i", "", (role.id || "?")[0].toUpperCase())));
  row.append(stack);
  button.append(code, title, copy, row);
  button.addEventListener("click", () => openDetail(templateDetailView(template, workbench.profile), button));
  const launchButton = element("button", "template-quick-launch", "校验中…");
  launchButton.type = "button";
  launchButton.disabled = true;
  launchButton.addEventListener("click", () => quickLaunchTemplate(template, launchButton));
  entry.append(button, launchButton);
  prepareTemplateQuickLaunch(template, launchButton);
  return entry;
}

function blankTemplateCard() {
  const button = element("button", "profile-card blank-template-card");
  button.type = "button";
  button.append(
    element("span", "profile-code", "CREATE / BLANK"),
    element("h3", "", "+ 空白模板"),
    element("p", "", "从最小 Hub 开始逐个添加角色，不继承内置模板。"),
  );
  button.addEventListener("click", () => {
    $("#new-template-name").value = "";
    $("#create-template-dialog").showModal();
    $("#new-template-name").focus();
  });
  return button;
}

function renderProfiles() {
  const grid = $("#template-grid");
  grid.classList.remove("skeleton-grid");
  const templates = [
    ...bootstrap.profiles.map((profile) => toTemplate(profile, "builtin")),
    ...bootstrap.userTemplates.map((template) => toTemplate(template, "user")),
  ];
  grid.replaceChildren(...templates.map(profileCard), blankTemplateCard());
}

function renderRoleList() {
  const list = $("#role-list");
  list.replaceChildren(...workbench.roles.map((role, index) => {
    const button = element("button", `role-item${index === currentRole ? " is-active" : ""}`);
    button.type = "button";
    button.append(element("span", "role-number", String(index + 1).padStart(2, "0")));
    const body = element("span");
    body.append(element("b", "", role.name || role.id), element("small", "", `${role.agent || "unset"}${role.model ? ` · ${role.model}` : ""}`));
    button.append(body);
    button.addEventListener("click", () => {
      currentRole = index;
      renderRoleList();
      renderRoleEditor();
    });
    return button;
  }));
}

function renderRoleEditor() {
  const role = workbench.roles[currentRole];
  if (!role) return;
  const isHub = role.id === "hub";
  ensurePromptState(role);
  $(".role-editor").classList.toggle("is-hub", isHub);
  $("#role-type").textContent = (role.type || "specialist").toUpperCase();
  $("#role-heading").textContent = role.name || role.id;
  $("#role-id").value = role.id || "";
  $("#role-name").value = role.name || "";
  $("#role-agent").value = role.agent || "";
  $("#role-model").value = role.model || "";
  $("#role-description").value = role.description || "";
  $("#role-prompt").value = isHub ? (role.prompt || "") : "";
  $("#role-intent").value = isHub ? "" : (role.intent || "");
  $("#role-prompt-base").textContent = isHub ? "" : (role.promptBase || "自定义全文模式未使用系统基座");
  $("#role-custom-prompt").value = isHub ? "" : (role.prompt || "");
  renderFinalPromptPreview(role);
  $("#prompt-advanced-details").open = !isHub && role.promptMode === "custom";
  $("#role-id").readOnly = isHub;
  $("#role-id").title = isHub ? "Hub 是每个 GSB 模板必需的内置入口，角色 ID 不可修改" : "";
  $("#remove-role").disabled = isHub || workbench.roles.length === 1;
  $("#remove-role").textContent = isHub ? "内置必带" : "移除角色";
  $("#remove-role").classList.toggle("core-required", isHub);
  $("#hub-core-panel").hidden = !isHub;
  $("#spoke-prompt-editor").hidden = isHub;
  $("#hub-prompt-field").hidden = !isHub;
  $("#prompt-template-field").hidden = isHub;
  $("#hub-extension-heading").hidden = !isHub;
  $("#hub-extension-presets").hidden = !isHub;
  $("#role-prompt").placeholder = "在这里追加 Hub 的领域能力、审核偏好或协调方式。\n\n例如：在涉及数据库迁移时，必须先让 plan-backup 给出回滚方案，并由 ops-gov 核验备份证据。";
  $("#prompt-input-label").textContent = "Hub 能力扩展";
  $("#prompt-lock-copy").textContent = isHub
    ? "这里的内容只会追加到不可变 Hub 内核之后；与任务拆解、分发或安全协议冲突的部分不会生效。"
    : role.promptMode === "custom"
      ? "当前使用自定义全文；Relay、安全边界和运行路径仍由 GSB 协议层追加。"
      : "系统基座会与一句话意图合成；Relay、安全边界和运行路径由 GSB 协议层追加。";
  const select = $("#prompt-template");
  select.replaceChildren(new Option("自动匹配 / Generic", ""), ...bootstrap.prompts.filter((prompt) => prompt.id !== "hub").map((prompt) => new Option(prompt.name, prompt.id)));
  select.value = role.promptMode === "layered" && bootstrap.prompts.some((prompt) => prompt.id === role.promptTemplate) ? role.promptTemplate : "";
  updatePromptStats();
  if (validatedWorkbenchFingerprint === workbenchFingerprint()) applyFieldValidation();
  else clearFieldValidation();
}

function updatePromptStats() {
  const role = workbench.roles[currentRole];
  const prompt = role?.id === "hub"
    ? $("#role-prompt").value
    : role?.promptMode === "custom" ? $("#role-custom-prompt").value : $("#role-intent").value;
  $("#prompt-lines").textContent = `${prompt ? prompt.split(/\r?\n/).length : 0} lines`;
  $("#prompt-chars").textContent = `${prompt.length} chars`;
}

function renderRuntime() {
  $("#workspace-path").value = workbench.workspace || "";
  $("#session-name").value = workbench.session || "";
  $("#workbench-name").value = workbench.name || "";
  const permission = document.querySelector(`input[name="permission"][value="${CSS.escape(workbench.permission || "balanced")}"]`);
  if (permission) permission.checked = true;
  $("#watchdog-enabled").checked = workbench.watchdog !== false;
  $("#rebuild-session").checked = workbench.rebuild === true;
  renderResourceBrowser();
}

function fallbackProjectOptions() {
  return (bootstrap.recentProjects || []).map((value) => ({
    ...projectRef(value),
    configured: false,
    sessions: 0,
    running: 0,
  }));
}

function fallbackSessionOptions() {
  return (bootstrap.sessions || []).map((raw) => ({
    name: String(raw).split(/\s+/, 1)[0],
    status: /\bEXITED\b/.test(raw) ? "exited" : "running",
    workspace: "",
    roles: [],
    updatedAt: 0,
    raw,
  }));
}

function sessionsForProject(project) {
  return (bootstrap.sessionOptions || fallbackSessionOptions()).filter((session) => (
    session.workspace === project.path && (!project.name || session.name === project.name)
  ));
}

function profileName(profileId) {
  return bootstrap.profiles.find((profile) => profile.id === profileId)?.name
    || bootstrap.userTemplates.find((template) => `user:${template.id}` === profileId)?.name
    || profileId
    || "CUSTOM";
}

async function openProjectDetail(project, trigger, options = {}) {
  const loading = projectLoadingDetailView(project, options);
  openDetail(loading, trigger);
  trigger.setAttribute("aria-busy", "true");
  try {
    const renderProjectState = (state) => {
      if (detailView?.key !== loading.key) return;
      detailView = projectDetailView(project, state, sessionsForProject(project), profileName(state.workbench.profile), options);
      renderDetail(detailView);
    };
    const state = await projectLaunchState(project, {
      onProject: (workbench) => renderProjectState({ workbench, validation: null }),
    });
    if (detailView?.key !== loading.key) return;
    renderProjectState(state);
  } catch (error) {
    if (detailView?.key !== loading.key) return;
    detailView = {
      ...loading,
      kind: "project-error",
      eyebrow: "PROJECT / READ FAILURE",
      summary: "只读配置无法载入；当前编辑草稿仍保持不变。",
      facts: [["项目路径", project.path], ["错误", error.message]],
    };
    renderDetail(detailView);
  } finally {
    trigger.removeAttribute("aria-busy");
  }
}

function projectResource(project, { landing = false, recentProject = "" } = {}) {
  const selected = projectKey(project) === projectKey(workbenchProject());
  const isRecent = projectKey(project) === projectKey(recentProject);
  const button = element("button", `resource-item project-resource${landing ? " landing-project-resource" : ""}${selected ? " is-selected" : ""}${isRecent ? " is-recent" : ""}`);
  button.type = "button";
  button.title = `只读预览项目配置：${project.path}`;
  button.setAttribute("aria-pressed", String(selected));
  button.append(element("span", "resource-glyph", "PR"));
  const copy = element("span", "resource-copy");
  copy.append(element("b", "", project.name), element("small", "", project.path));
  const meta = element("span", "resource-meta");
  if (landing) {
    const related = sessionsForProject(project);
    const running = related.find((session) => session.status === "running");
    const lastSession = [...related].sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))[0];
    const sessionCopy = running
      ? `运行中 ${running.name} · gsb-local open ${running.name}`
      : lastSession
        ? `上次会话 ${lastSession.name} · ${lastSession.status}`
        : project.configured ? "已配置 · 尚无已保存会话" : "未配置 · 打开后开始配置";
    copy.append(element("small", "project-last-session", sessionCopy));
    if (isRecent) meta.append(element("span", "resource-badge", "LAST"));
  }
  if (project.configured) meta.append(element("span", "resource-badge configured", "CONFIG"));
  meta.append(element("span", "resource-stat", `${project.running || 0} RUN / ${project.sessions || 0} ALL`));
  button.append(copy, meta);
  button.addEventListener("click", () => openProjectDetail(project, button, { landing }));
  return button;
}

function projectLaunchState(project, { onProject } = {}) {
  const key = projectKey(project);
  if (!projectLaunchCache.has(key)) {
    const projectRequest = api("/api/project", {
      method: "POST",
      body: JSON.stringify({ workspace: project.path, name: project.name, remember: false }),
    });
    const pending = projectRequest.then(async (loaded) => {
      const checked = await api("/api/validate", {
        method: "POST",
        body: JSON.stringify({ workbench: loaded.workbench }),
      });
      return { workbench: loaded.workbench, validation: checked.validation };
    }).catch((error) => {
      projectLaunchCache.delete(key);
      throw error;
    });
    projectLaunchCache.set(key, { projectRequest, pending });
  }
  const cached = projectLaunchCache.get(key);
  if (onProject) cached.projectRequest.then((loaded) => onProject(loaded.workbench)).catch(() => {});
  return cached.pending;
}

async function confirmFullAccessLaunch(target) {
  if (target.permission !== "full-access") return true;
  return confirmInStudio({
    title: "确定以 Full Access 启动吗？",
    message: `Full Access 会让 ${target.name || target.session || "此工作台"} 绕过内置 Agent 的审批与沙箱。`,
    confirmLabel: "以最高权限启动",
    cancelMessage: "已取消 Full Access 启动",
  });
}

async function executeQuickLaunch(target, button, statusNode = null) {
  if (!await confirmFullAccessLaunch(target)) return null;
  const label = button.textContent;
  let keepDisabled = false;
  button.disabled = true;
  button.textContent = "正在启动…";
  try {
    const result = await api("/api/launch", { method: "POST", body: JSON.stringify({ workbench: target }) });
    if (statusNode) statusNode.textContent = `已启动 · ${result.openCommand || `gsb-local open ${target.session}`}`;
    button.title = result.openCommand || `gsb-local open ${target.session}`;
    toast(`已启动 ${target.session}`);
    return result;
  } catch (error) {
    const message = error.payload?.validation?.errors?.[0] || error.message;
    keepDisabled = error.payload?.validation?.valid === false;
    if (statusNode) statusNode.textContent = message;
    button.title = message;
    toast(error.message, "error");
    return null;
  } finally {
    button.disabled = keepDisabled;
    button.textContent = label;
  }
}

async function prepareProjectQuickLaunch(project, button, statusNode) {
  if (!project.configured) {
    button.disabled = true;
    button.textContent = "先配置项目";
    statusNode.textContent = "未配置项目不能直接启动";
    return;
  }
  button.disabled = true;
  button.textContent = "校验中…";
  try {
    const state = await projectLaunchState(project);
    const error = state.validation.errors?.[0];
    button.disabled = Boolean(error);
    button.textContent = error ? "配置需修正" : "▶ 用上次配置启动";
    button.title = error || `启动 ${state.workbench.session}`;
    statusNode.textContent = error || `已校验 · ${state.workbench.session}`;
  } catch (error) {
    button.disabled = true;
    button.textContent = "无法校验";
    button.title = error.message;
    statusNode.textContent = error.message;
  }
}

function projectLandingEntry(project, recentProject) {
  const entry = element("div", "project-launch-row");
  const main = projectResource(project, { landing: true, recentProject });
  const actions = element("span", "project-quick-actions");
  const editButton = element("button", "secondary-button project-quick-edit", "编辑");
  editButton.type = "button";
  editButton.title = `直接编辑项目：${project.path}`;
  const launchButton = element("button", "secondary-button project-quick-launch", "校验中…");
  launchButton.type = "button";
  launchButton.disabled = true;
  const status = element("small", "project-quick-status", "读取上次配置…");
  const running = sessionsForProject(project).find((session) => session.status === "running");
  if (running) actions.append(terminalOpenButton(running.name));
  actions.append(editButton, launchButton, status);
  entry.append(main, actions);
  editButton.addEventListener("click", async () => {
    if (projectKey(project) === loadedProjectKey) return enterEditor();
    if (await loadProject(project)) enterEditor();
  });
  launchButton.addEventListener("click", async () => {
    try {
      const state = await projectLaunchState(project);
      if (!state.validation.valid) return;
      const result = await executeQuickLaunch(state.workbench, launchButton, status);
      if (result) {
        projectLaunchCache.delete(projectKey(project));
        if (!actions.querySelector(".terminal-open-button")) actions.prepend(terminalOpenButton(state.workbench.session));
      }
    } catch (error) {
      launchButton.disabled = true;
      launchButton.textContent = "无法校验";
      launchButton.title = error.message;
      status.textContent = error.message;
      toast(error.message, "error");
    }
  });
  prepareProjectQuickLaunch(project, launchButton, status);
  return entry;
}

function sessionResource(session) {
  const selected = session.name === workbench.session;
  const button = element("button", `resource-item session-resource${selected ? " is-selected" : ""}`);
  button.type = "button";
  button.title = session.workspace ? `预览会话与关联项目：${session.workspace}` : `预览会话：${session.name}`;
  button.setAttribute("aria-pressed", String(selected));
  button.append(element("span", "resource-glyph", session.status === "running" ? "●" : "SS"));
  const copy = element("span", "resource-copy");
  copy.append(
    element("b", "", session.name),
    element("small", "", session.workspace || "未记录关联项目"),
  );
  const meta = element("span", "resource-meta");
  meta.append(element("span", `resource-badge ${session.status}`, session.status));
  if (session.socketLabel) {
    const socketBadge = element("span", "resource-badge socket", session.socketLabel);
    socketBadge.title = `Socket 归属：${session.socketLabel}`;
    meta.append(socketBadge);
  }
  meta.append(element("span", "resource-stat", `${session.roles?.length || 0} ROLES`));
  button.append(copy, meta);
  button.addEventListener("click", () => openDetail(sessionDetailView(session), button));
  return button;
}

function renderResourceBrowser() {
  updateInPlace(renderResourceBrowserContent);
}

function renderResourceBrowserContent() {
  const sessions = bootstrap.sessionOptions || fallbackSessionOptions();
  $$('[data-session-filter]').forEach((button) => button.classList.toggle("is-active", button.dataset.sessionFilter === sessionFilter));
  const visibleSessions = sessionFilter === "project"
    ? sessions.filter((session) => session.workspace === workbench.workspace && session.name === workbench.projectName)
    : sessions;
  const sessionList = $("#session-options");
  sessionList.replaceChildren(...(visibleSessions.length
    ? visibleSessions.map(sessionResource)
    : [resourceEmpty(
      sessionFilter === "project" ? "当前项目没有会话" : "还没有 GSB 会话",
      sessionFilter === "project" ? "切换到「全部会话」或启动一个新会话" : "启动后会在这里显示运行状态",
    )]));
}

function renderProjectLanding() {
  const recentProject = projectRef(bootstrap.recentProjects?.[0]);
  const projects = [...(bootstrap.projectOptions || fallbackProjectOptions())].sort((left, right) => (
    Number(projectKey(right) === projectKey(recentProject)) - Number(projectKey(left) === projectKey(recentProject))
  ));
  $("#landing-project-count").textContent = String(projects.length).padStart(2, "0");
  $("#landing-project-options").replaceChildren(...(projects.length
    ? projects.map((project) => projectLandingEntry(project, recentProject))
    : [resourceEmpty("还没有最近项目", "输入绝对路径或选择目录，首次配置会自动加入这里")]));
  if (!$("#landing-project-path").value) $("#landing-project-path").value = workbench?.workspace || recentProject.path;
  $("#landing-project-status").lastChild.textContent = persistentError
    ? ` ${persistentError}`
    : workbench?.workspace ? ` 当前项目：${workbench.workspace}` : " 选择项目后进入完整工作台。";
}

function currentProjectOption() {
  const projects = bootstrap.projectOptions || fallbackProjectOptions();
  const current = workbenchProject();
  const sessions = sessionsForProject(current);
  return projects.find((project) => projectKey(project) === projectKey(current)) || {
    ...current,
    name: current.name || current.path.split("/").filter(Boolean).at(-1) || "当前项目",
    configured: true,
    sessions: sessions.length,
    running: sessions.filter((session) => session.status === "running").length,
  };
}

function renderEditorProjectBar() {
  if (!workbench) return;
  const project = currentProjectOption();
  $("#editor-project-name").textContent = project.name;
  $("#editor-project-path").textContent = project.path;
  const origin = $("#editor-template-origin");
  origin.textContent = templateStatus(workbench);
  origin.hidden = !origin.textContent;
  $("#project-switcher").title = `只读预览当前项目：${project.path}`;
}

function enterEditor(sectionId = "sec-templates") {
  setWorkspaceReady(true);
  goToStep(sectionId);
}

// Re-reads server state after leaving template mode, so the landing lists and
// the restored project reflect anything the upgrade wrote to disk.
async function reloadLandingState() {
  try {
    const fresh = await api("/api/bootstrap");
    bootstrap = fresh;
    workbench = fresh.workbench ? clone(fresh.workbench) : null;
    loadedWorkspace = workbench?.workspace || "";
    loadedProjectKey = projectKey(workbenchProject());
    if (workbench) markWorkbenchClean();
  } catch (error) {
    toast(`刷新项目列表失败：${error.message}`, "error");
  }
}

async function returnToProjectLanding() {
  const dirty = hasUnsavedChanges();
  if (!await confirmDiscard("返回项目列表")) return false;
  if (templateEditMode) {
    // Leaving template mode discards the scratch workbench and reloads the
    // real project (or a projectless landing) from the server.
    templateEditMode = null;
    workbench = null;
    loadedProjectKey = "";
    cleanWorkbenchSnapshot = null;
    cleanWorkbenchFingerprint = "";
    resetValidationState();
    await reloadLandingState();
    setWorkspaceReady(false);
    renderProjectLanding();
    renderTemplateLanding();
    $("#landing-project-path").focus();
    return true;
  }
  if (dirty && cleanWorkbenchSnapshot) {
    workbench = clone(cleanWorkbenchSnapshot);
    loadedWorkspace = workbench.workspace || loadedWorkspace;
    loadedProjectKey = projectKey(workbenchProject());
    currentRole = Math.min(currentRole, Math.max(0, workbench.roles.length - 1));
    resetValidationState();
    renderAll();
    markWorkbenchClean();
  }
  setWorkspaceReady(false);
  renderProjectLanding();
  $("#landing-project-path").focus();
  return true;
}

function setWorkspaceReady(ready) {
  const templateMode = Boolean(templateEditMode);
  $("#sec-projects").hidden = ready;
  sectionIds.forEach((id) => { document.getElementById(id).hidden = !ready; });
  $(".stepper").hidden = !ready;
  $$(".step[data-section]").forEach((button) => { button.hidden = button.dataset.section === "sec-projects"; });
  $("#nav-validation").hidden = !ready;
  $("#landing-head").hidden = ready;
  $("#editor-project-bar").hidden = !ready || templateMode;
  $("#template-mode-bar").hidden = !ready || !templateMode;
  $(".summary-panel").hidden = !ready;
  $(".actionbar").hidden = !ready;
  $(".shell").classList.toggle("is-project-only", !ready);
  const brand = $("#brand-home");
  brand.setAttribute("aria-disabled", String(!ready));
  brand.title = ready ? "返回首页（项目与模板总览）" : "已在首页";
  // A template has no project target or session, so runtime + launch are meaningless here.
  $("#sec-runtime").hidden = !ready || templateMode;
  $$(".step[data-section='sec-runtime']").forEach((button) => { button.hidden = templateMode; });
  $("#launch-workbench").hidden = templateMode;
  $("#save-config").parentElement.hidden = templateMode;
  $("#save-template-mode").hidden = !templateMode;
  if (templateMode) {
    $("#template-mode-name").textContent = templateEditMode.name;
    $("#template-mode-note").textContent = `模板 ID ${templateEditMode.id} · 改动只写模板，保存后可同步关联项目`;
  }
  if (!ready) activateSection("sec-projects");
}

function resourceEmpty(title, copy) {
  const empty = element("div", "resource-empty");
  empty.append(element("b", "", title), element("small", "", copy));
  return empty;
}

async function loadProject(value, options = {}) {
  const project = projectRef(value);
  const workspace = project.path;
  if (projectKey(project) === loadedProjectKey) {
    toast("当前项目已经选中");
    return false;
  }
  if (projectKey(project) !== loadedProjectKey && !options.discardConfirmed && !await confirmDiscard(`载入项目 ${project.name || workspace}`)) {
    if (workbench) {
      workbench.workspace = loadedWorkspace;
      renderRuntime();
      renderSummary();
    }
    return false;
  }
  const browser = $(".runtime-browser");
  browser.setAttribute("aria-busy", "true");
  try {
    const result = await api("/api/project", {
      method: "POST",
      body: JSON.stringify({ workspace, name: project.name, create: options.create === true }),
    });
    workbench = clone(result.workbench);
    loadedWorkspace = workspace;
    loadedProjectKey = projectKey(workbenchProject());
    markWorkbenchClean();
    bootstrap.projectOptions = result.projectOptions;
    bootstrap.sessionOptions = result.sessionOptions;
    bootstrap.recentProjects = result.recentProjects;
    currentRole = 0;
    currentStep = 0;
    visitedSteps = new Set([0]);
    resetValidationState();
    setPersistentError();
    renderAll();
    toast(`已载入项目 ${workbench.projectName || workspace.split("/").filter(Boolean).at(-1) || workspace}`);
    return true;
  } catch (error) {
    toast(error.message, "error");
    setPersistentError(error.message);
    return false;
  } finally {
    browser.removeAttribute("aria-busy");
  }
}

async function selectSession(session) {
  const target = { path: session.workspace, name: session.name };
  if (session.workspace && projectKey(target) !== loadedProjectKey) {
    if (!await confirmDiscard(`载入会话 ${session.name} 关联的项目`)) return false;
    return loadProject(target, { discardConfirmed: true });
  }
  if (session.name === workbench.projectName) return true;
  toast("会话名由项目名固定；请打开该会话关联的项目", "error");
  return false;
}

async function refreshResources({ silent = false } = {}) {
  const button = $("#refresh-resources");
  button.classList.add("is-loading");
  button.disabled = true;
  try {
    const result = await api(`/api/resources?project=${encodeURIComponent(workbench.workspace || "")}&name=${encodeURIComponent(workbench.projectName || "")}`);
    bootstrap.projectOptions = result.projectOptions;
    bootstrap.sessionOptions = result.sessionOptions;
    bootstrap.recentProjects = result.recentProjects;
    renderResourceBrowser();
    renderProjectLanding();
    if (!silent) toast("项目与会话状态已刷新");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.classList.remove("is-loading");
    button.disabled = false;
  }
}

function renderSummary() {
  $("#summary-count").textContent = String(workbench.roles.length).padStart(2, "0");
  $("#summary-name").textContent = workbench.name || "Untitled Workbench";
  $("#summary-path").textContent = templateEditMode
    ? `模板 ${templateEditMode.id} · 不绑定项目`
    : persistentError ? `错误：${persistentError}` : (workbench.workspace || "尚未选择项目");
  $("#summary-path").title = persistentError ? (workbench.workspace || "") : "";
  $("#summary-profile").textContent = profileName(workbench.profile);
  $("#summary-session").textContent = workbench.session || "—";
  $("#summary-permission").textContent = (workbench.permission || "balanced").toUpperCase();
  $("#summary-watch").textContent = workbench.watchdog === false ? "OFF" : "ON";
  $("#save-config").textContent = "保存配置";
  $("#save-config-note").textContent = workbench.profile?.startsWith("user:")
    ? "写入项目 · 可选择覆盖模板"
    : "写入项目 .gsb-local";
  $("#spoke-dots").replaceChildren(...workbench.roles.filter((role) => role.id !== "hub").map((role) => element("span", "spoke-dot", role.id.slice(0, 2).toUpperCase())));
  $("#summary-roster").replaceChildren(...workbench.roles.map((role) => {
    const item = element("li");
    const body = element("span");
    body.append(element("b", "", role.id), element("small", "", `${role.agent || "unset"} / ${role.model || "agent default"}`));
    item.append(body);
    return item;
  }));
  renderSaveState();
  renderWizardNavigation();
}

function renderAll() {
  updateInPlace(() => {
    setWorkspaceReady(true);
    renderProjectLanding();
    renderTemplateLanding();
    renderProfiles();
    renderRoleList();
    renderRoleEditor();
    if (templateEditMode) renderTemplateModeBar();
    else renderEditorProjectBar();
    renderRuntime();
    renderSummary();
    renderWizardNavigation();
  });
  syncLaunchButton();
}

function renderTemplateModeBar() {
  $("#template-mode-name").textContent = templateEditMode.name;
  const consumers = templateConsumerCount(templateEditMode.id);
  const version = templateOrigin(workbench)?.version;
  $("#template-mode-note").textContent = `${templateEditMode.id} · v${version === "unknown" ? "?" : version} · ${consumers} 个项目在用`;
}

function activateSection(sectionId) {
  $$(".step").forEach((node) => {
    const active = node.dataset.section === sectionId;
    node.classList.toggle("is-active", active);
    node.setAttribute("aria-current", active ? "step" : "false");
  });
}

function stepComplete(sectionId) {
  if (!workbench) return false;
  if (sectionId === "sec-templates") return workbench.roles.length > 0 && workbench.roles.some((role) => role.id === "hub");
  if (sectionId === "sec-roster") {
    return workbench.roles.some((role) => role.id === "hub")
      && workbench.roles.every((role) => typeof role.agent === "string" && role.agent.trim());
  }
  if (sectionId === "sec-runtime") return /^[A-Za-z0-9._-]+$/.test(workbench.session || "");
  return validationResult?.valid === true && validatedWorkbenchFingerprint === workbenchFingerprint();
}

function renderWizardNavigation() {
  if (!workbench || $(".shell").classList.contains("is-project-only")) return;
  sectionIds.forEach((id, index) => {
    const section = document.getElementById(id);
    const active = index === currentStep;
    section.hidden = !active;
    section.classList.toggle("is-active", active);
  });
  $$(".step[data-section]").forEach((button) => {
    const index = sectionIds.indexOf(button.dataset.section);
    const active = index === currentStep;
    const complete = stepComplete(button.dataset.section);
    button.classList.toggle("is-active", active);
    button.classList.toggle("is-complete", complete);
    button.classList.toggle("is-visited", visitedSteps.has(index));
    button.setAttribute("aria-current", active ? "step" : "false");
    const status = button.querySelector(".step-status");
    status.textContent = active ? "●" : complete ? "✓" : "";
    const title = button.querySelector("b")?.textContent || `步骤 ${index + 1}`;
    button.setAttribute("aria-label", `${title}${active ? "，当前步骤" : complete ? "，已完成" : "，未完成"}`);
  });
  $("#previous-step").disabled = currentStep === 0;
  $("#next-step").hidden = currentStep === sectionIds.length - 1;
  $("#wizard-position").textContent = `${String(currentStep + 1).padStart(2, "0")} / ${String(sectionIds.length).padStart(2, "0")}`;
  activateSection(sectionIds[currentStep]);
}

function goToStep(sectionId, { focus = true } = {}) {
  const index = sectionIds.indexOf(sectionId);
  if (index < 0 || !workbench) return false;
  currentStep = index;
  visitedSteps.add(index);
  renderWizardNavigation();
  if (sectionId === "sec-validation") validateAndRender();
  if (focus) {
    requestAnimationFrame(() => {
      const heading = document.querySelector(`#${sectionId} h2`);
      heading?.focus({ preventScroll: true });
      window.scrollTo({ left: 0, top: Math.max(0, $(".shell").offsetTop - 10), behavior: "auto" });
    });
  }
  return true;
}

function toggleValidation(force) {
  if (force === false) return;
  if ($("#detail-panel").classList.contains("is-open")) toggleDetail(false, { restoreFocus: false });
  goToStep("sec-validation");
}

function syncLaunchButton() {
  const button = $("#launch-workbench");
  let hint = $("#launch-validation-hint");
  if (!hint) {
    hint = element("small", "launch-validation-hint");
    hint.id = "launch-validation-hint";
    hint.setAttribute("role", "status");
    button.before(hint);
  }
  const current = validatedWorkbenchFingerprint === workbenchFingerprint();
  const errors = current ? (validationResult?.errors || []) : [];
  const errorMessage = errors.length ? `${errors.length} 项校验错误阻止启动，请先修复` : "";
  const pending = validationPending && !current;
  hint.textContent = errorMessage;
  hint.hidden = !errorMessage;
  button.disabled = launchPending || errors.length > 0;
  if (errorMessage) button.setAttribute("aria-describedby", hint.id);
  else button.removeAttribute("aria-describedby");
  button.title = launchPending ? "正在启动工作台" : errorMessage || (pending ? "正在校验最新草稿" : "保存配置并在后台启动 GSB 工作台");
  button.lastChild.textContent = launchPending ? " 正在启动…" : pending ? " 校验中…" : " 保存并后台启动";
}

function renderValidation() {
  const box = $("#validation-box");
  box.classList.remove("is-loading");
  box.replaceChildren();
  const errors = validationResult?.errors || [];
  const warnings = validationResult?.warnings || [];
  const summary = element("div", `check-summary${errors.length ? " has-errors" : ""}`);
  summary.append(element("div", "check-mark", errors.length ? "!" : "✓"));
  const copy = element("div");
  copy.append(element("b", "", errors.length ? `${errors.length} 项阻止启动` : "工作台配置可启动"));
  copy.append(element("small", "", warnings.length ? `${warnings.length} 项需要留意` : "角色、路径和命令检查通过"));
  summary.append(copy);
  box.append(summary);
  if (errors.length) {
    const list = element("ul", "issue-list errors");
    errors.forEach((error) => list.append(element("li", "", error)));
    box.append(list);
  }
  if (warnings.length) {
    const list = element("ul", "issue-list");
    warnings.forEach((warning) => list.append(element("li", "", warning)));
    box.append(list);
  }
  syncLaunchButton();
  renderWizardNavigation();
}

function renderPreview() {
  $("#config-output").textContent = previewFiles[previewKind] || "# No model overrides — Agent defaults will be used.\n";
  $$(".preview-tab").forEach((tab) => {
    const selected = tab.dataset.preview === previewKind;
    tab.classList.toggle("is-active", selected);
    tab.setAttribute("aria-selected", String(selected));
  });
}

function clearFieldValidation() {
  ["#workspace-path", "#session-name", "#role-id", "#role-agent", "#role-model"].forEach((selector) => {
    const field = $(selector);
    field.setCustomValidity("");
    field.removeAttribute("aria-invalid");
  });
}

function applyFieldValidation() {
  clearFieldValidation();
  const errors = validationResult?.errors || [];
  const roleId = workbench.roles[currentRole]?.id || "";
  const mappings = [
    ["#workspace-path", (message) => message.includes("项目路径") || message.includes("无法检查项目路径")],
    ["#session-name", (message) => message.includes("会话")],
    ["#role-id", (message) => message.includes("角色 ID") || message.includes("角色重复") || message.includes("只能包含一个 hub")],
    ["#role-agent", (message) => (message.includes(`角色 ${roleId}`) && message.includes("Agent")) || message.startsWith(`${roleId}: 找不到命令`)],
    ["#role-model", (message) => message.includes(`角色 ${roleId}`) && message.includes("模型")],
  ];
  for (const [selector, matches] of mappings) {
    const messages = errors.filter(matches);
    if (!messages.length) continue;
    const field = $(selector);
    field.setCustomValidity(messages.join("；"));
    field.setAttribute("aria-invalid", "true");
  }
}

function scheduleValidation() {
  clearTimeout(validationTimer);
  validationRevision++;
  validatedWorkbenchFingerprint = "";
  validationPending = true;
  clearFieldValidation();
  syncLaunchButton();
  validationTimer = setTimeout(() => requestValidation({ renderFinal: sectionIds[currentStep] === "sec-validation" }), 600);
}

async function requestValidation({ renderFinal = false, reportField = null } = {}) {
  const fingerprint = workbenchFingerprint();
  if (validatedWorkbenchFingerprint === fingerprint && validationResult) {
    validationPending = false;
    applyFieldValidation();
    syncLaunchButton();
    if (renderFinal) {
      renderValidation();
      renderPreview();
    }
    if (reportField && !reportField.checkValidity()) reportField.reportValidity();
    return;
  }
  clearTimeout(validationTimer);
  const revision = ++validationRevision;
  validationPending = true;
  syncLaunchButton();
  if (renderFinal) {
    const box = $("#validation-box");
    box.className = "validation-box is-loading";
    box.replaceChildren(element("div", "validation-spinner"), element("p", "", "正在检查角色、命令、项目和会话配置…"));
  }
  try {
    const result = await api("/api/validate", { method: "POST", body: JSON.stringify({ workbench, scope: templateEditMode ? "template" : "project" }) });
    if (revision !== validationRevision || fingerprint !== workbenchFingerprint()) return;
    validationResult = result.validation;
    previewFiles = result.files;
  } catch (error) {
    if (revision !== validationRevision || fingerprint !== workbenchFingerprint()) return;
    validationResult = { valid: false, errors: [error.message], warnings: [] };
  }
  validationPending = false;
  validatedWorkbenchFingerprint = fingerprint;
  applyFieldValidation();
  syncLaunchButton();
  if (renderFinal) {
    renderValidation();
    renderPreview();
  }
  if (reportField && !reportField.checkValidity()) reportField.reportValidity();
}

function validateAndRender() {
  return requestValidation({ renderFinal: true });
}

function updateRole(field, value) {
  const role = workbench.roles[currentRole];
  if (!role) return;
  role[field] = value;
  if (field === "id" && role.promptMode === "layered") {
    const prompt = basePromptForRole(value);
    role.promptTemplate = prompt?.id || "";
    role.promptBase = prompt?.body?.trim() || "";
    role.prompt = composeLayeredPrompt(role);
    $("#role-prompt-base").textContent = role.promptBase;
    $("#role-custom-prompt").value = role.prompt;
    renderFinalPromptPreview(role);
    $("#prompt-template").value = role.promptTemplate;
  }
  renderRoleList();
  renderSummary();
  if (field === "name" || field === "type") renderRoleEditor();
  scheduleValidation();
}

function addRole() {
  let number = 1;
  while (workbench.roles.some((role) => role.id === `role-${number}`)) number++;
  $("#new-role-id").value = `role-${number}`;
  $("#new-role-id").setCustomValidity("");
  $("#new-role-agent").value = "codex";
  $("#role-dialog").showModal();
  $("#new-role-id").focus();
  $("#new-role-id").select();
}

function createRole(id, agent) {
  const meta = bootstrap.roleMeta[id] || {};
  const base = basePromptForRole(id);
  const role = {
    id,
    name: meta.name || id,
    type: meta.type || "specialist",
    description: meta.description || "自定义协作角色",
    agent,
    model: "",
    promptTemplate: base?.id || "generic",
    promptBase: base?.body?.trim() || "",
    intent: "",
    promptMode: "layered",
  };
  role.prompt = composeLayeredPrompt(role);
  workbench.roles.push({
    ...role,
  });
  currentRole = workbench.roles.length - 1;
  renderRoleList();
  renderRoleEditor();
  renderSummary();
  scheduleValidation();
  goToStep("sec-roster");
}

function removeRole() {
  const role = workbench.roles[currentRole];
  if (!role || role.id === "hub") return;
  workbench.roles.splice(currentRole, 1);
  currentRole = Math.max(0, currentRole - 1);
  renderRoleList();
  renderRoleEditor();
  renderSummary();
  scheduleValidation();
}

async function saveConfig() {
  try {
    const result = await api("/api/save", { method: "POST", body: JSON.stringify({ workbench }) });
    previewFiles = result.files;
    validationResult = result.validation;
    validatedWorkbenchFingerprint = workbenchFingerprint();
    const savedProject = workbenchProject();
    const savedOption = (bootstrap.projectOptions || []).find((project) => projectKey(project) === projectKey(savedProject));
    projectLaunchCache.delete(projectKey(savedProject));
    bootstrap.projectOptions = [{ sessions: 0, running: 0, ...savedOption, ...savedProject, configured: true },
      ...(bootstrap.projectOptions || []).filter((project) => projectKey(project) !== projectKey(savedProject))];
    bootstrap.recentProjects = [savedProject, ...(bootstrap.recentProjects || []).filter((project) => projectKey(project) !== projectKey(savedProject))];
    markWorkbenchClean();
    setPersistentError();
    toast("配置已写入项目的 .gsb-local");
    renderValidation();
    renderPreview();
    await offerTemplateOverwrite(result.templateOverwriteOffer);
  } catch (error) {
    toast(error.message, "error");
    setPersistentError(error.message);
    if (error.payload?.validation) {
      validationResult = error.payload.validation;
      validatedWorkbenchFingerprint = workbenchFingerprint();
      applyFieldValidation();
      renderValidation();
    }
  }
}

async function launch() {
  if (!await confirmFullAccessLaunch(workbench)) return;
  toggleValidation(true);
  launchPending = true;
  syncLaunchButton();
  try {
    const result = await api("/api/launch", { method: "POST", body: JSON.stringify({ workbench }) });
    const panel = $("#launch-result");
    panel.hidden = false;
    panel.classList.remove("is-error");
    panel.replaceChildren(
      element("h3", "", "工作台已在后台启动"),
      element("code", "", result.command),
      terminalCommandRow(workbench.session, result.openCommand || `gsb-local open ${workbench.session}`),
      element("code", "", (result.stdout || "").trim()),
    );
    previewFiles = result.files;
    validationResult = result.validation;
    validatedWorkbenchFingerprint = workbenchFingerprint();
    markWorkbenchClean();
    setPersistentError();
    await refreshResources({ silent: true });
    toast("GSB 工作台已启动");
  } catch (error) {
    const result = error.payload || {};
    if (result.files && result.validation?.valid) {
      previewFiles = result.files;
      validationResult = result.validation;
      validatedWorkbenchFingerprint = workbenchFingerprint();
      markWorkbenchClean();
    }
    const panel = $("#launch-result");
    panel.hidden = false;
    panel.classList.add("is-error");
    panel.replaceChildren(element("h3", "", "启动失败"), element("code", "", result.command || error.message), element("code", "", (result.stderr || "").trim()));
    toast(error.message, "error");
  } finally {
    launchPending = false;
    syncLaunchButton();
  }
}

async function browseForProject({ focusTemplates = false } = {}) {
  try {
    const result = await api("/api/pick-directory", { method: "POST", body: "{}" });
    if (focusTemplates) {
      $("#landing-project-path").value = result.path;
      $("#landing-project-name").value = "";
      $("#landing-project-status").lastChild.textContent = " 已选择目录；请填写全局唯一项目名。";
      $("#landing-project-name").focus();
    } else if (await loadProject({ path: result.path, name: "" })) goToStep("sec-templates");
  } catch (error) {
    if (!/取消/.test(error.message)) toast(error.message, "error");
  }
}

async function checkLandingProjectName({ report = false } = {}) {
  const input = $("#landing-project-name");
  const workspace = $("#landing-project-path").value.trim();
  const name = input.value.trim();
  const key = projectKey({ path: workspace, name });
  input.setCustomValidity("");
  input.removeAttribute("aria-invalid");
  if (!name || !workspace || !input.checkValidity()) {
    if (report) input.reportValidity();
    return !name;
  }
  try {
    await api("/api/project", { method: "POST", body: JSON.stringify({ workspace, name, create: true, remember: false }) });
    if (key !== projectKey({ path: $("#landing-project-path").value.trim(), name: input.value.trim() })) return false;
    $("#landing-project-status").lastChild.textContent = ` 项目名 ${name} 可用。`;
    return true;
  } catch (error) {
    if (key !== projectKey({ path: $("#landing-project-path").value.trim(), name: input.value.trim() })) return false;
    input.setCustomValidity(error.message);
    input.setAttribute("aria-invalid", "true");
    $("#landing-project-status").lastChild.textContent = ` ${error.message}`;
    if (report) input.reportValidity();
    return false;
  }
}

function scheduleLandingProjectNameCheck() {
  clearTimeout(landingNameTimer);
  $("#landing-project-name").setCustomValidity("");
  landingNameTimer = setTimeout(checkLandingProjectName, 300);
}

async function openLandingProjectPath() {
  const input = $("#landing-project-path");
  const workspace = input.value.trim();
  if (!workspace) return input.reportValidity();
  const name = $("#landing-project-name").value.trim();
  clearTimeout(landingNameTimer);
  if (name && !await checkLandingProjectName({ report: true })) return;
  if (await loadProject({ path: workspace, name }, { create: Boolean(name) })) goToStep("sec-templates");
}

function bindEvents() {
  $$(".step[data-section]").forEach((button) => button.addEventListener("click", () => goToStep(button.dataset.section)));
  $("#previous-step").addEventListener("click", () => goToStep(sectionIds[Math.max(0, currentStep - 1)]));
  $("#next-step").addEventListener("click", () => goToStep(sectionIds[Math.min(sectionIds.length - 1, currentStep + 1)]));
  $("#toggle-validation").addEventListener("click", () => toggleValidation());
  $("#close-detail").addEventListener("click", () => toggleDetail(false));
  $("#add-role").addEventListener("click", addRole);
  $("#remove-role").addEventListener("click", removeRole);

  const roleFields = {
    "#role-id": "id",
    "#role-name": "name",
    "#role-agent": "agent",
    "#role-model": "model",
    "#role-description": "description",
  };
  Object.entries(roleFields).forEach(([selector, field]) => $(selector).addEventListener("input", (event) => updateRole(field, event.target.value)));
  $("#role-prompt").addEventListener("input", (event) => {
    const role = workbench.roles[currentRole];
    role.prompt = event.target.value;
    updatePromptStats();
    renderSaveState();
    scheduleValidation();
  });
  $("#role-intent").addEventListener("input", (event) => {
    const role = workbench.roles[currentRole];
    role.intent = event.target.value;
    role.promptMode = "layered";
    if (!role.promptBase?.trim()) role.promptBase = (promptFor(role.promptTemplate) || basePromptForRole(role.id))?.body?.trim() || "";
    role.prompt = composeLayeredPrompt(role);
    $("#role-custom-prompt").value = role.prompt;
    $("#role-prompt-base").textContent = role.promptBase;
    renderFinalPromptPreview(role);
    $("#prompt-advanced-details").open = false;
    updatePromptStats();
    renderSaveState();
    scheduleValidation();
  });
  $("#role-custom-prompt").addEventListener("input", (event) => {
    const role = workbench.roles[currentRole];
    role.prompt = event.target.value;
    role.promptMode = "custom";
    role.promptBase = "";
    role.intent = "";
    $("#role-intent").value = "";
    $("#role-prompt-base").textContent = "自定义全文模式未使用系统基座";
    $("#prompt-template").value = "";
    $("#prompt-lock-copy").textContent = "当前使用自定义全文；Relay、安全边界和运行路径仍由 GSB 协议层追加。";
    renderFinalPromptPreview(role);
    updatePromptStats();
    renderSaveState();
    scheduleValidation();
  });
  $("#prompt-template").addEventListener("change", (event) => {
    const role = workbench.roles[currentRole];
    const prompt = promptFor(event.target.value) || basePromptForRole(role.id);
    role.promptTemplate = prompt?.id || "";
    role.promptBase = prompt?.body?.trim() || "";
    role.intent = "";
    role.promptMode = "layered";
    role.prompt = composeLayeredPrompt(role);
    renderRoleEditor();
    renderSaveState();
    scheduleValidation();
  });
  $$("[data-hub-capability]").forEach((button) => button.addEventListener("click", () => {
    const role = workbench.roles[currentRole];
    if (!role || role.id !== "hub") return;
    const snippet = hubCapabilitySnippets[button.dataset.hubCapability];
    if (!snippet) return;
    const heading = snippet.split("\n", 1)[0];
    if ((role.prompt || "").includes(heading)) {
      toast(`${button.textContent.replace(/^\+\s*/, "")}能力已经存在`);
      return;
    }
    role.prompt = role.prompt?.trim() ? `${role.prompt.trim()}\n\n${snippet}` : snippet;
    role.promptTemplate = "";
    renderRoleEditor();
    renderSaveState();
    scheduleValidation();
    $("#role-prompt").focus();
    $("#role-prompt").setSelectionRange(role.prompt.length, role.prompt.length);
  }));

  $("#workspace-path").addEventListener("input", (event) => {
    workbench.workspace = event.target.value;
    renderResourceBrowser();
    renderSummary();
    scheduleValidation();
  });
  $("#workspace-path").addEventListener("change", (event) => {
    if (event.target.value && event.target.value !== loadedWorkspace) loadProject({ path: event.target.value, name: "" });
  });
  $("#workbench-name").addEventListener("input", (event) => { workbench.name = event.target.value; renderSummary(); scheduleValidation(); });
  $$('input[name="permission"]').forEach((input) => input.addEventListener("change", (event) => { workbench.permission = event.target.value; renderSummary(); scheduleValidation(); }));
  $("#watchdog-enabled").addEventListener("change", (event) => { workbench.watchdog = event.target.checked; renderSummary(); scheduleValidation(); });
  $("#rebuild-session").addEventListener("change", (event) => { workbench.rebuild = event.target.checked; renderSaveState(); scheduleValidation(); });
  ["#workspace-path", "#session-name", "#role-id", "#role-agent", "#role-model"].forEach((selector) => {
    $(selector).addEventListener("blur", (event) => requestValidation({ reportField: event.currentTarget }));
  });
  $$('[data-session-filter]').forEach((button) => button.addEventListener("click", () => {
    sessionFilter = button.dataset.sessionFilter;
    renderResourceBrowser();
  }));
  $("#refresh-resources").addEventListener("click", refreshResources);
  $("#browse-project").addEventListener("click", () => browseForProject());
  $("#landing-browse-project").addEventListener("click", () => browseForProject({ focusTemplates: true }));
  $("#landing-open-project").addEventListener("click", openLandingProjectPath);
  $("#landing-project-name").addEventListener("input", scheduleLandingProjectNameCheck);
  $("#landing-project-path").addEventListener("input", scheduleLandingProjectNameCheck);
  $("#landing-project-path").addEventListener("keydown", (event) => {
    if (event.key === "Enter") openLandingProjectPath();
  });
  $("#project-switcher").addEventListener("click", (event) => openProjectDetail(currentProjectOption(), event.currentTarget));
  $("#return-projects").addEventListener("click", returnToProjectLanding);
  $("#return-projects-from-template").addEventListener("click", returnToProjectLanding);
  // The brand is the always-available way home — the landing page is the
  // dashboard, so it must be reachable from anywhere, not only via the
  // contextual bar inside a stage.
  $("#brand-home").addEventListener("click", () => {
    if ($(".shell").classList.contains("is-project-only")) return;
    returnToProjectLanding();
  });
  $("#save-template-mode").addEventListener("click", saveTemplateEdits);
  $("#detail-backdrop").addEventListener("click", () => toggleDetail(false));

  $$(".preview-tab").forEach((button) => button.addEventListener("click", () => { previewKind = button.dataset.preview; renderPreview(); }));
  $("#save-config").addEventListener("click", saveConfig);
  $("#discard-changes").addEventListener("click", discardChanges);
  $("#launch-workbench").addEventListener("click", launch);
  $("#save-template").addEventListener("click", () => {
    $("#template-name").value = workbench.name || "My Workbench";
    $("#template-dialog").showModal();
    $("#template-name").focus();
  });
  $("#new-role-id").addEventListener("input", (event) => event.currentTarget.setCustomValidity(""));
  $("#role-dialog form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (event.submitter?.value === "cancel") {
      $("#role-dialog").close();
      return;
    }
    const idInput = $("#new-role-id");
    const agentInput = $("#new-role-agent");
    const id = idInput.value.trim();
    const agent = agentInput.value.trim();
    idInput.setCustomValidity(workbench.roles.some((role) => role.id === id) ? "角色 ID 已存在" : "");
    if (!idInput.reportValidity() || !agentInput.reportValidity()) return;
    createRole(id, agent);
    $("#role-dialog").close();
  });
  $("#confirm-template").addEventListener("click", async (event) => {
    event.preventDefault();
    const name = $("#template-name").value.trim();
    if (!name) return $("#template-name").reportValidity();
    try {
      const origin = templateOrigin();
      const result = await api("/api/templates", { method: "POST", body: JSON.stringify({ id: origin?.id, name, workbench }) });
      bootstrap.userTemplates = result.templates;
      workbench.profile = `user:${result.template.id}`;
      const currentIncluded = result.upgradePlan?.projects.some((project) => projectKey(project) === projectKey(workbenchProject()));
      if (!currentIncluded) workbench.templateOrigin = { id: result.template.id, version: result.template.version };
      $("#template-dialog").close();
      renderProfiles();
      renderEditorProjectBar();
      renderSummary();
      scheduleValidation();
      openTemplateUpgrade(result.upgradePlan);
      toast(`个人模板已保存为 v${result.template.version}`);
    } catch (error) {
      toast(error.message, "error");
    }
  });
  $("#confirm-template-upgrade").addEventListener("click", applyPendingTemplateUpgrade);
  $("#create-template-dialog form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (event.submitter?.value === "cancel") {
      $("#create-template-dialog").close();
      return;
    }
    const name = $("#new-template-name").value.trim();
    if (!name) return $("#new-template-name").reportValidity();
    const button = $("#confirm-create-template");
    button.disabled = true;
    button.textContent = "正在创建…";
    try {
      if (await createIndependentTemplate(name)) $("#create-template-dialog").close();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      button.disabled = false;
      button.textContent = "创建并配置角色";
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if ($("#detail-panel").classList.contains("is-open")) toggleDetail(false);
  });
}

async function start() {
  if (!token) throw new Error("缺少本地 Studio token，请从 gsb-local studio 输出的地址进入");
  bootstrap = await api("/api/bootstrap");
  if (bootstrap.product?.apiVersion !== 2) {
    throw new Error("Studio 服务端版本过旧。请回到启动它的终端按 Ctrl-C，然后重新运行 gsb-local studio");
  }
  workbench = bootstrap.workbench ? clone(bootstrap.workbench) : null;
  loadedWorkspace = workbench?.workspace || "";
  loadedProjectKey = projectKey(workbenchProject());
  $("#browse-project").hidden = bootstrap.platform !== "darwin";
  $("#landing-browse-project").hidden = bootstrap.platform !== "darwin";
  bootstrap.modelSuggestions.forEach((model) => $("#model-options").append(new Option(model.label, model.value)));
  bindEvents();
  if (workbench) {
    markWorkbenchClean();
    renderAll();
  } else {
    setWorkspaceReady(false);
    renderProjectLanding();
    renderTemplateLanding();
  }
}

window.addEventListener("beforeunload", (event) => {
  if (!hasUnsavedChanges()) return;
  event.preventDefault();
  event.returnValue = "";
});

start().catch((error) => {
  $("#landing-project-options").replaceChildren(element("div", "empty-state", `Studio 初始化失败：${error.message}`));
  toast(error.message, "error");
});
