# 后台任务插件：设计与宿主能力需求

Status: **design, not implemented**. 决策基线：`feat/plugins-core`（上游 `5753545` + 16 commits）。

## 1. 结论

- pi-app 当前**没有**等价能力：`bash`/`powershell` 工具是同步等待的，内置工具集里没有任何 task/subagent 类工具，插件 `ctx.runAgentPrompt` 是阻塞的 headless 会话。唯一接近的土办法是 `cmd /c start /b` + `tail` 日志，没有任务清单、没有退出码、管不住 Windows 进程树。
- 用插件补上是**中等偏低难度**：插件 `main.mjs` 是直接 import 进 Electron main 进程的 Node 模块，`child_process` / `fs` 全可用，后台任务可以完全在插件层闭环。
- 但「任务跑完自动回到对话里」这一步**必须动宿主**。宿主侧要搬的能力，`feat/plugin-host` 上已经写好并跑通（当时为 AgentTeam 服务），不是从零设计。
- 分两刀落地：**第一刀宿主能力包**（约 1 天，含测试），**第二刀插件本体**（1～2 天）。UI 里唯一「非做不可」的复杂部件是列表实时刷新，可先降级为轮询。

## 2. 现状盘点

| 能力 | 现状 | 边界 |
| --- | --- | --- |
| `bash` / `powershell` 工具 | 有 | 同步 exec，等到进程结束才返回，只有 timeout（秒级），无 background/yield |
| 内置工具集 | 有 | 仅 bash/powershell/read/write/edit/find/grep/ls，无 task/subagent |
| 会话间并发 | 有 | 每会话独立 worker，多会话并行；单会话内工具串行 |
| 插件工具桥 | 有（`2714b88`） | 模型可调插件声明的工具，单次调用超时 20 分钟，支持 AbortSignal |
| 插件 `ctx.runAgentPrompt` | 有 | 起独立 inMemory 会话跑 prompt，**阻塞 await**，用户看不见、历史不连续 |
| 插件向宿主会话投递 | **无** | `ctx.sessions.send` 在 `feat/plugin-host` 上，未进 core |
| 工具调用上下文（谁在调我） | **无** | worker 不把 `sessionFile`/`cwd` 带给 main 侧插件 |
| 插件 UI | 有 | 中央视图 / 右栏面板 + iframe + `plugin-invoke` 双向；无 main→UI 单向推送 |

## 3. 参照形态

WorkBuddy 的三级结构（实机截图归纳），本项目按同一信息层级实现，但入口位置因宿主插槽不同而不同：

1. **入口条**：输入框上方一枚低存在感 pill「N 个后台任务运行中」，不抢对话。
2. **列表面板**：每行 = 状态点 + 任务标签 + 状态（已运行 31s / 已完成 / 退出码 1）+ 停止按钮；历史任务同列表收纳。
3. **单条详情**：点行展开，显示命令原文 + 输出（运行中实时滚动）。

不照抄的部分：WorkBuddy 的「后台任务不消耗积分」这类商业化文案、跨会话全局计费语义，本项目不需要。

## 4. 架构

三段式，边界清晰：

```
插件（main.mjs）                     宿主                        界面（iframe）
─────────────────                  ────────                    ──────────────
bg_start → spawn + 任务表            工具调用透传 sessionFile       面板列表 / 详情
watcher  → exit → 落盘状态           sessions.send 唤醒会话         入口条（会话顶部）
report   → 组装回报 ───────────────→ 投递到原会话 ──────────────→ 对话流回报行
log file → 增量读 ←────────────────────────────────────────────── 展开时 tail
```

关键点：**插件不持有会话**。任务借用户自己的会话说话，唤醒的是同一份历史，因此不需要 `ctx.agents`（那是 AgentTeam 的常驻子会话能力，一行都不用搬）。

## 5. 宿主能力包（第一刀）

### 5.1 清单与来源

