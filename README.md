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

也可以先打开本地可视化配置器：

```bash
gsb-local studio

# 也可直接指定项目，跳过项目落地页
gsb-local studio --project /path/to/your/repository
```

Studio 只监听 `127.0.0.1`，启动时生成一次性访问 token。免 `--project` 启动时，首屏按最近项目展示配置和运行会话；可直接载入项目、用上次配置启动，或从运行中项目点「在终端打开」。进入工作台后既可以选择 `config1-4`，也可以从最小 Hub 骨架创建独立个人模板；模板卡也支持校验后直接启动。新项目默认用合法的目录 basename 作为会话名，不合法时回退为 `seed-gsb`。

非 Hub 角色默认使用“系统基座 + 一句话意图”两层编辑，保存时仍合成为完整的 `.gsb-local/prompts/<role>.md`；无标记的旧提示词继续按自定义全文编辑。新建角色只需角色 ID 和 Agent，内置基座覆盖 `coder`、`core-bug`、`ops-gov`、`plan-backup`、`frontend`、`backend`、`test`、`docs` 与通用兜底。模板显示名称支持中文、空格、符号与 Emoji，个人模板保存在 `~/.config/gsb-local/studio/templates/`，不绑定创建时的项目和会话。Profile 友好名来自各 `profiles/*.conf` 文件头的 `# label:`；`profiles/config1.conf` 同时是默认角色映射的单一事实源，`defaults/agents.conf` 以相对符号链接保留原 CLI 路径。最终启动仍调用同一套 `gsb-local` CLI，不存在第二套运行逻辑。Studio 启动工作台时会剥离调用方 Pane 的 `GSB_*`/`ZELLIJ_*` 会话环境；仅排障对照时可设置 `GSB_STUDIO_ENV_PASSTHROUGH=1` 恢复旧透传。`Ctrl-C` 只关闭 Studio 页面服务，不会关闭已经启动的 Zellij 会话。

项目配置的事实源是 `.gsb-local/agents.conf`、`.gsb-local/models.conf` 和 `.gsb-local/prompts/`；`.gsb-local/workbench.json` 仅作为 Studio 的 UI 草稿与展示元数据 sidecar，不覆盖手工修改的配置事实。

Studio 默认缓存 Agent 命令存在性检查：可用命令在当前进程内持续缓存，不可用结果 30 秒后自动重查；设置 `GSB_STUDIO_CMD_CACHE=off` 可关闭缓存。交互 shell 检查超时或失败时默认显示警告并允许继续启动；设置 `GSB_STUDIO_CHECK_STRICT=on` 可恢复为阻断错误。

只在后台创建、不立即占用当前终端：

```bash
gsb-local --background /path/to/your/repository
```

后台启动后，从任意目录进入已保存的会话：

```bash
gsb-local open my-task
```

`open` 会从 `~/.local/state/gsb-local/<session>/session.json` 读取最初绑定的绝对项目路径、配置来源、权限和 watchdog 策略。活跃会话只会 attach；已关闭的会话会保留任务板、合同和报告，并由 GSB 按持久化配置重新创建。不要用 `zellij attach <session>` 复活已退出的 GSB 会话；GSB 会禁用该会话的 Zellij 磁盘恢复，避免 Agent 完整提示词被还原成 `start_suspended` 待确认命令。

新会话的 Zellij socket 默认放在 `${XDG_CACHE_HOME:-$HOME/.cache}/gsb-zsock`，实际目录会写入该会话的 `session.env`，因此 attach、nudge 和 watchdog 应走 `gsb-local open`/GSB 脚本。旧默认目录中的运行会话仍可只读发现并 attach，不会被自动迁移或删除。路径有特殊约束时可在创建前设置 `GSB_SOCKET_DIR_OVERRIDE=/short/path`；完整 socket 路径超过 103 字节会在创建前明确报错。

只读检查当前布局是否仍符合 Hub 左列、Spoke 右列及 canonical pane 标题：`gsb-local layout-status [SESSION]`。它会报告缺失/退出/多余 pane、漂移列和标题断链，但不会自动修复或改动会话。

Zellij 0.44.x 在快速结束并立即重建同名会话时偶尔会卡在 server/client 初始化。GSB 为创建过程设置 15 秒硬超时并只重试一次；如果仍失败会明确退出并给出 Zellij 日志路径，不会无限卡住。

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

列出所有内置配置及角色映射：

```bash
gsb-local --list-configs
```

