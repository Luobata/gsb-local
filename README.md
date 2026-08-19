# GSB Local Workbench

本项目在本机复刻截图中的终端工作台：iTerm2 作为终端窗口，Zellij 负责分屏，Claude Code、Codex、Kimi 或自定义命令运行一个 Hub 和任意数量的可插拔 Spoke。

> 这不是 Seed 团队内部 GSB 的官方实现。内部同名仓库目前没有可安装代码；本项目只复刻可见的 Hub/Spoke 工作方式和界面结构。

## 启动

先检查环境：

```bash
gsb-local --check
```

在任意目录启动：

```bash
gsb-local /path/to/your/repository
```

只在后台创建、不立即占用当前终端：

```bash
gsb-local --background /path/to/your/repository
```

显式以最高权限启动内置 Agent：

```bash
gsb-local --full-access /path/to/your/repository my-task
```

`--full-access` 会让 Codex 绕过审批与沙箱、Claude 使用 `bypassPermissions`、Kimi 使用完全自动的 `auto`。它只影响新创建或通过 `--rebuild` 重建的 Pane，不会改变已经运行的会话。该模式允许 Agent 执行系统级和破坏性操作，只应在可信工作区临时使用。`shell:<command>` 不受内置适配器控制，但会收到 `GSB_FULL_ACCESS=true` 和 `GSB_PERMISSION_PROFILE=full-access`。

第二个参数可指定 Zellij 会话名：

```bash
gsb-local /path/to/your/repository my-task
```

### 命名配置 Profile

使用内置 `config2`，让 Hub 使用 `claude-0812`、`core-bug` 使用 Codex，其余角色保持默认：

```bash
gsb-local --config2 /path/to/your/repository my-task
```

`--config config2` 与 `--config2` 等价。通用命名 Profile 会优先读取项目内的 `.gsb-local/profiles/<名称>.conf`，不存在时读取 GSB 安装目录的 `profiles/<名称>.conf`。显式选择 Profile 时，它优先于项目的 `.gsb-local/agents.conf`；对应的 `GSB_<ROLE>_AGENT` 环境变量仍可做最终的单角色覆盖。

对已经运行的同名会话，配置选择不会热替换 Pane；使用新会话名，或者显式加 `--rebuild`：

```bash
gsb-local --rebuild --config2 /path/to/your/repository my-task
```

内置 `config3` 以 `config2` 为基础，把其中使用 Codex 的角色全部替换为 `claude-0812`：

```bash
gsb-local --config3 /path/to/your/repository my-task
```

`--config config3` 与 `--config3` 等价。

内置 `config4` 使用 `claude-glm-5.3` 作为 Hub 和 plan-backup，core-bug 保留 `claude-0812`：

```bash
gsb-local --config4 /path/to/your/repository my-task
```

`--config config4` 与 `--config4` 等价。编号快捷参数统一按 `--configN` 解析；对应的 Profile 文件不存在时会明确报错。

再次运行同一命令会重新连接活跃会话；如果会话已被关闭成 dead 状态，会保留共享任务板并按当前角色配置重新创建 Agent。没有项目配置时，启动器读取 [`defaults/agents.conf`](defaults/agents.conf)，默认映射为：Hub/plan-backup 使用 Codex，core-bug 使用 `claude-0812`，ops-gov 使用 `claude-relay`，UI 使用 Kimi。临时把这套默认配置的所有角色统一切换到 Codex：

```bash
GSB_AGENT=codex gsb-local /path/to/your/repository
```

`GSB_AGENT` 只批量覆盖内置默认配置；项目已经存在 `.gsb-local/agents.conf` 时，以项目配置和对应的 `GSB_<ROLE>_AGENT` 覆盖为准。

Claude Code 默认沿用你当前配置的模型，并使用 `acceptEdits` 权限模式。可按需覆盖模型、推理强度或权限模式：

```bash
GSB_MODEL=opus GSB_EFFORT=high GSB_PERMISSION_MODE=manual gsb-local /path/to/repository
```

## 可插拔角色与每个 Pane 的命令

在项目中创建 `.gsb-local/agents.conf`：

```ini
hub=claude:claude-relay
core-bug=codex
ops-gov=claude
plan-backup=claude
ui=kimi
```

