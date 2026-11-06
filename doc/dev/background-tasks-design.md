# 后台任务插件：设计与宿主能力需求

Status: **implemented**（宿主 `69363b8`，插件 `9d41b3a`）。决策基线：`feat/plugins-core`。
实现与本文档不一致的地方见 §10。

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
  report: 'pending' | 'queued' | 'suppressed' | 'skipped' | 'failed'
  reportedAt?: number
}
```

字段设计意图：

- `sessionFile` 是回报的地址簿；**不存 sessionId**，因为会话文件是唯一稳定的锚点。
- `report` 单独记账，回报失败不影响任务状态，面板可以重试。
- v0.5.0 起 `sent` 改名 `queued`：sent 读起来像「用户已收到」，实际只代表已交给宿主投递
  （可能因回合边界延迟数分钟才出现）。旧持久化记录在 `load()` 时统一迁移。
  现在的全集：`pending` / `queued`（已投给宿主）/ `suppressed`（调用方已通过工具响应获知）/
  `skipped`（成功且短于阈值）/ `failed`（投递失败）。
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

## 10. 实现记录：与设计不一致的地方

落地时被环境推翻或简化的点，按「设计 → 实际 → 原因」记录，避免下次重新踩。

### 10.1 进程不 detached

- 设计：`spawn(..., { detached: true })` + `unref()`，宿主退出后任务继续跑。
- 实际：不 detached。宿主退出时 Node 不会主动杀子进程，任务照样活下来；停任务按 pid 直接杀（Windows 走 `taskkill /T`）。
- 原因：在 Electron 主进程里启动 detached 子进程，本机实测表现为**进程存在但从不退出、也不产出任何输出**（`exit` 事件不触发，日志 0 字节）。同样的代码在普通 node 进程里正常。

### 10.2 输出不走 fd 继承，改由 shell 重定向

- 设计：`stdio: [ignore, logFd, logFd]`，输出直写文件、完全不过 Node 内存。
- 实际：`spawn(\`chcp 65001>nul & (${command}) >> "log" 2>&1\`, { shell: true })`，由 shell 自己重定向。
- 原因：Electron 主进程在 Windows 上不给子进程继承句柄，子进程 stdout 是无效句柄。走 `shell: true` 而不是手拼 `cmd /d /s /c`，是因为日志路径可能含空格或中文，命令行引号必须交给 Node 的参数转义规则处理。

### 10.3 新增 `ctx.dataDir`

设计里没有这一项，但插件必须有个可写目录放日志：`ctx.storage` 只存小 JSON，内置插件装在应用目录（打包后可能只读）。宿主补了 `ctx.dataDir`（`<userData>/plugin-data/<id>`，已确保存在），storage 也在这里。

### 10.4 日志上限的处理方式

- 设计：超上限后写 `<id>.log.overflow`。
- 实际：3 秒一次的存活探测里顺带 stat 日志，超限就 `taskkill` 停掉任务并记 `error`。
- 原因：overflow 文件意味着「任务继续跑但输出被吞」，用户看到的是一个再也不更新的任务；直接停掉并说明原因更诚实。

### 10.5 返回值与面板细节

- `bg_start` 会等 120ms：命令若已结束，直接把尾部输出带回去，省掉一次 `bg_output` 往返。
- 面板行不显示任务 id（只显示标签），路径与大小放在展开区。
- 中央视图的 invoke 方法名与 main 侧 `methods` 的键一致（`listTasks` 等），不要加 `tasks.` 前缀——第一版写错过，面板会显示「读不到任务列表」。

### 10.6 已实现 / 未实现

已实现：四工具、任务表落盘、重启接管（pid 探测 → lost）、日志增量读、回报策略（all/long/failures/off + 阈值）、5 秒合并、单条消息最多展开 3 个任务、面板列表与展开、停止、删除、重新回报。

未实现（按 §8 第三批）：`plugin-events` 推送（面板用 1.5 秒轮询代替）、`sessionBars` 入口条（目前从侧栏「应用」进）、ANSI 着色、时间线来源行渲染（回报正文自带「【后台任务回报】」前缀作为区分）。

## 11. 实测反馈吸收（v0.1.1）

一份 12 个场景的实测报告指出了几处问题。逐条核验后的处理与理由如下。

### 11.1 shell 契约：默认对齐内置 bash 工具（P0）

- **问题**：`bg_start` 在 Windows 走 `shell: true`（cmd），而内置 bash 工具跑的是 Git Bash。模型按 bash 写命令，cmd 把 `$i`、`$(seq 1 3)` 当普通文本吃掉——命令照跑、退出码 0、输出却是错的。这是**假成功**，比报错危险。
- **做法**：`shell?: 'auto' | 'bash' | 'cmd' | 'powershell'`，默认 `auto` = 探测 Git Bash（常见安装路径 + `where bash`），找到就用；找不到才回落 cmd。`cmd` / `powershell` 只能显式指定。
- **兜底**：最终落到 cmd 时，命令里出现 `$(`、`${`、`for … in`、`export x=`、`[[` 一律**直接报错**并提示传 `shell:'bash'`，不再静默变形。
- 另一种 shell 走临时 `.ps1`（脚本文件 + cmd 重定向，避开它自己 `*>` 写 UTF-16 的乱码问题）。

### 11.2 返回值：可读文本 + details（P0 的一半）

- **问题**：插件工具返回对象，宿主 `JSON.stringify` 成文本，调用方还要自己 parse。
- **现实**：模型侧的 tool result `content` 协议只有文本，**做不到「返回纯对象」**。能做的是把两件事分开：
  - `text`：给人/模型读的摘要（`bg-3「构建」已完成，耗时 12.3s`），不再是一坨 JSON；
  - `details`：原始对象，宿主新增字段一路透传到 worker 的 tool result。
- 宿主侧改动：`ToolResultPayload.details` → `plugin-tools.ts` 解析 → `worker-plugin-tools.ts` 不再写死 `details: {}`。

### 11.3 分页契约（P1）

`readLog()` 原来有 1KB 隐式下限，`maxBytes: 100` 实际拿 1024B。现在下限降到 64B（编码安全），返回值补 `chunkBytes` / `truncated`，schema 写明区间。

### 11.4 停止语义（P1）

- `bg_stop({ waitMs })`：等进程真退出再返回（上限 10s），省掉「再查一次」。
- 被杀的进程会带无意义退出码（taskkill 通常是 1），原先直接写进 `exitCode`，与真实失败撞车。现在 stopped 的 `exitCode` 一律 `null`，原始码留 `rawExitCode`，原因记 `stopReason: user | log-limit`。

### 11.5 bg_output 长轮询，不做 bg_wait（P1，改了方案）

报告建议加 `bg_wait(id, timeoutMs)`。**不做**：需要等结果时内置 bash 工具本来就是同步的，再加 wait 等于鼓励「先 start 再 wait」这种最差用法。

替代：`bg_output({ waitMs })`——阻塞到**有新输出或任务结束**就返回（上限 30s）。协作式，不承诺终态，主链仍是「跑完自动回报」。

### 11.6 回报透明化（P2）

- `bg_start` 返回 `details.report = { policy, willReport, reason }`，模型在启动时就知道「这个任务会不会自己回来」。
- `scheduleReport` 记 `reportNote`（如「成功且耗时 3s 短于阈值 15s」），面板 badge 的 tooltip 直接显示。
- 加 `if (task.report === 'sent') return` 防御性去重。
- 说明：策略本身早就可配（`all / long / failures / off`），缺的是让模型知道当前策略，不是再加配置项。

### 11.7 顺手修掉的两个小问题

- `pruneTasks()` 原来遇到运行中的尾巴就 `break`，任务数会突破 50 上限；改成从旧到新找可删项，跳过运行中的。
- `bg_list` 显式按 `startedAt` 倒序（原来依赖 `unshift` 的插入顺序，恢复来的任务顺序不可靠）。

### 11.8 明确不做

| 项 | 理由 |
|---|---|
| `bg_wait` | 与内置 bash 工具职责重叠，且鼓励最差用法 |
| stdout/stderr 分流 | **v0.2.0 已做**，见 §12.1：当初以为要 tee，其实两个文件就够，不需要双写 |
| 返回纯对象 | 模型侧 content 只能是文本，`details` 透传已是能做到的极限 |

### 11.9 测试

新增 `plugins/background-tasks/main.test.mjs`（6 条，真实子进程）：bash 循环能跑出三行、cmd 下 bash 语法被拒、`maxBytes: 64` 精确生效、`bg_stop` 等到终态且 `exitCode === null`、启动时回报预期、短任务跳过回报并记原因。vitest include 增加 `plugins/**/*.test.mjs`。

## 12. 能力补齐（v0.2.0）

这一轮的输入是对照 `pi-background-tasks`（ismailsaleekh，2.6.10）的能力盘点。结论是继续自研，但吸收三项成本低、收益明确的缺口；对方最宽的三块（delegate / Fusion / surviveReload）不抄，理由见 §12.5。

### 12.1 stdout / stderr 分流（推翻 §11.8）

§11.8 当初判断「cmd 下没有 tee，bash 进程替换顺序失真」——这是把问题想复杂了：不需要同时写一个文件再拆分，**直接让 shell 写两个文件**即可，重定向语法在 bash / cmd / powershell 三种 shell 下都成立：

```
(cmd) >> out.log 2>> err.log
```

- `logPath` 语义收窄为 stdout，新增 `errPath`；旧任务没有 `errPath`，`readLog` 按「无此流」返回空，不会报错。
- `bg_output` 加 `stream: 'out' | 'err'`，UI 展开行给 stdout/stderr 两个 tab（只在 stderr 有内容或任务失败时出现）。
- 回报文案里 stdout 与 stderr 分段；失败时 stderr 通常只有几十行，比在几万行正常输出里翻错误快得多。
- 日志上限按两个文件之和计算，避免「分流之后上限形同翻倍」。

### 12.2 超时兜底（`timeoutSeconds`）

日志上限只能挡住「一直刷屏」的任务，挡不住一个安静空转的进程。`bg_start` 增加 `timeoutSeconds`：

- 下限 5s（更短的任务本来就该用同步工具），上限 24h；超出范围不报错，夹到边界——传 1 秒的意图是「快点结束」，抬到 5 秒仍符合意图。
- 到点走 `stopTask(task, true, 'timeout')`，状态是 `stopped` + `stopReason: 'timeout'`，`statusText` 单独出「已超时终止（上限 Ns）」。
- **定时器不落盘**：它是「谁在盯着」而不是任务本身。`recover()` 按 `startedAt + timeoutMs` 重算剩余时间，已过期的立刻到点；插件卸载后不再兜底，任务继续跑（与「卸载不杀任务」的既有约定一致）。

### 12.3 `bg_rerun` / `bg_clear`

- `bg_rerun(id)`：用原 command / cwd / shell / 超时重跑，**总是生成新 id**，老记录的日志与结果保持不动（它是独立事实，被新一次覆盖会丢证据）。运行中的任务拒绝重跑，提示先停。
- `bg_clear`：默认只清终态记录、保留运行中；`keepRunning: false` 才连运行中一起清。
- 实现时踩到一个真 bug 并修掉：`keepRunning: false` 最初只删记录不停进程，会留下**孤儿进程**——记录没了、任务还在跑、也没人再回报它。现在先 `stopTask` 再 `waitForTerminal(3s)`，等进程真的退出才删日志文件，避免「删了文件它还在写」。单测钉住了这一条。

### 12.4 测试

`main.test.mjs` 从 6 条扩到 12 条，新增：stderr 不混进 stdout、两个流落到两个文件、超时终止且 `exitCode === null`、重跑生成新 id 且保留老记录、`bg_clear` 保留运行中、`keepRunning:false` 会停进程（孤儿进程回归）。

### 12.5 明确不抄的三项

| 项 | 理由 |
|---|---|
| `bg_delegate` | 只读子代理 = 子代理编排，与 `ctx.agents` / AgentTeam 职责重叠；塞进后台任务插件会让边界糊掉 |
| Fusion（3 候选 + 盲评 + 合并） | 依赖 Anthropic / Codex 订阅 OAuth，且属于「多模型工作流」，不是后台任务该管的事 |
| `surviveReload` | 对方只覆盖 same-process reload，救不了 worker 回收；要真跨进程存活得引入独立 supervisor，为低频场景付高成本 |

顺带一个架构判断：对方的 EventBus 宿主接口（`pi-background-tasks:host:*:v1`）是「TUI 与前端不同进程」逼出来的补丁。我们的插件 main 与宿主同进程，本来就不需要序列化 / 租约 / 游标这一层——少一层就少一类 bug。

## 13. UI 形态（v0.3.0）：会话条 + 右栏详情

> **已被 §14 推翻**：会话条（对话区顶部）在 v0.4.0 换成了输入框上方的托盘。
> 保留本节是因为「归属判断放 main」「focus 用 seq 不用布尔」这两条仍然成立，右栏详情的部分也没变。

前两版只有一个中央视图：想看任务得离开对话，翻到「应用」里。真实使用里最常问的是
「我这个会话后台在跑什么」，这个问题的答案必须在视线第一落点，而不是三步之外。所以补两个落点。

### 13.1 分层

| 落点 | 内容 | 高度/宽度 |
|---|---|---|
| **会话条**（`sessionBars[]`，对话区顶部） | 一行摘要 → 点开是任务行 → 点行看详情 | 折叠 34px；展开 = 34 + 28×行数，封顶 268px |
| **右栏面板**（`panels[]`，约 288px） | 任务列表 + 命令 + 实时输出 + 停止/重跑/删除 | 撑满 |
| 中央视图（`views[]`，保留） | 同一份 `ui/index.html`，宽屏布局 | 撑满 |

三者共用 main 侧同一份任务表，只是入口不同。会话条用独立的 `ui/session-bar.html`——
它要按内容高度收放，和撑满型面板的生命周期不一样，塞进同一份文档反而要写一堆分支。

### 13.2 归属判断放在 main，不放在 UI

会话条只该显示**当前会话**的任务。判断依据是工具的 `sessionFile` 与会话条拿到的
`plugin-context.sessionFile` 是否同一个会话：

- 来源不同：工具侧来自 worker 的 `session.sessionFile`，UI 侧来自 renderer 的 `historySessionFile`。
- 所以做归一化（小写、正斜杠、去尾斜杠），全路径不等时用 basename 兜底——pi 的会话文件名带唯一 id，撞名几乎不可能。

归一化只留一份实现（main 的 `sameSession()`），UI 一调 `sessionBarState({ sessionFile })` 就拿结果。
两份实现早晚会漂，而且漂了之后表现是「任务莫名不显示」，极难查。

### 13.3 没任务就真的不占地方

插件通过 `plugin-content-height` 上报高度，`0` 就是收起。宿主此时把容器压到 0 但**不卸载 iframe**——
否则插件再也没机会把条子撑开。三种状态：

| 状态 | 显示 |
|---|---|
| 本会话有任务 | `2 个任务在跑 · 1 个已完成` |
| 本会话无任务，别处有在跑 | `其他会话有 1 个任务在运行`（点一下直接开右栏） |
| 全都没有 | 高度 0，完全消失 |

第三档是刻意的：会话条是「我这个会话」的旁注，不该变成全局任务栏。第二档保留是因为
「任务在跑但我看不见」比一条 12 字的提示更让人不安。

### 13.4 点任务 → 右栏定位

链路是「插件请宿主开面板」，不是「插件自己开面板」：

```
会话条 click row
  → invoke('focusTask', { id })        // main 记 { id, seq: seq+1 }
  → postMessage plugin-open-panel       // 宿主 setActivePanel + revealRightPanel
右栏面板（轮询）发现 listTasks().focus.seq 变了
  → state.open = id，重建并 scrollIntoView
```

两个细节：
- **用 seq 不用布尔**：用户可能刚手动收起那一条，再点一次还得能翻回来。seq 单调递增，比「是否等于当前项」稳。
- **focus 不落盘**：它是「谁在看什么」的界面状态，不是任务事实。重启后从 0 开始，没有副作用。

### 13.5 同源代价：两处 UI 各自轮询

右栏面板与中央视图各是一个 iframe 实例，各自 1.5 秒轮询 `listTasks`；会话条 2 秒轮询
`sessionBarState`。没有 `plugin-events` 的前提下这是唯一解，成本可接受（都是读内存 + 一次 IPC）。
真嫌吵的时候，宿主补一条「main → UI 单向推送」比在插件里做去重划算——那是宿主能力，不是插件该绕的弯。

### 13.6 测试

- `main.test.mjs` 12 → 14 条：会话条只报本会话任务（含分隔符/大小写差异）、`focusTask` 递增 seq 且连点也递增。
- `plugin-session-bar.test.tsx` 2 条：manifest 声明就挂 iframe、没声明就什么都不渲染。
- `e2e/plugin-background-session-bar.spec.ts`：真实宿主里跑一次——摘要出现、点开列出任务、
  容器被撑高、点任务后右栏面板打开且 `.row.open` 命中。

## 14. v0.4.0：托盘搬到输入框上方（推翻 §13 的落点）

§13 把任务条放在对话区顶部，实际用下来「不够直观」——视线在输入框，条在窗口顶端，
中间隔着一整屏历史。对照 `pi-deck-todo` 看明白了：它之所以好认，不是因为「在上面」，
而是因为它被塞进了 `.composer-accessory-row`——margin 下压 -1px、只圆上面两个角、
和输入框共用一条边，读起来像输入框向上凸起的一层。

### 14.1 为什么不做成 iframe 塞进托盘

先试过最省的做法：给 `sessionBars` 加个 `placement`，把 iframe 移进托盘（约 40 行）。
放弃的原因是质感：托盘只有 28px 高、四周 1px 边框，iframe 的接缝、字体基线、圆角对不齐
在这个尺度上藏不住；插件还得复刻宿主的 hover/focus 态。而这条要显示的只是「一行摘要 + 几行任务」，
为此维护一套仿制皮肤不划算。

### 14.2 走「借机制」：插件推，宿主画

```
插件 main → ctx.ui.setComposerBar(sessionFile, bar)
          → app event `plugin_widget`（按 sessionFile 路由）
          → renderer 写入该会话的 pluginComposerBars[pluginId]
          → <ComposerPluginBars> 用 adapter 的同一套 CSS 原生渲染
```

- **为什么用 app event 而不是让 UI 轮询**：任务从 running 变结束是 main 侧才知道的时刻。
  轮询只能把延迟摊平成平均 1 秒（原来是 2 秒一跳），推送才是「结束即变」。
- **推送天然带 sessionFile**：切会话不会串台，插件也不用反查「现在看的是哪个会话」——
  §13.2 里那套「UI 侧拿 historySessionFile 再比对」的复杂度直接消失。
- **`workspaceId` 留空**：插件不知道工作区标识，编一个假的会被路由判成 background。
  路由按 sessionFile 判定即可。

### 14.3 契约只留必要的自由度

`summary / detail / tone / rows / panelId`。行的 `status` 决定图标，`action: 'stop'` 决定有没有停止按钮，
`startedAt` 给了就**由宿主现算耗时**——插件推一次的「12s」会永远停在 12s，属于会骗人的界面。
点行走 `composerBarAction({ action: 'select' | 'stop', id })` 回调，宿主不解释业务语义。

刻意不做的事：不支持自定义 HTML/版式。托盘是摘要，不是第二个面板；要富交互去右栏。

### 14.4 与 todo tray 的排布

`.composer-accessory-row` 加 `flex-wrap`，插件托盘 `flex: 1 1 100%` 独占一行，todo tray 落到下一行。
任务名被截断比多占 28px 难受，所以不做左右分栏。

### 14.5 回报队列与显式动作协同（吸收 v2 实测报告）

v2 报告里两条 P2/P3 是同一个根因：**回报队列不知道「这条已经不用发了」**。

| 现象 | 根因 | 修法 |
|---|---|---|
| `bg_clear` 删了记录，几秒后仍收到指向它的回报 | 队列里的 task 对象不随 state 删除而消失 | `dropQueuedReports(ids)` 同时清队列项与 timer |
| `bg_stop(waitMs)` 已同步返回终态，随后又来一条同样内容 | `finishTask` 早已入队，显式动作没有撤回权 | 拿到终态就 `suppressReport()`（`report='suppressed'`） |
| 极端情况：队列里的记录在投递前被删 | — | `deliver()` 投递前按 id 二次校验 |

`suppressed` 在面板里显示为「未回报」，仍可手动「重新回报」——抑制的是自动打扰，不是能力。

### 14.5.1 v3 报告后的加固：把「已宣布死亡」提前到第一个 await 之前

v3 实测仍复现孤儿回报（`bg_clear` 之后收到指向已删任务的回报）。根因不是「忘了撤队列」，而是
**撤得太晚**：

- `bg_clear({keepRunning:false})` 要先 `await waitForTerminal(3s)` 才动队列；
- 而 `flushReports` 会在合并窗口到点后把队列 **整段取走**（`reportQueues.delete` + `splice`），
  取走之后 `dropQueuedReports` 就找不到它了；
- 中间还有 `tailOf()` 的文件 IO。窗口足够宽。

修法是把「这条 id 已经不该再有任何回报」变成独立事实，而不是靠队列里有没有这条对象：

- 新增内存集合 `deletedIds`，`markDeleted(ids)` 在删除流程的**第一个 await 之前**写入，
  并同时 `dropQueuedReports`。60 秒后自动清理（`unref`，不拖住宿主退出）。
- `scheduleReport` 入口先查 `deletedIds`：进程退出事件晚于记录删除时，不再入队。
- `flushReports` 取队列后先按 `deletedIds` 过滤，`skipped` 计数只算真正排队被跳过的。
- `deliver` 的二次校验从「对象引用在数组里」改成「id 仍在 `state.tasks` 且不在 `deletedIds`」——
  插件重载后对象会被重建，引用比对会误判。
- `enqueueReport` 同 id 去重：exit / close 两个回调都可能触发 `scheduleReport`。

**内联回执即交付**（v3 §3.3）：`bg_start` 回执里带上完整结果时调用
`suppressReport(fresh, '启动回执里已带完整结果（内联返回）')`。此前文案写着「不会再单独回报」，
几秒后却补发一条，属于自相矛盾——不变量统一为「终态已经通过工具响应交付给调用方 ⇒ suppressed」。

**工具 schema 与实现对齐**：`bg_clear.status` 的实现一直容错单个字符串，schema 却只声明
`array`，模型按描述写字符串会被参数校验挡下。改为 `anyOf: [array, string]`，用 typebox
`Value.Check` 实测四种输入（数组 / 字符串 / 混合 / 非法）行为正确。

**托盘不再「点完就收起」**：点某行只是把详情开到右栏，列表本身没有消失的理由。收起后用户
每看一条都得重新展开一次，属于纯粹的重复劳动。`e2e` 里加了断言钉住这一点。

### 14.6 其余小口子

- `format: 'text' | 'json'`（`bg_list` / `bg_output`）：脚本化场景不必用正则解析排版。
- `maxBytes` 被上下限夹过时回显 `requestedMaxBytes` / `effectiveMaxBytes`，正文点明「已按 64B 实际执行」。
- `bg_clear({ status: ['failed','stopped'] })` 收数组，单值仍兼容。
- `lost` 的复现条件写进 §14.7，不再只存在于代码注释里。

### 14.7 `lost` 何时出现

宿主进程退出（正常关窗、崩溃、被任务管理器结束）时子进程仍在跑，重启后 `recover()` 按 pid 探测：
pid 不在了就记 `lost`——退出码永远拿不到，不假装知道结果。它只出现在「宿主死过一次」的任务上；
同一进程内正常结束的任务不会落到这个状态。

### 14.8 测试

- `main.test.mjs` 20 → 23 条：新增「内联回执后不再回报」「`bg_clear` 单字符串」
  「停在半路时清理不产生孤儿回报（3s 等待窗口）」。
- `composer-plugin-bar.test.tsx` 3 → 4 条：点行打开右栏后**不收起**列表。
- `e2e/plugin-background-composer-bar.spec.ts`：真实宿主里走完「出现摘要 → 点开 → 点行开右栏 →
  任务结束后摘要变成已结束」——最后一步专门证明推送链路成立（没有轮询也更新了）；点行后
  `[data-row-id]` 仍在，证明托盘没有被自己的点击收起。

## 15. v0.5.0：回报消息的「转述行」与 v4 报告收尾

v4 实测报告（bg-31 ~ bg-36）结论：v3 的两个真问题（孤儿回报、内联承诺矛盾）确认修复，
工具本身到达「可以放心跑一夜」的状态。本轮处理剩余三项 + 一个长期欠账：

### 15.1 回报消息与用户消息在界面上区分（转述行）

**问题**：`sessions.send` 投递的回报在模型侧占「用户位」，在界面上也渲染成和用户气泡
一模一样的右侧实底气泡——用户会看到一条「自己没说过的话」。

**实现**（`plugin-message.ts` 的注释里承诺了两轮的「转述行」，这次兑现）：

- origin 本来就随消息落盘（custom_message 的 `details`），只是归一化时被丢掉。
  `worker-timeline.pluginMessageParts()` 现在把正文和 origin 一起取回
  （origin 校验形状：`pluginId` + `label` 缺一不可，防插件乱写污染界面）；
- 历史重建（`normalizeMessages` / `timelineItemsFromBranchPath`）给 user-message 行
  附加 `pluginOrigin`；实时流（`worker-session-events`）在 app event 上透传同名字段；
- renderer（`apply-app-event-message`）对带 origin 的事件**跳过乐观行合并**直接入列
  ——合并会把用户没打完的草稿替换成回报正文；
- `timeline.tsx` 渲染：左对齐浅底块 + 来源徽标（`后台任务 · 回报`，kind 经 i18n 映射）+
  左侧 brand 色竖线；不渲染回溯/分叉（rewind 到插件消息没有意义）。普通用户消息
  完全不受影响。

### 15.2 `report: "sent"` 改名 `queued`

v4 报告 §三#2：sent ≠ 送达，实测消息可能延迟数分钟。改名 `queued` 并在 `load()` 迁移旧值；
UI 徽标文案「已回报」→「已投递」。schema 注释与设计文档同步。

### 15.3 `bg_clear` 增加 `ids` 维度

v4 报告 §三#3：API 层无法按 id 清理，脚本场景不便。`bg_clear({ ids })`（string 或 array）
精确点名清理，无视状态（点名=明确意图，运行中的也先停后删，与 `removeTask` 语义一致）；
不存在的 id 不报错，回 `missing` 数组——脚本场景是「尽力清」。工具层与 invoke 层原本
各有一份重复的过滤逻辑（ids 就差点只在一份里生效），借机收敛为单一实现。

### 15.4 `lost` 触发条件写进工具描述

`bg_list` 描述补一句：lost 只在宿主重启后可能出现（pid 探测不到），会话内无法主动构造，
无需再当覆盖空白对待。

### 15.5 测试

- `main.test.mjs` 23 → 25 条：`ids` 点名清理 + missing 回显、旧值 `sent → queued` 迁移。
- `worker-timeline-plugin-message.test.ts` 6 → 10 条：origin 取回、坏形状防御、
  两条归一化路径一致带 origin。
- `worker-session-events.test.ts` +1：实时事件透传 `pluginOrigin`。
- `apply-app-event-message.test.ts`（新）3 条：带 origin 直接入列、不吞用户草稿、
  普通事件仍走乐观行合并。

## 16. v0.5.1：v5 报告的两个 P1

v5 实测（bg-37 ~ bg-43）确认 queued/ids 落地后，抓到两个「参数边界」问题：

### 16.1 `tailLines` off-by-one

日志每行以 `\n` 结尾，`split('\n')` 后末尾多一个空串——tail 取「末 N 个元素」时空串
占掉一个名额：稳定少一行，`tailLines:1` 直接拿到空串（「没有输出。」）。修法是先摘掉
末尾空串再取行。同时修掉附带发现：tail 截取后 `chunkBytes` 仍是整段切片的大小
（按它做进度/校验会拿到整个日志的字节数），现在跟随实际返回文本重算。

### 16.2 `bg_clear({ids})` 无视 `keepRunning`

v0.5.0 引入 ids 时把「点名 = 明确意图」推得太远：运行中任务也被直接 stop+delete，
一次误传 id 就静默杀掉长任务，与 `keepRunning` 默认语义矛盾。现在 ids 与 status
两条路径都遵守 `keepRunning`：默认跳过运行中任务并回 `skippedRunning` 计数，
`keepRunning:false` 才停+删。顺带修文案陷阱：`bg_clear({status:'running'})` 曾回
「没有状态为 running 的任务可清理」，与事实不符（实情是 keepRunning 把它们跳过了），
现在如实说「N 个运行中任务已跳过（keepRunning=true）…」。

### 16.3 投递节奏写进工具描述

实测观察「约每回合 1 条」的真相，把投递模型写准（这些已写进 `bg_start` 描述）：

- 回报的宿主投递调用**不带 `deliverAs`**（忙闲只留痕、不参与投递决策），
  worker 侧语义是：**会话空闲 → 立即开新轮送达；回合进行中 → `followUp` 排队，
  在下一轮边界送达**。它刻意**不是 steer（插话）**——steer 会在工具调用边界把消息
  注入正在跑的回合，让模型在执行用户任务的半路上分心处理回报，语境也被打断；
  排队到轮边界对「结果接入对话」这个目标足够及时。
- `queued` 只代表「已交给宿主」，送达时机取决于会话忙闲——空闲时当轮即达，
  忙时排到下一轮，多条 followUp 会在同一个边界一起进来（不是每回合限 1 条）。
- **批量**：同会话 5s 合并窗口（`MERGE_WINDOW_MS`）内连续结束的任务合成一条回报，
  一条最多详列 3 条（`MAX_DETAILED_REPORTS`），其余以计数提及。

避免 `queued` 被误读为「已通知」或「丢失」。

### 16.4 测试

`main.test.mjs` 25 → 28 条：`tailLines ∈ {1,2,5}` 精确行数 + `chunkBytes` 语义、
ids 跳过运行中（进程存活断言）+ `keepRunning:false` 强清对照、status:'running' 文案。

## 17. v0.6.0：插话投递 + 去掉合并窗口 + 方案 C 指令

探讨定案（2026-11-06）：回报的价值就在**及时**，原设计在这一点上自相矛盾——
后台任务的意义是让模型腾出手干长活，回报却要等到轮边界才送达，长回合里延迟以分钟计。

### 17.1 忙时插话（steer）

`deliver()` 给 `ctx.sessions.send` 传 `deliverAs: 'steer'`：回合进行中时在**下一个工具
调用边界**注入（模型有空看一眼的位置）；会话空闲时宿主照旧立即开新轮。宿主零改动——
sessions.send 的 deliverAs 契约本来就在，AgentTeam v0.8 的 team_send 已验证同款
「忙插话/闲唤醒」模式。

分心顾虑的解法是把处理方式写进消息本身：见 17.3 的指令。

### 17.2 合并窗口退役

5s 窗口当初防的是「空闲唤醒风暴」：一批并行任务同时结束，连开 N 个新轮。steer 化之后
这个顾虑塌了——第一条回报唤醒会话后，后续的作为 steer 搭同一班车进来，风暴天然有界。
为这点边际收益给所有回报加 5s 延迟不值。现在 `enqueueReport` 用 0ms tick 投递：
只把同一事件循环里连续结束的任务凑进同一批，不引入真实延迟。

**连带修复**：即时 flush 让「显式动作先拿终态」的三条防线全部失效（exit 回调入队后
下一个 tick 就投递，`suppressReport` 还没跑）。新增 `reportHold` 同步扣留机制：

- `describeStart`（内联回执窗口）：进函数先扣住，内联带结果就 suppress，还活着就放行；
- `bg_stop(waitMs>0)`：等终态前扣住，拿到就 suppress，超时放行（exit 回调照常回报）；
- `scheduleReport` 见 `reportHold` 直接跳过。

「清理已完成任务」不再可能抢在回报前面（清理是人的时间尺度），孤儿防线只剩
markDeleted-before-await 一条，由「边停边清」测试钉住。

### 17.3 方案 C：指令随批次状态切换

回报与当前工作的相关性插件判断不了，但「有没有失败项」是事实：

- **全部成功**：`仅供知晓，继续当前工作即可；若与手头工作直接相关，可顺手利用其结果`
- **含失败**：`失败任务可能影响后续步骤：与当前工作相关时请及时调整计划；否则向用户
  简报失败情况后继续。不要盲目重启失败的任务——先用 bg_output 确认原因或与用户确认`

成功的轻描淡写（steer 化后不会打扰），失败的重点提示。运行时长本来就在每条任务行
的头部（`耗时 Xm Ys`），保留。

### 17.4 测试

`main.test.mjs` 28 → 31 条：steer 传递、失败/成功两版指令、失败任务「即时回报 +
清理后不重复」的新时序。原「清理撤回报」测试随窗口退役改写；三处 6s 等待缩到 1s
（整个测试文件快了约 15s）。

## 18. v0.6.1：面板会话作用域 + 重启托盘补推 + bg_clear 文案

v6 复测之后的两个体验问题 + 一个文案尾巴：

### 18.1 右栏面板严格跟当前会话

**问题**：面板（panels[]）和应用分类入口一样跨会话展示全部任务——托盘已经是会话
作用域的，面板却把别的会话的任务混在一起，「感觉不太好」（零语拍板：严格当前会话，
无切换）。

**实现**：宿主本来就向面板 iframe 实时推送 `plugin-context`（含 sessionFile，会话
切换即重推），插件 UI 此前只是没用它。现在：

- **`listTasks` 投影补 `sessionFile` 字段**——此前面板跨会话展示，投影里一直没有它，
  过滤无从做起（e2e 抓出来的：任务在面板里「看不见」就是因为它）；
- UI 维护 `state.sessionFile`，`visibleTasks()` 按 main.mjs 同一套
  normSession/sameSession 规则过滤（全路径相等或 basename 相等）；
- 会话切换时 context 变化 → 收起展开项、重置签名、重建列表；
- 「清空已结束」改为只清**当前会话**的已结束任务（`clearTasks({ ids })` 点名）——
  原来传 `{}` 是跨会话全清，作用域收紧后这是隐藏的数据丢失面；
- 空态区分两种情况：全局无任务（引导文案）/ 其它会话有但本会话没有（说明作用域）。

### 18.2 重启后托盘补推

**问题**：托盘只在任务事件时推送，重启后没有任何事件——面板里有列表、对话框上方
却毫无痕迹，两边可见性不一致。

**修法**：`activate()` 在 `load()+recover()` 之后，对持久化里每个有任务的会话
`pushComposerBar` 一次。重启后 running 任务已被 recover 归入 lost，托盘摘要如实显示。

### 18.3 bg_clear 文案：跳过 ≠ 不存在

v6 实测：`bg_clear({ ids: ['运行中', '不存在'] })` 把两种情况合并报成
「id 不存在：运行中, 不存在」。`missing` 现在只算真正不存在的 id，运行中被
keepRunning 挡下的归入 `skippedRunning`，文案分开说：
`没有清理任何记录：1 个运行中任务已跳过（keepRunning=true，…）；id 不存在：bg-999。`

### 18.4 测试

`main.test.mjs` 31 → 33 条：activate 补推托盘（用复用 storage 模拟重启）、
ids 清理的 missing/skippedRunning 区分。fakeCtx 的 storage 支持复用。

## 19. v0.6.1 补丁：托盘启动兜底（激活推送早于 renderer 就绪）

### 19.1 现象与根因

重启后进入有残留任务的会话：右栏面板正常、托盘消失（v0.6.1 §18.2 的补推没生效）。

根因是**时序竞态**：`activateEnabledPlugins()` 与 `createWindow()` 在 app whenReady
里并行，插件 `activate()` 的托盘补推走 `publishPluginComposerBar` →
`webContents.send`——此时 renderer 的页面多半还没加载完、`ipc:events` 监听器
没挂上，推送直接丢失。Electron 的 send 没有排队语义，早到的消息就是没了。

之所以表现为「面板正常、托盘消失」：面板是**拉取式**（打开时 invoke
`listTasks`），托盘是**纯推送面**，丢了就再没有自然恢复的机会。

### 19.2 修法：main 状态表 + renderer 启动拉取

托盘的当前状态本来 main 侧就全知（每次推送都经过它），留一份即可兜底：

- `plugin-composer-bar.ts` 维护 `currentBars`（pluginId → sessionFile → bar，
  存归一化后的值），publish 入表 / null 出表；新增
  `listPluginComposerBars()`（拉取全量）与 `clearPluginComposerBars(pluginId)`
  （整表收回并按会话广播 null）；
- 新 IPC `ipc:plugins.composerBars.list`；
- renderer 启动（app.tsx 事件订阅 effect）拉一次，把每条构造成 `plugin_widget`
  事件走 `processEvent` 原路重放——路由、按会话落库、可见会话投影全部复用现有
  管道，幂等多拉无害（窗口 reload 也顺带覆盖）；
- 顺手修 `deactivatePlugin`：停用/卸载插件时 `clearPluginComposerBars`，
  此前托盘会残留一条没人再更新的摘要。

### 19.3 测试

`src/main/plugins/__tests__/plugin-composer-bar.test.ts` 新增 5 条：推送入表、
null 出表（仍广播）、同插件跨会话隔离、整表收回广播 null、空 sessionFile 忽略。
stores + composer 回归 41 文件 237 条全过。

### 19.4 追补：§19 首次没生效的两个原因

零语实测：托盘仍然不出现；但「停用插件再启用」立刻就有。这个现象把问题锁死在
**启动那一拉根本没成功**（停用/启用走的是推送，不经 IPC）。

1. **preload 通道白名单**：`window.piDesktop.invoke` 只放行
   `packages/shared/ipc-channels.ts` 里的通道，新加的 `ipc:plugins.composerBars.list`
   不在其中 → preload 直接 `Promise.reject` → 当初的 `.catch(() => {})` 把它吞了，
   表面看「什么都没发生」。**任何 renderer 发起的新 invoke 都必须同时加白名单**，
   仓库已有契约测试 `scripts/tests/ipc-channel-sync.test.mjs` 专门守这条，
   改完 IPC 记得跑 `npm run test:scripts`。
2. **反向竞态**：即使通道通了，启动拉取也可能早于插件 `activate()`
   （插件侧要 load 持久化 + recover 扫任务），这一刻 main 的状态表还是空的。
   于是「拉取早于插件就绪」和「推送早于 renderer 订阅」两头都可能踩空。

现在的兜底是三条一起上（`src/renderer/src/lib/plugin-composer-bar-sync.ts`）：

- 启动拉一次；
- 1.5s 后补拉一次（覆盖插件激活慢）；
- **每次切换会话再拉一次**——这是最贴合用户实际动作的一条：点进目标会话时
  插件早已就绪，从 main 状态表拉必然拿到。

失败的调用不再静默：打了 `[plugin-bars] sync failed` 的 warn，下次类似问题在日志里能直接看见。

### 19.5 连带修复

- `scripts/tests/apply-app-event-budget.test.mjs` 与 `fmsm-prd-gates.test.mjs` 的
  行数预算有 off-by-one：末尾换行被算成多一行，`apply-app-event.ts` 正好 120 行
  却被判 121。两处都改成先去掉末尾换行再计数。

## 20. v0.6.2：清空后面板不刷新（哨兵值撞车）

### 20.1 现象

点右栏面板「清空已结束」：托盘立刻消失（main 侧状态对），但面板还挂着旧列表，
必须切走再切回来（重载 iframe）才刷。只剩运行中任务时点清空倒是正常。

### 20.2 根因：空串既是「强制重绘」又是「空列表签名」

`ui/app.js` 的 `tick()` 用签名对比避免整表重建：

```js
const signature = visible.map(t => `${t.id}:${t.status}:${t.report}`).join(,)
if (signature !== lastSignature) { lastSignature = signature; rebuild() } else updateMeta()
```

而各处「动作之后强制下一拍重绘」都是 `lastSignature = `。列表清空后
`signature` 恰好也是 `` —— 两个 `` 相等，`tick()` 认为「没变化」，
`updateMeta()` 在旧 DOM 上跑一遍，列表就冻在那儿。`remove` 删掉最后一条时
同理（只是没人注意到）。

只剩运行中任务时不触发：签名非空，自然对不上。

### 20.3 修法

- 哨兵换成 `null`：`` 是「空列表」的**合法签名**，只有 `null` 才表示
  「未知，必须重绘」；`rebuild()` 渲染空态时仍写 ``（它确实对应空签名）。
- 清空按钮改成**本地先摘再重绘**：`clearTasks` 成功后从 `state.tasks` 摘掉这批 id、
  清掉它们各自的输出缓存与流选择、关掉已展开项，`rebuild()` 立即生效，再 `tick()`
  与 main 对齐——不等 1.5s 轮询，也不受 `busy` 抢占影响。
- 顺手把 `state.outputs.clear()` / `state.streams.clear()`（一刀清掉所有任务的
  输出缓存，运行中任务的滚动手感会丢）收窄成只清被清掉的那几条。

### 20.4 顺手补上 UI 侧测试

此前插件测试只覆盖 `main.mjs`（真实子进程行为），UI 一次没测——这类
「动作后界面不刷」的问题只能靠人肉点。新增
`plugins/background-tasks/ui/app.test.mjs`（3 条）：jsdom 起假宿主，拦
`plugin-invoke` 按真实 main 语义回包，**跑真实的 ui/app.js**：

- 清空已结束 → 列表立刻空、`clearTasks` 收到全部 id、空态文案出现
- 清空已结束 → 运行中的留着、按钮随之消失
- 清空只清当前会话，别的会话记录不动

用例里关掉了 1.5s 轮询（`setInterval` 换成空实现）：要证明的就是「动作之后
立刻刷」，靠轮询兜住的刷新正是要杜绝的现象。回滚到旧代码验证过：第 1、3 条
用例超时失败，第 2 条（清空后还剩运行中任务）通过——与现象完全一致。