`config1` 是默认六角色薄 Hub 配置的显式命名版本，可通过 `--config1` 或 `--config config1` 选择：Hub 使用 `claude-glm-5.3` 负责编排，独立 `coder` 使用 Codex 承担生产实现。

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

再次运行同一命令会重新连接活跃会话；如果会话已被关闭，会保留共享任务板并按当前角色配置重新创建 Agent。同一个会话名永久绑定首次保存的工作区；从另一个项目用同名启动会在改写任何状态前被拒绝。推荐日常重开使用 `gsb-local open <session>`。没有项目配置时，启动器读取 [`defaults/agents.conf`](defaults/agents.conf)，默认映射为：Hub 使用 `claude-glm-5.3`，coder/plan-backup 使用 Codex，core-bug 使用 `claude-0812`，ops-gov 使用 `claude-relay`，UI 使用 Kimi。临时把这套默认配置的所有角色统一切换到 Codex：

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
coder=codex
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

### Hub 内核与能力扩展

每个模板必须且只能包含一个 `hub`。任务拆解、合同生成、角色分发、结果回收、冲突处理和最终汇总属于 GSB 的不可变 Hub 内核，由内置 [`prompts/hub.md`](prompts/hub.md) 和派发协议在运行时永久注入；项目或个人模板不能删除、替换或削弱这些职责。

Studio 会锁定 Hub 的角色 ID 和删除操作，并把可编辑区域明确标为“Hub 能力扩展”。扩展适合加入领域知识、审核偏好和额外协调规则，例如架构决策、质量门禁、进度治理或产品判断。项目扩展保存到：

```text
<workspace>/.gsb-local/prompts/hub-extension.md
```

运行时顺序为“不可变 Hub 内核 → 能力扩展 → GSB 协议与当前运行上下文”。扩展与内核或协议冲突时，仅冲突部分不生效。旧版 Studio 生成的项目级 `prompts/hub.md` 会按兼容扩展读取；重新保存后使用新的 `hub-extension.md`。

### 每个角色独立选择模型

可选的 `.gsb-local/models.conf` 使用同样的 `role=value` 语法，只覆盖对应角色的模型：

```ini
hub=glm-5
coder=gpt-5.6-sol
ui=kimi-code/k3-256k
```

只需填写 Agent CLI 实际支持的模型名；没有配置的角色继续使用自己的 Agent 默认模型。环境变量 `GSB_<ROLE>_MODEL` 优先级更高，例如 `GSB_CORE_BUG_MODEL=opus`。Studio 会自动维护这份文件，并在启动前验证角色是否仍然活动。

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

- `hub.<session>.main · <model>`：薄编排层；接收目标、拆分契约、分发、处理冲突并汇总，不默认承担生产编码。
- `spk.<session>.<role> · <model>`：按配置动态生成，并在边框显示实际模型或 Agent alias；删除角色后不再生成对应 Pane。
- 默认实现角色：`coder`，获得 Hub 明确的路径级写入范围后负责代码和针对性测试。
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
- `nudge` 只发送固定唤醒语，不把任务 payload 直接注入另一个 Agent；提交使用 Zellij 的真实 `Enter` 键事件。所有 Agent 在字符突发后默认等待 250ms（`GSB_NUDGE_SETTLE_SECONDS`）再提交；Kimi 仍兼容旧变量 `GSB_KIMI_NUDGE_SETTLE_SECONDS`。提交后会用 `dump-screen` 区分输入区草稿与历史区已提交消息：草稿残留时按 0.3/0.6/1.2 秒补发最多三次 Enter，仍失败则 `Ctrl-U` 清行并完整重发一次，最后向 Hub 投递 blocker 并返回非零。`GSB_NUDGE_VERIFY=false` 可回退为只发送不验证。Kimi 的重复唤醒仅在历史区确认已提交时合并，输入框残留不会再被误判为已排队。
- `nudge` 的 pane 定位与送达检查默认最多等待 5 秒（`GSB_NUDGE_RESOLVE_TIMEOUT_MS`）；挂住的查询客户端会被回收，并对没有 socket 记录的旧会话按「默认目录 → 统一目录」重试。紧急排障时可用 `GSB_SOCKET_DIR_OVERRIDE=/path/to/socket-dir` 指定第二探测目录。
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
6. 独立检测输入区里的 GSB 唤醒草稿：连续 2 轮静止且未聚焦时只补 Enter；连续 3 次仍无效则给 Hub 发 blocker，不与 API 错误软恢复抢动作；
7. 进程退出类故障由 [`bin/supervise`](bin/supervise) 兜底：指数退避重启（30s 起，封顶 5 分钟），超过 `GSB_SUPERVISE_MAX_ATTEMPTS` 次（默认 10）同样给 Hub 发 blocker。