- 每个非注释行就是一个活动角色，配置顺序就是右侧 Spoke 的排列顺序；`hub` 必须存在。
- 新增一行会新增 Pane、信箱、契约和路由；删除一行并 `--rebuild` 会移除该活动角色，但保留历史报告和消息文件。
- 角色名使用小写字母、数字和连字符，例如 `ui`、`test-review`。
- 每个角色必须有提示词。优先读取项目的 `.gsb-local/prompts/<role>.md`，其次读取内置 `prompts/<role>.md`。
- `claude`、`codex`、`kimi`：使用各自独立的内置 CLI 适配器。
- `claude-relay` 这类裸命令：视为 Claude 参数兼容的可执行文件或 zsh alias。
- `claude:<binary>`：让一个 Claude 参数兼容的包装命令运行该 Pane，例如 `claude:claude-relay`。
- `codex:<binary>`：让一个 Codex 参数兼容的包装命令运行该 Pane。
- `kimi:<binary>`：让一个 Kimi 参数兼容的包装命令运行该 Pane。GSB 会生成运行态 Kimi agent file 注入角色协议。
- `shell:<command>`：完全自定义启动命令。命令可以读取 `GSB_ROLE`、`GSB_DISPLAY_NAME`、`GSB_ROLE_PROMPT`、`GSB_SHARED_PROMPT`、`GSB_TASK_BOARD` 和 `GSB_REPORTS_DIR` 环境变量。

查看最终生效配置：

```bash
gsb-local --print-config /path/to/your/repository
```

配置修改后，重建 Pane 使其生效：

```bash
gsb-local --rebuild /path/to/your/repository
```

也可以临时用环境变量单独覆盖某个 Pane；环境变量优先于配置文件：

```bash
GSB_HUB_AGENT=claude:claude-relay \
GSB_CORE_BUG_AGENT=codex \
GSB_OPS_GOV_AGENT=claude \
GSB_PLAN_BACKUP_AGENT=codex \
GSB_UI_AGENT=kimi \
gsb-local --rebuild /path/to/your/repository
```

环境变量名按角色动态生成：角色名转大写、连字符转下划线，再加 `GSB_` 和 `_AGENT`。例如 `test-review` 对应 `GSB_TEST_REVIEW_AGENT`。

### UI/Kimi 插件

内置 `ui` 角色覆盖所有设计和 UI 工作，包括产品/UX/视觉/交互设计、设计系统、截图分析、展示层实现、响应式、无障碍和视觉验收。Hub 遇到包含这些内容的任务时，只要 `ui` 在活动角色表中，就必须把 UI 部分拆给它。

启用：

```ini
ui=kimi
```

移除：删除这一行，然后执行：

```bash
gsb-local --rebuild /path/to/your/repository
```

### 默认审批策略

GSB 默认采用“常规工作自动执行、越界或高风险操作再请求授权”的审批策略：

- Codex：`on-request` + `workspace-write`，工作区内正常执行，需要越出沙箱时请求授权。
- Claude：`acceptEdits`，自动批准工作区内的文件编辑和常见文件操作；其他 Shell 命令、受保护路径和工作区外操作仍按 Claude 权限规则处理。
- Kimi：`yolo`，自动批准常规工具调用，但仍可发起询问；不会启用完全无人值守的 `auto`。

可以分别通过 `GSB_CODEX_APPROVAL`、`GSB_CODEX_SANDBOX`、`GSB_PERMISSION_MODE` 和 `GSB_KIMI_PERMISSION` 临时覆盖。`bypassPermissions`、Codex 的 `danger-full-access` 和 Kimi 的 `auto` 都不是默认值。

Kimi 默认使用其托管 Provider 中已注册的 `kimi-code/k3-256k` 别名。可用 `GSB_KIMI_MODEL` 只覆盖 Kimi Pane；如果未设置该变量，则兼容使用全局 `GSB_MODEL`，最后才回退到 `kimi-code/k3-256k`：

```bash
GSB_KIMI_MODEL=kimi-code/k3 gsb-local --rebuild /path/to/your/repository
```

为避免目标仓库的项目级 Agent、MCP 或插件在未审核时自动生效，Kimi 默认从 GSB 安装目录启动，并通过 `--add-dir` 访问目标仓库。可用 `GSB_KIMI_HOST_CWD` 指定另一个已信任、无项目扩展的宿主目录；这不会改变 `GSB_WORKSPACE` 或契约中的实际工作路径。

## 布局

- `hub.<session>.main`：接收目标、读取活动角色表、拆分工作、审核报告并决定最终方案。
- `spk.<session>.<role>`：按配置动态生成；删除角色后不再生成对应 Pane。
- 默认诊断角色：`core-bug`、`ops-gov`、`plan-backup`。
- 可选 UI 角色：`ui`，默认交给 Kimi。

所有活动 Agent 共享一个任务板和角色名册，保存在：

```text
~/.local/state/gsb-local/<session>/TASK.md
~/.local/state/gsb-local/<session>/ROLES.md
~/.local/state/gsb-local/<session>/reports/
```

Spoke 默认只调查并写报告。Hub 可以在契约中授予精确路径的写入 allow-list，但同一路径只能有一个写入者，且 Spoke 仍不能 commit、push 或 deploy。