| 能力 | 必要性 | 来源 commit | 搬运方式 |
| --- | --- | --- | --- |
| 工具调用透传 `sessionFile`/`cwd` | **P0 前提** | `a07f818` | 手抄 3 处，约 40 行 |
| `ctx.sessions.send`（含 worker 端 `customPrompt`） | **P0 核心** | `da389c6` | 抽 src 部分，5 文件 |
| 首轮 system 补丁 | **P0 核心** | `048124c` | 与上同一文件，必须一起 |
| `ctx.sessions.onRunEvent` | P1 | `d172307` | 抽 src 部分，2 文件 |
| `plugin-events`（`ctx.emit/on` + 推 iframe） | P1 | `8c58de1` | 从 agents 里剥，约 150 行 |
| `sessionBars[]` 贡献点（会话顶部条） | P1 | `8b3e798` | 抽 src + manifest 类型 |
| 时间线来源行渲染 | P2 | `80bc26a` | 可选，纯视觉 |

明确不带：`ctx.agents.*`（400 行）、`sessions.create/rename/setDuty`、project 菜单、成员会话预览。

### 5.2 `sessions.send` 的语义（照搬现有实现，勿重新设计）

```
ctx.sessions.send({
  sessionFile,            // 目标宿主会话（来自工具调用透传）
  content,                // 回报正文
  origin?,                // 界面来源标注：{ plugin, label, kind }
  deliverAs?: 'steer' | 'followUp' | 'nextTurn'
})
```

三条必须保留的行为：

1. **投递前补发插件工具**（`workerManager.setPluginTools`）。目标会话冷启动时 worker 一个插件工具都没有，回报里若让模型调 `bg_output` 会报 Tool not found。
2. **worker 没活时按 `meta.cwd` 冷启动**，投递是「定向到会话」而不是「定向到前台」。
3. **空闲首轮补 system 准备**。SDK 的 `sendCustomMessage({triggerTurn})` 直达 `_runAgentPrompt`，跳过 `before_agent_start` 与 `_preparePromptAndToolLoadout`，结果是**全新会话第一轮请求整段没有 system**（能力段、工具规则全丢）。`prepareFirstTurnMessages` 按 `prompt()` 的顺序补齐，拿不到内部结构时退回原生路径。

### 5.3 工具调用上下文透传

worker 侧把 `st.session.sessionFile` 与 `st.currentCwd` 通过 `plugin-tool-request` 带给 main；`handlePluginToolRequest` 原样透传给 `invokePlugin(..., { sessionFile, cwd })`，插件 `tool.execute` 的入参因此多两个字段。

这是整个功能的地基：没有它，插件不知道任务是谁发起的，跑完只能等人来面板翻。

### 5.4 `onRunEvent`

订阅任意会话的 `started/running/idle/failed/cancelled`。本项目的用途**不是**判断能不能投递（`send` 自己处理忙闲），而是：

- 会话正在跑长任务时，回报用 `followUp` 排队而不是 `steer` 打断；
- 面板显示「回报已排队，等会话空闲」。

### 5.5 事件推送与入口条（第二批）

`plugin-events` 提供 `ctx.emit(name, payload)` / `ctx.on(name, cb)` 与 main→渲染层→iframe 的 `plugin-event` 单向推送。有了它，面板列表与运行中任务的输出可以实时刷新，不必轮询。

`sessionBars[]` 是「会话顶部一条插件 UI」的贡献点，正好承载入口 pill。两者都属于 AgentTeam 的既有实现，搬运后需要改文案与点击行为。

### 5.6 落地方式

不建议按 commit cherry-pick：`plugin-host.ts` 在 core 与 plugin-host 两边的 sessions/agents 段落位置不同，冲突处理比重抄慢；且 `048124c`/`d172307` 的改动夹带 agent-team 的 doc 与 e2e。

推荐：**手抄 src 部分，一个 commit 落地，附单测**。验证方式：

- 单测：`worker-handlers-custom-prompt.test.ts`（从 plugin-host 分支带过来，去掉 team 相关断言）
- e2e：新写一条最小用例——临时插件的工具返回后调用 `sessions.send`，断言目标会话被唤醒并产生 assistant 消息

## 6. 插件设计

### 6.1 manifest