因为契约、信箱、报告都在磁盘上，无论哪种恢复路径，Agent 重启后重读契约即可断点续传。

`bin/run-agent` 默认把收到的 `SIGTERM`/`SIGHUP` 转发给 Agent，并以 143/129 退出，使 supervise 在原 pane 内重启；`SIGKILL` 的 137 仍沿用既有重启路径。交互 `Ctrl-C`（130）和 Agent 内 `/exit`（0）不会自动重启。启动前设置 `GSB_SUPERVISE_SIGNAL_RESTART=false` 可恢复信号直达 Agent 的旧 `exec` 行为。

可选**硬重启**（默认关闭）：`GSB_WATCHDOG_HARD_RESTART=true` 时，软恢复失败的 Spoke 会被 Ctrl-c 终止并由 supervise 重启。

看门狗随会话启动自动在独立进程组后台运行（单实例锁保护，`--rebuild` 时自动替换旧实例），会话消失后自动退出。`gsb-local open <session>` 在 attach 前会检查 PID；若进程已死，会清理残留 pid/ready/lock 并从该会话的 `session.env` 自动复活。看门狗自身启动时也会在确认旧 PID 已死后接管陈旧锁。关闭：`GSB_WATCHDOG_ENABLED=false`。

看门狗的单次 Zellij 查询默认 10 秒超时（`GSB_WATCHDOG_ZELLIJ_TIMEOUT_MS`）。超时只回收本轮新建的查询客户端，并沿用既有本轮失败容错；不会终止或重启 Zellij 会话、Agent 或看门狗本身。

日志与自检：

```bash
tail -f ~/.local/state/gsb-local/<session>/watchdog.log   # 看门狗日志
cat ~/.local/state/gsb-local/<session>/agent-files/<role>.exit.log  # 重启记录
node "$GSB_LOCAL_ROOT/bin/watchdog.mjs" --selftest        # 内置自检
node "$GSB_LOCAL_ROOT/bin/wake-detect.mjs" --selftest      # 输入区/历史区判别自检
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
| `GSB_WATCHDOG_DRAFT_RECOVERY` | `true` | 是否补交持续滞留的 GSB 唤醒草稿 |
| `GSB_WATCHDOG_DRAFT_POLLS` | `2` | 草稿连续静止多少轮后补 Enter |
| `GSB_WATCHDOG_DRAFT_MAX_ENTER` | `3` | 草稿补 Enter 多少次后升级 blocker |
| `GSB_WATCHDOG_ZELLIJ_TIMEOUT_MS` | `10000` | 单次 Zellij 查询的超时毫秒数 |
| `GSB_SUPERVISE_MAX_ATTEMPTS` | `10` | 进程退出后的最大重启次数 |
| `GSB_SUPERVISE_SIGNAL_RESTART` | `true` | 转发 TERM/HUP 并让 supervise 在原 pane 内重启；`false` 恢复旧 exec 行为 |
| `CLAUDE_CODE_MAX_RETRIES` | `10` | Claude 客户端自身的 API 重试次数（第一层防御，旧版本忽略） |

### 故障模型与恢复路径

| 故障类型 | 表现 | 处理者 | 行为 |
| --- | --- | --- | --- |
| API 抖动（429 / overloaded / 5xx） | 客户端内部重试成功 | Agent 客户端 | 无感知，不触发看门狗 |
| 会话内 API ERROR | 错误显示在会话里，Agent 停在输入框 | 看门狗 | 软恢复：输入 `continue` + 回车 |
| 唤醒语停在输入框 | 固定 `A durable GSB...` 文本未提交 | `nudge` + 看门狗 | 当次验证重试；持续草稿由看门狗补 Enter 或升级 blocker |
| 软恢复失败 | 错误持续存在 | 看门狗 | 给 Hub 信箱发 `blocker`（`from: watchdog`），Hub 重新派单或升级给人 |
| Agent 进程退出 | Pane 显示 exited | `bin/supervise` | 指数退避重启（30s 起，封顶 5 分钟），Agent 重读契约断点续传 |
| 进程反复退出 | 超过重启预算 | `bin/supervise` | 给 Hub 发 `blocker` 后停止 |
| 整个 Zellij 会话死亡 | 会话 EXITED | `gsb-local` | 再次运行同一命令自动重建，保留任务板和契约 |
| 看门狗死亡、会话仍活着 | pid/ready/lock 残留但 PID 不存活 | `gsb-local open` | 清理陈旧状态并从持久化会话环境复活 |

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
| `watchdog.ready` | 看门狗完成单实例加锁后的就绪握手；启动器确认 PID 一致后才报告启动成功 |
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

### 唤醒草稿应急 Runbook

当 Spoke 没反应且固定唤醒语停在输入框时，按从轻到重的顺序处理。`nudge` 不携带任务本体，合同和信箱都在磁盘上，因此重复唤醒是幂等的。

```bash
# 1. 只读定位 Pane；记录输出里的 pane_id
bash "$GSB_LOCAL_ROOT/bin/nudge" <role> --dry-run
source ~/.local/state/gsb-local/<session>/session.env
ZELLIJ_SESSION_NAME=<session> zellij action dump-screen --pane-id <pane_id> | tail -20