## 派发协议与通信

本地 GSB 从 Workflow OS 的 `agent-dispatch` 中蒸馏了可移植的核心机制，没有整包安装其个人化 Dubhe、harness-pro、TRAE 和运行账本：

- Hub 给每个 Spoke 写五段契约：Objective、Scope、Validation、Stop conditions、Reply route。
- 跨 Pane 内容通过原子 JSON 文件信箱传递，消息只按数据读取，不自动产生批准或提权。
- `nudge` 只发送固定唤醒语，不把任务 payload 直接注入另一个 Agent；提交使用 Zellij 的真实 `Enter` 键事件，以兼容 Kimi Code 的增强键盘协议。
- 启动 Zellij 和 Agent 前会清除继承自父 Claude 的 child-session 标记，避免独立 Pane 被误判为嵌套会话。

运行态目录：

```text
~/.local/state/gsb-local/<session>/contracts/
~/.local/state/gsb-local/<session>/inbox/
~/.local/state/gsb-local/<session>/inbox-archive/
~/.local/state/gsb-local/<session>/reports/
```

在 Agent Pane 内发送消息：

```bash
node "$GSB_LOCAL_ROOT/bin/relay.mjs" send hub progress '{"summary":"repro confirmed"}'
node "$GSB_LOCAL_ROOT/bin/relay.mjs" send hub blocker '{"question":"which branch?","missing":"target branch","safe_fallback":"continue read-only inspection"}'
node "$GSB_LOCAL_ROOT/bin/relay.mjs" send hub result '{"summary":"done","report":"reports/core-bug.md","proof":"3/3 tests passed","caveats":[]}'
bash "$GSB_LOCAL_ROOT/bin/nudge" hub
```

Hub 写好契约后可通知 Spoke：

```bash
node "$GSB_LOCAL_ROOT/bin/relay.mjs" send core-bug progress '{"summary":"contract ready"}'
bash "$GSB_LOCAL_ROOT/bin/nudge" core-bug
```

目标角色由当前 `GSB_ROLES`/`ROLES.md` 动态校验，所以被移除的角色不能继续收到新消息或 nudge。

协议真相源见 [protocol/dispatch.md](protocol/dispatch.md)。

## 看门狗（Watchdog）

Agent CLI 遇到 API 错误时大多不会退出，而是在会话内显示错误并停在输入框，后台 Spoke 会因此静默卡死。看门狗自动处理这类故障：

1. 每 `GSB_WATCHDOG_INTERVAL` 秒（默认 60）抓取每个 Spoke Pane 的视口内容；
2. 用 [`defaults/watchdog-patterns.conf`](defaults/watchdog-patterns.conf) 中的正则匹配视口**底部非空行**（错误提示的位置）；
3. 只有同时满足「连续 2 轮巡检都命中」「屏幕内容静止」「该 Pane 当前和上一轮都未被聚焦」才动作——人正在看的 Pane 绝不打扰；
4. **软恢复**：向 Pane 输入 `continue` 并回车（可用 `GSB_WATCHDOG_RETRY_TEXT` 改）。每小时最多 `GSB_WATCHDOG_MAX_SOFT` 次（默认 3）；
5. 软恢复无效：向 Hub 信箱投递 `blocker` 并 nudge，由 Hub 重新派单或升级给人；
6. 进程退出类故障由 [`bin/supervise`](bin/supervise) 兜底：指数退避重启（30s 起，封顶 5 分钟），超过 `GSB_SUPERVISE_MAX_ATTEMPTS` 次（默认 10）同样给 Hub 发 blocker。

因为契约、信箱、报告都在磁盘上，无论哪种恢复路径，Agent 重启后重读契约即可断点续传。

可选**硬重启**（默认关闭）：`GSB_WATCHDOG_HARD_RESTART=true` 时，软恢复失败的 Spoke 会被 Ctrl-c 终止并由 supervise 重启。

看门狗随会话启动自动在后台运行（单实例锁保护，`--rebuild` 时自动替换旧实例），会话消失后自动退出。关闭：`GSB_WATCHDOG_ENABLED=false`。

日志与自检：