```json
{
  "id": "background-tasks",
  "version": "0.1.0",
  "name": "后台任务",
  "tools": [
    { "name": "bg_start",  "card": { "template": "kv", "icon": "timer" } },
    { "name": "bg_output", "card": { "template": "kv" } },
    { "name": "bg_stop",   "card": { "template": "kv" } },
    { "name": "bg_list",   "card": { "template": "list" } }
  ],
  "views": [{ "id": "tasks", "title": "后台任务", "entry": "ui/index.html", "placement": "center" }],
  "settings": [
    { "key": "reportPolicy", "type": "select", "label": "完成回报",
      "options": [
        { "value": "all", "label": "每个任务都回报" },
        { "value": "long", "label": "仅超过阈值的任务" },
        { "value": "failures", "label": "仅失败的任务" },
        { "value": "off", "label": "不回报，只更新面板" }
      ], "default": "long" },
    { "key": "reportThresholdMs", "type": "number", "label": "长任务阈值（毫秒）", "default": 15000 },
    { "key": "maxLogBytes", "type": "number", "label": "单任务日志上限（MB）", "default": 50 }
  ]
}
```

`card.template` 复用宿主已有的工具卡模板（`plugin-tool-cards.ts` 在 core 分支已存在），对话流里不会退化成裸文本。

### 6.2 工具

四个工具，**不提供 `bg_wait`**。语义对齐 AgentTeam v0.8 的教训：工具只负责「发出去」，等待由模型自己停轮实现；提供阻塞式 wait 会让模型误以为那是唯一正确用法，反而拖长每轮。

```
bg_start({ command, label?, cwd?, shell? })
  → { id: "bg-3", label, pid, status: "running", logPath, sessionFile }

bg_output({ id, offset?, maxBytes?, tailLines? })
  → { chunk, nextOffset, running, exitCode, totalBytes, totalLines, truncated }

bg_stop({ id, force? })
  → { ok, status: "stopped" | "already_exited", exitCode }

bg_list({ status? })
  → { tasks: [ { id, label, status, exitCode, startedAt, endedAt, durationMs, sessionTitle } ] }
```

设计取舍：

- `bg_start` 立刻返回，输出**不进工具结果**。若命令在 2 秒内结束且输出很短，返回里附带尾部输出，省掉一次 `bg_output` 往返。
- `bg_output` 的 `offset` 是字节偏移，客户端自持游标；`nextOffset` 一定返回，`more_expected` 语义同宿主后台任务（本次实机观察到宿主内部也走同一套游标）。
- `cwd` 默认取工具调用透传里的 `cwd`（用户当前会话的工作目录），插件不再猜。
- `command` 一律经系统 shell 执行（Windows `cmd /c`，POSIX `sh -c`），与内置 bash 工具行为一致。

### 6.3 任务表

落 `ctx.storage`（JSON），同时写一份 `tasks.json` 便于排查：

```ts
type BgTask = {
  id: string                 // bg-1，自增
  label: string              // 人类可读，默认取命令首行截断
  command: string
  shell: 'cmd' | 'sh'
  cwd: string
  sessionFile: string        // 发起者（透传）
  sessionTitle?: string
  pid: number
  status: 'running' | 'exited' | 'failed' | 'stopped' | 'lost'
  exitCode: number | null
  signal: string | null
  startedAt: number
  endedAt?: number
  logPath: string
  bytes: number
  lines: number
  report: 'pending' | 'sent' | 'skipped' | 'failed'
  reportedAt?: number
}
```

字段设计意图：

- `sessionFile` 是回报的地址簿；**不存 sessionId**，因为会话文件是唯一稳定的锚点。
- `report` 单独记账，回报失败不影响任务状态，面板可以重试。
- `lost` 是「重启后 pid 对不上」的兜底态，不是错误，要能在面板里点「重新回报」。

### 6.4 日志与增量读取