# 2. 完整唤醒语只差提交时，补一个 Enter
ZELLIJ_SESSION_NAME=<session> zellij action send-keys --pane-id <pane_id> Enter

# 3. 输入是半截或混有脏文本时，清行后重发
ZELLIJ_SESSION_NAME=<session> zellij action send-keys --pane-id <pane_id> "Ctrl u"
bash "$GSB_LOCAL_ROOT/bin/nudge" <role>
```

若 Pane 正显示更新、trust/权限对话框或界面已卡死，不要盲发 Enter；先人工处理对话框，或写入 `agent-files/<role>.restart-requested` 后让 `bin/supervise` 重启对应 Agent。第三方 Stop hook 失败会扩大 TUI 回合切换窗口，也应同时排查。看门狗本身不活时运行 `gsb-local open --background <session>` 即可触发 liveness 检查和复活。

### Zellij 外部操作安全矩阵

以下结论适用于 Zellij 0.44.3 的 headless 后台会话（没有真人交互客户端）。命令返回 0 不等于布局真的发生了变化。

| 外部操作 | headless 结果 |
| --- | --- |
| `list-sessions`、`action list-panes --json --all`、`action dump-screen`、`action dump-layout` | 可用，只读 |
| `action focus-pane-id` | 可用，可改变外部命令所见的焦点 |
| `run -n <title>`、`run -d <direction>` | 可用，但只会 append 新 Pane，不能原位复活 |
| `action close-pane`、`move-pane`、`rename-pane` | 静默 no-op：rc=0 但没有效果 |
| `run --in-place`（含 `--close-replaced-pane`） | 静默 no-op，不能替换 exited placeholder |

因此，外部自动化无法移除、替换或重跑 exited placeholder；需要真人 attach 后人工整理，或在获准时重建会话。实验证据见 `reports/studio-w15-layout-design.md` 的 E4/E5/E10/E12。

### Pane 安全注入

任何 `write-chars` / `send-keys` 前都必须先 `dump-screen` 核实目标状态。不要盲发 Enter：如果 Pane 停在 `1. Yes, continue` 或 `Do you trust the files in this folder` 一类信任屏，Enter 会选中当前选项并意外启动旧 runner。

优先使用有超时和前后回验的低层工具：

```bash
source ~/.local/state/gsb-local/<session>/session.env
bin/pane-send <session> <pane-id> --text "continue"
bin/pane-send <session> <pane-id> --key Enter
bin/pane-send <session> <pane-id> --key Ctrl-c --count 2
```

工具发现交互门时默认拒绝注入并提示人工 attach；只有核实屏幕后才可显式加 `--force`。CLI 的 `Ctrl-c` / `Ctrl-u` 会转换成 Zellij 要求的 `"Ctrl c"` / `"Ctrl u"`（中间是空格），`Enter` 保持原样。所有调用受 `GSB_PANE_SEND_TIMEOUT_MS` 约束，默认 5000ms。它不替代 GSB dispatch：合同仍走 relay，Spoke 唤醒 Hub 仍走 nudge。

并行跑多个 e2e/runner 时，每个实例必须使用独立的 session/stage-state 目录（分别 `mktemp -d`），不能共享状态目录，否则会交叉写入并造成双实例互相污染。

## 常用 Zellij 操作

- `Ctrl-p`：进入 Pane 模式，再用方向键切换分屏。
- `Ctrl-t`：进入 Tab 模式。
- `Ctrl-o d`：暂时离开（detach），后台会话继续保留。
- `Ctrl-q`：结束整个 Zellij 会话。

结束后重新打开请运行 `gsb-local open <session>`。这会恢复 GSB 的持久化任务状态，但不会依赖或复活 Zellij 保存的 Agent 命令行。