```bash
tail -f ~/.local/state/gsb-local/<session>/watchdog.log   # 看门狗日志
cat ~/.local/state/gsb-local/<session>/agent-files/<role>.exit.log  # 重启记录
node "$GSB_LOCAL_ROOT/bin/watchdog.mjs" --selftest        # 内置自检
```

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `GSB_WATCHDOG_ENABLED` | `true` | 会话启动时是否拉起看门狗 |
| `GSB_WATCHDOG_INTERVAL` | `60` | 巡检间隔（秒） |
| `GSB_WATCHDOG_BOTTOM_LINES` | `15` | 匹配视口底部多少行非空内容 |
| `GSB_WATCHDOG_STALE_POLLS` | `2` | 连续命中多少轮才动作 |
| `GSB_WATCHDOG_RETRY_TEXT` | `continue` | 软恢复时输入的文本 |
| `GSB_WATCHDOG_MAX_SOFT` | `3` | 每小时软恢复上限 |
| `GSB_WATCHDOG_COOLDOWN` | `300` | 同一角色两次动作的最小间隔（秒） |
| `GSB_WATCHDOG_HARD_RESTART` | `false` | 软恢复失败后是否 Ctrl-c 硬重启 |
| `GSB_SUPERVISE_MAX_ATTEMPTS` | `10` | 进程退出后的最大重启次数 |
| `CLAUDE_CODE_MAX_RETRIES` | `10` | Claude 客户端自身的 API 重试次数（第一层防御，旧版本忽略） |

### 故障模型与恢复路径

| 故障类型 | 表现 | 处理者 | 行为 |
| --- | --- | --- | --- |
| API 抖动（429 / overloaded / 5xx） | 客户端内部重试成功 | Agent 客户端 | 无感知，不触发看门狗 |
| 会话内 API ERROR | 错误显示在会话里，Agent 停在输入框 | 看门狗 | 软恢复：输入 `continue` + 回车 |
| 软恢复失败 | 错误持续存在 | 看门狗 | 给 Hub 信箱发 `blocker`（`from: watchdog`），Hub 重新派单或升级给人 |
| Agent 进程退出 | Pane 显示 exited | `bin/supervise` | 指数退避重启（30s 起，封顶 5 分钟），Agent 重读契约断点续传 |
| 进程反复退出 | 超过重启预算 | `bin/supervise` | 给 Hub 发 `blocker` 后停止 |
| 整个 Zellij 会话死亡 | 会话 EXITED | `gsb-local` | 再次运行同一命令自动重建，保留任务板和契约 |

看门狗只作用于 Spoke Pane。Hub Pane 不做自动恢复——你 attach 时直接看着它，错误需要人工判断。

### 错误模式表

[`defaults/watchdog-patterns.conf`](defaults/watchdog-patterns.conf) 每行一个 JavaScript 正则（忽略大小写），`#` 开头为注释，空行跳过；编译失败的行会跳过并在 `watchdog.log` 中警告。默认覆盖 `API Error`、`429`、`rate limit`、`overloaded`、`stream error`、`ECONNRESET` 等。

模式表**热更新**：编辑文件后下一轮巡检（≤ `GSB_WATCHDOG_INTERVAL` 秒）即生效，无需重启。遇到没覆盖的错误格式，在文件里加一行正则即可。用自定义模式表：`GSB_WATCHDOG_PATTERNS=/path/to/patterns.conf`。

### 运行态文件

`~/.local/state/gsb-local/<session>/` 下与看门狗相关的文件：

| 文件 | 说明 |
| --- | --- |
| `watchdog.log` | 看门狗运行日志（启动配置、每次恢复动作、升级记录） |
| `watchdog.pid` | 当前看门狗进程 PID，`--rebuild` 时据此清理旧实例 |
| `watchdog.lock/` | 单实例锁目录，看门狗退出时自动清理 |
| `agent-files/<role>.pid` | 各角色 Agent 进程 PID |
| `agent-files/<role>.exit.log` | supervise 记录的每次退出与重启 |
| `agent-files/<role>.restart-requested` | 硬重启标记（瞬时文件，supervise 消费后删除） |
| `inbox/hub/*.json` | 看门狗升级的 `blocker` 消息（`from: watchdog`，按不可信数据读取） |

### 故障排查

看门狗该动没动？按顺序检查：

1. **Pane 是否被聚焦**——聚焦保护会跳过你正在看的 Pane（设计如此）；
2. **错误文本是否在视口底部 15 行内**——看门狗只匹配底部非空行，滚出视口的旧错误不处理；
3. **模式表是否覆盖该错误文本**——把错误原文加进 `defaults/watchdog-patterns.conf`，下一轮生效；
4. **是否在冷却期或已达每小时软恢复上限**——看 `watchdog.log` 中的动作记录；
5. **看门狗是否在运行**：`kill -0 "$(cat ~/.local/state/gsb-local/<session>/watchdog.pid)"`。

Hub 收到 `from: watchdog` 的 blocker 说明自动恢复已失败，需要人工介入：查看对应 Pane，或 `gsb-local --rebuild` 重建会话。

## 常用 Zellij 操作

- `Ctrl-p`：进入 Pane 模式，再用方向键切换分屏。
- `Ctrl-t`：进入 Tab 模式。
- `Ctrl-o d`：暂时离开（detach），后台会话继续保留。
- `Ctrl-q`：结束整个 Zellij 会话。