- 路径：`<userData>/plugin-data/background-tasks/logs/<id>.log`
- 直接 `fs.createWriteStream(logPath, {flags:'a'})` 作为子进程的 stdout/stderr 目标（**不经过宿主内存**），因此 5000 行、几十 MB 的输出不会撑爆 main 进程。
- 增量读：`fs.promises.open` + `read(buffer, 0, maxBytes, offset)`，单次上限 64KB；`offset` 越界时返回空 chunk 并纠正 `nextOffset`。
- 超 `maxLogBytes` 时不再写新内容到主日志，改为写 `<id>.log.overflow` 并在 `bg_output` 返回 `truncated: true`。
- 编码统一按 UTF-8 解码，非法字节用替换符；Windows 命令若输出 GBK 会显示为问号，属已知限制（可在设置里后续加编码选项，不在第一版）。

### 6.5 进程生命周期

- `spawn(command, { shell, detached: true, windowsHide: true, stdio: ['ignore', logFd, logFd] })` + `child.unref()`。detached 是刻意的：宿主退出后任务继续跑，符合「后台」语义。
- 存活判定：`process.kill(pid, 0)` 探测。**pid 复用**是已知风险，缓解手段是同时比对 `startedAt` 与进程启动时间（Windows 用 `wmic process where processid=<pid> get CreationDate`，失败则退化为只看 pid 存在并在面板标注「可能残留」）。
- 停止：Windows `taskkill /PID <pid> /T /F`；POSIX 先 `process.kill(-pid, 'SIGTERM')`（detached 使其成为进程组组长），3 秒后 `SIGKILL`。
- 宿主重启：启动时扫任务表，`status === 'running'` 的任务逐个探测 pid —— 存活则继续监听（无法拿到 exit 事件，退化为轮询存活 + 日志静默超时判定），不存活则记 `lost` 并把末次日志尾部当作结果。
- 插件停用：**不杀任务**（用户可能还在等结果），只解除会话订阅；重新启用后按重启逻辑接管。

### 6.6 完成回报策略

这是本设计里最需要克制的部分。默认策略：`reportPolicy = 'long'`，阈值 15 秒。

触发与内容：

1. 任务结束（exited/failed/stopped/lost）且满足策略 → 组装回报。
2. 回报正文固定结构，约 300 字以内：

```
【后台任务回报】bg-3「编译 120 个模块」已完成，退出码 0，耗时 4 分 12 秒。
最后 20 行输出：
  ...
完整日志：<logPath>（共 4821 行 / 312KB）
请基于以上结果继续，不要重复启动相同的任务。
```

3. 输出超限：尾部 20 行 + 8000 字符双限，触发任一即截断并给出日志路径。
4. 合并：同一 `sessionFile` 在 5 秒窗口内完成多个任务 → 合并成一条回报，避免唤醒风暴。
5. 队列上限：单会话 `report = pending` 超过 3 个时，新完成的降级为 `skipped`，只在面板提示。防的是「模型连开十个任务 → 十次唤醒 → 上下文雪崩」。
6. 投递失败（会话已删/工作区不存在）→ `report = 'failed'`，面板行内显示「回报失败」，提供手动重试。
7. `origin` 标注：`{ plugin: 'background-tasks', label: '后台任务', kind: 'report' }`，接时间线来源行后不会冒充用户输入。

为什么默认不是 `'all'`：短命令（`ls`、`git status`）几秒就结束，若每次都唤醒，用户会感觉「AI 在自己跟自己说话」。

### 6.7 面板 UI

中央视图（`views[]` 已支持），三块：

1. **头部**：`后台任务` + `2 个运行中` + 策略开关（直接写回 settings）。
2. **列表**：状态点（运行中琥珀 / 完成绿 / 失败红 / stopped 灰 / lost 虚线）+ 标签 + 状态文案（`已运行 31s` / `已完成 · 3.0s` / `退出码 1`）+ 行尾停止按钮。
3. **行内展开**：命令原文（mono 单行，超长省略，点击复制）+ 输出 `<pre>`（最近 200 行，运行中自动滚到底）+ `停止` / `完整日志`（走宿主 `plugins.reveal` 打开文件，不自建日志查看器）+ `重新回报`（仅 report=failed 时出现）。

刷新通道：

- 第一批：面板可见时 1 秒 `invoke('tasks.list')` + 展开行的 `invoke('tasks.output', {offset})`（增量 append）。
- 第二批：改 `plugin-event` 推送，面板只在打开时拉一次快照。

列表性能：DOM 只保留最近 200 行，滚出视口的行丢弃（日志文件是真相，不追求回滚）。

### 6.8 入口条（第二批）

`sessionBars` 贡献点在会话顶部渲染一枚 pill：`N 个后台任务运行中`，点击切到中央视图。无运行中任务时整条消失。文案与 WorkBuddy 对齐，但去掉积分说明。

## 7. 风险与对策

| 风险 | 后果 | 对策 |
| --- | --- | --- |
| 插件 main 在 Electron main 进程内 | spawn 抛错/未捕获 rejection 可拖垮应用 | 所有子进程操作包 try/catch；watcher 用事件回调不 await；顶层 unhandledRejection 记录不抛 |
| 孤儿进程 | 宿主退出后任务继续跑，列表状态失真 | detached + pid 落盘；重启时探测接管；面板显式标注「来自上次会话」 |
| pid 复用误判存活 | 把别人的进程当自己的任务 | 比对启动时间；失败则标注「可能残留」，停止前二次确认 |
| 事件丢失（重启期间结束） | 永远 running | 存活探测 + 日志静默超时（默认 10 分钟无新增且 pid 不在）→ 记 lost |
| 权限等同 bash 工具 | 模型可借它执行任意命令 | 在 tool description 里写明「等价于 shell 执行」；不额外扩大权限面（与内置 bash 一致） |
| 唤醒风暴 | token 雪崩、对话被噪音淹没 | 策略默认 long、5 秒合并、单会话 pending 上限 3 |
| 大输出 | 内存/上下文打爆 | 输出直写文件流、单次读 64KB、回报双限截断 |

## 8. 实施计划

### 第一刀：宿主能力包（约 1 天）

1. 搬 `sessionFile`/`cwd` 透传（`plugin-tools.ts` / `worker-plugin-tools.ts` / `worker-runtime.ts`）
2. 搬 `customPrompt` 协议 + `sessions.send` + 首轮 system 补丁（`worker-port-*` / `worker-handlers-turn.ts` / `worker-manager.ts` / `plugin-host.ts`）
3. 搬 `onRunEvent`（`worker-manager.ts` + `plugin-host.ts`）
4. 单测 + 一条 e2e：插件工具触发 → 会话被唤醒 → 产生 assistant 消息
5. 更新 `doc/dev/plugin-host-api.md`（与 agent-team 的 `plugin-agents-api.md` 同族，只记录 core 上真实存在的能力）

验收：`npm run typecheck`、`test:unit`（除沙箱 symlink 固有失败）、e2e 新增用例通过。

### 第二刀：插件本体（1～2 天）

1. 工具四件套 + 任务表 + 日志落盘（可先不接 UI，用 `bg_list` 自测）
2. 进程生命周期（spawn/kill/重启接管/孤儿判定）
3. 回报策略（策略开关、合并、限长、防套娃）
4. 面板 UI（列表 + 展开 + 停止 + 轮询）
5. e2e：起长任务 → 面板出现 → 停止 → 回报进会话

### 第三批：体验打磨

`plugin-events` 实时刷新、`sessionBars` 入口条、ANSI 着色（宿主 `packages/shared/ansi.ts` 现成）、时间线来源行。

## 9. 开放问题

1. **跨工作区任务**：任务 cwd 与发起会话的 workspace 不一致时，回报仍投原会话（已定），但面板是否需要按工作区分组？
2. **任务的继承**：会话 A 发起、用户切到会话 B 继续聊，回报是回 A（已定）。若 A 已归档，是否降级投递到当前前台会话？暂定不投，面板提示。
3. **`bg_start` 的审批**：内置 bash 工具可能受工具白名单约束，插件工具目前不受。是否需要给 `bg_start` 加一次宿主确认（`ctx.ui.ask` 已有）？第一版不加，保持与 bash 一致。
4. **历史任务保留**：默认保留最近 50 条 / 7 天，超出删任务行与日志。是否需要用户在面板里手动清理？第一版自动，第二版加清空按钮。
