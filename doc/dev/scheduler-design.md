# 定时任务插件：设计（v0.2 · 应用入口 + agent 工具）

Status: **implemented**（2026-11-06）。代码基线 `feat/plugins-core`，插件 v0.1.0 → **v0.2.0**。
§1–§11 是定稿时的设计，§13 是实现记录与偏差（实施后以此为准）。

## 1. 结论

- **不做侧栏会话同列**。上一轮调研已经坐实：WorkBuddy 的「多次执行一行」= `automations` 表里的
  非会话列表项 + N 个被 `is_background_automation=1` 藏起来的会话；本仓库 `session.list` 只扫顶层
  `.jsonl`、不过滤、`buildSessionTree` 也没有虚拟行，复刻要动会话生命周期（元数据字段 + list 过滤
  + 面板跳转桥 + 移植 `plugin-sessions.ts`），收益只在「运行历史挂在会话列表里」，不值。
- **信息落点收敛到应用入口**（manifest `views[]` → 侧栏「应用」+ 中央内容区）。运行记录是插件的
  数据，就放在插件自己的页面里；宿主侧只留系统通知。
- 这一轮四个改动，按重要性排：
  1. **运行态可见**：现在只有跑完才写记录（`main.mjs:248` 在 `execute()` 末尾才 `unshift`），
     执行中和排队中在界面上完全不可见。补 `queued / running / interrupted` 三个状态。
  2. **应用入口重做信息架构**：宽屏主从（左任务列 + 右详情/时间线）、按日分组的运行时间线、
     列表与正文分离（列表不带 output，点开才拉）。
  3. **补 6 个 agent 工具**：现在 `plugin.json` 没有 `tools[]`、`main.mjs` 没有 `tool.execute`
     分支，模型**完全没有入口**创建定时任务——这是当前最大的功能缺口。
  4. **条件通知**：任务 prompt 里常见的「有变化才通知」当前做不到（只有跑完必弹）。补
     `notifyPolicy` + 基线注入 + 信号通道（见 §8.1，完整论证在 `scheduler-notify-research.md`）。
- 明确不做：会话归属、虚拟列表项、把每次执行开成宿主会话、把结果投回原会话（改投宿主信箱，
  见 §8.2）、`panels[]` 右栏（见 §12）。

## 2. 定位：为什么是「应用入口」

### 2.1 三种可能的呈现位置

| 落点 | 能回答的问题 | 代价 |
| --- | --- | --- |
| 侧栏会话列表（WorkBuddy 形态） | 「这事发生在哪个对话里」 | 要改宿主会话模型（元数据、过滤、跳转桥），跨模块 |
| 输入框上方托盘（`ctx.ui.setComposerBar`） | 「现在有没有事在跑」 | 只有摘要 + 最多 8 行，装不下运行历史；且托盘语义是「本会话的后台活动」，定时任务是全局的 |
| **应用入口（`views[]`）** | 「有哪些任务、跑得怎么样、结果是什么」 | 用户要主动点进来；但信息容量最大，零宿主改动 |

定时任务的本质是**全局调度**，不属于任何一段对话。把它挂在会话列表里，等于给每条运行记录
硬找一个「归属会话」，而这个归属在执行时并不存在（`runAgentPrompt` 起的是 inMemory 会话，
跑完就 dispose）。所以应用入口是语义上更正确的位置。

### 2.2 应用入口的边界

- 入口：侧栏「应用」区的「定时任务」图标 → 中央内容区整页（现有 `views[0]`，`ui/index.html`）。
- 同一份 HTML 在窄容器（<720px）下退化为单列，沿用现有 `@media` 分支（`style.css:136`）。
- 不做「全局悬浮提示」。想让用户知道任务跑完了，只有系统通知一条路（`ctx.notify`）。
- 通知点击只能 `app.focus()`（`plugin-host.ts:168`），**不能深链到应用入口**——宿主没有这个能力，
  写在这里以免实施时误以为漏做了。

## 3. 现状盘点

| 能力 | 现状 | 差距 |
| --- | --- | --- |
| 调度引擎 | 5 种（once/daily/weekly/monthly/interval）、`validUntil`、tick 5s、到点先推进再入队（`main.mjs:157`） | 够用，无需改语义 |
| 错过处理 | once 补跑、重复任务顺延、启动时 `recoverMissed()`（`main.mjs:181`） | 够用 |
| 并发 | 串行队列 `drain()`（`main.mjs:209`） | 队列不可见；同任务重复触发时静默丢弃（`main.mjs:204`） |
| 执行 | `ctx.runAgentPrompt`，15 分钟超时（`main.mjs:231`） | inMemory 会话，**没有插件工具**（见 §7.5）；结果只有最后一条 assistant 文本 |
| 运行记录 | `state.runs` 只在结束时写入，`resultText` 截断 20KB | 无 queued/running；`listRuns` 一次返回 200 条**含全部正文**（`main.mjs:365`） |
| 存储 | 全部塞 `ctx.storage` → `data.json`，每次 `save()` 全量序列化（2 空格缩进） | 200 条 × 最多 20KB ≈ 4MB，每次写盘都要重排一遍 |
| UI | 四视图：列表 / 编辑 / 详情（含历史）/ 运行记录总览 | 列表→详情是跳转式；运行记录无分组、无筛选；无运行中动效；无空态引导 |
| 工具 | **0 个**（`.plugin.json` 无 `tools[]`，`invoke` 只分发 `methods`） | agent 无法创建/查询/停止定时任务 |
| 通知 | 开始（可关）+ 结束（必发） | 够用 |

## 4. 数据模型

### 4.1 task

在现有字段上补 4 个（其余不动）：

```js
{
  id, name, prompt, schedule: { kind, time, weekday, day, everyMinutes, at },
  cwd, validUntil, enabled, done, nextRunAt, lastRunAt, lastRunOk,
  createdAt,
  updatedAt: number,           // 新增：UI 显示「刚改过」，也用于审计
  createdBy: 'user' | 'agent', // 新增：应用入口标一枚「由助理创建」小标签
  originSessionFile: string,   // v0.3：投信箱时的来源标注（不再用于投回会话，见 §8.2）
  runCount: number             // 新增：累计执行次数，prune 掉历史后仍有总数
}
```

`schedule.time` 一律 `HH:mm` 本地时间；`schedule.at` 只在 `once` 下有意义（ISO 8601）。
`nextRunAt` 是**派生值**，每次 `saveTask` / `setTaskEnabled` / tick 后重算，不信任磁盘上的旧值
（应用可能停机数天）。

### 4.2 run

```js
{
  id: 'run-<queuedAt>-<rand6>',
  taskId, taskName,            // 快照：任务改名/删除后历史仍可读
  status: 'queued' | 'running' | 'ok' | 'failed' | 'interrupted' | 'skipped',
  trigger: 'scheduled' | 'missed' | 'manual',
  queuedAt, startedAt, finishedAt, durationMs,   // 后三个在排队阶段为 null
  cwd,                         // 快照：任务改过目录后能看出这次跑在哪
  promptPreview,               // prompt 前 200 字符，回答「这次跑的是哪一版」
  output,                      // 最终答复，落盘截断 16KB
  error,                       // 失败原因；ok 时为空串
  skipReason,                  // status==='skipped' 时：'overlap' | 'queue_full' | 'disabled'
  inboxState: 'none' | 'sent' | 'suppressed',  // 是否投了宿主信箱（§8.2），v0.2 恒为 'none'
  v: 1
}
```

`output` 上限从 20KB 降到 16KB：单条记录变小，压缩阈值好算；正文够长，超出部分用户也不需要
（agent 的最终答复本来就该简短）。

### 4.3 状态机

```
                enqueue                execute 开始            runAgentPrompt 成功
   （无记录） ──────────→ queued ──────────────→ running ────────────────────→ ok
                             │                     │
                             │ 被删/停用/队列满      ├─ 抛错 / result.ok=false ─→ failed
                             └────────────────────→└─ 超时 abort ─────────────→ failed（error 带 timeout）
                                                     └─ 进程崩溃 ──（重启时扫描）→ interrupted
```

- `queued` 与 `running` **都落盘**：一次执行最多 3 次追加写（queued / running / 终态），换来崩溃后
  能看出「上次中断在哪个任务」。
- 启动时把所有仍是 `running` / `queued` 的记录改成 `interrupted`（`skipReason: 'app_exit'`）。
  这是唯一的僵尸兜底，比纯内存态可靠。
- 同一个任务已经在 `queued` / `running` 时再次被触发：不再静默 `return`（`main.mjs:204`），
  而是记一条 `skipped / overlap`。用户点两次「立即运行」时能看到「已在执行，本次跳过」。

### 4.4 存储布局

`ctx.storage` 的定位是「小状态」（`plugin-context.ts:23`），运行记录不是小状态。拆成两个文件：

| 文件 | 内容 | 写频率 |
| --- | --- | --- |
| `plugin-data/scheduler/data.json` | `{ schemaVersion: 2, tasks: [...] }` | 任务变更时 |
| `plugin-data/scheduler/runs.jsonl` | append-only 事件流，一行一条 | 每次状态变化 |

**JSONL 格式**（`runs.jsonl`）：

```jsonl
{"v":1,"op":"upsert","run":{...}}
{"v":1,"op":"upsert","run":{"id":"run-...","status":"running",...}}
{"v":1,"op":"delete","id":"run-..."}
```

- 同一 `id` 后写覆盖先写；启动时逐行 parse，用 `Map<id, run>` 折叠。
- **坏行容错**：逐行 `try/catch` + 跳过，最后一行可能是写到一半的（进程被杀），直接丢弃。
- **压缩**：内存中记录数 > `max(400, 4 × 保留条数)` 或文件 > 8MB 时重写一遍（只写当前有效记录，
  按 `queuedAt` 升序）；原子写（`runs.jsonl.tmp` → `renameSync`）。
- **删除单条**：追加 `{op:'delete',id}`，内存立即移除；不重写文件。
- **迁移**：读到 `data.json.runs` 时（v0.1 的老数据），按 `startedAt` **升序**写入 JSONL（保证折叠后
  顺序正确），随后写 `schemaVersion: 2` 并删掉 `runs` 字段。迁移只做一次，失败则保留老数组继续用
  内存态（不阻塞激活）。

为什么不是「单个 runs.json」：每次写要重排 4MB 的 JSON；为什么不是「每任务一个分片」：
任务删除要清目录、跨任务总览要开 N 个文件——单文件 + 折叠 + 压缩是这类「只追加的流水」的常规解。

## 5. 调度语义

保留现有全部语义（§3 表格第一行），只做 4 处修正：

| # | 修正 | 理由 |
| --- | --- | --- |
| 1 | 入队即产生 `queued` 记录 | 「点了立即运行没反应」是目前最差的交互 |
| 2 | 重叠触发记 `skipped/overlap` | 静默丢弃让用户以为跑了两遍 |
| 3 | 队列上限 20，超出记 `skipped/queue_full` 并通知一次 | 5 个 interval 任务同时到点 + 一个长任务会积压 |
| 4 | 单任务超时改为设置项 `taskTimeoutMinutes`（默认 15，上限 120） | 长活（如构建）15 分钟不够，硬编码在 `main.mjs:234` |

**手动执行不推移周期**——现状就是这个行为（`runNow()` 只 `enqueue`，不动 `nextRunAt`，
`main.mjs:359`），与 WorkBuddy 一致：手动补跑一次不改变既定节奏。加一条单测钉住，防止后来者
「顺手优化」成推移。

## 6. 应用入口 UI

### 6.1 布局

宽屏（≥ 900px）改为主从；窄屏保持现有的「列表 → 详情」跳转（`app.js:381` 的 `renderDetail`）。

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  定时任务    运行记录                          [ 搜索任务 ]        ＋ 新建      │
├───────────────────────┬──────────────────────────────────────────────────────┤
│ ● 执行中 1 · 排队 0    │  每日简报                              每天 08:30     │
│                       │  ┌────────────────────────────────────────────────┐  │
│ ┌───────────────────┐ │  │ 下次执行   明天 08:30（还有 13 小时）           │  │
│ │● 每日简报      ✓  │ │  └────────────────────────────────────────────────┘  │
│ │  每天 08:30       │ │  [ 立即运行 ]  [ 停用 ]  [ 编辑 ]        [ 删除 ]    │
│ │  整理今天的工作…  │ │                                                      │
│ └───────────────────┘ │  提示词  ▾ 整理今天的工作安排，输出 3 条要点…         │
│ ┌───────────────────┐ │                                                      │
│ │  周报（已停用）   │ │  运行记录                                            │
│ │  每周一 09:00     │ │  ── 今天 ─────────────────────────────────────────   │
│ └───────────────────┘ │   ● 08:30  成功   42s   定时                          │
│                       │   │   今天的工作有 3 项：第一…（前 6 行，可展开）      │
│                       │   ├─────────────────────────────────────────────────  │
│                       │   ● 昨天 08:30  成功  38s   定时                      │
└───────────────────────┴──────────────────────────────────────────────────────┘
```

左列固定 300px（`grid-template-columns: 300px 1fr`），右列自适应、最大 820px 居中——与现有
编辑页的 `max-width: 820px` 一致（`style.css:140`）。

### 6.2 任务列表（左列）

三组，固定顺序，组内排序不同：

| 分组 | 判据 | 排序 | 备注 |
| --- | --- | --- | --- |
| 执行中 | 有 `queued` / `running` 记录 | 按 `queuedAt` 升序 | 组标题带脉冲点，无内容时整组不渲染 |
| 已启用 | `enabled && !done` | `nextRunAt` 升序 | 默认组 |
| 已结束 | `!enabled \|\| done` | `lastRunAt` 降序 | 组标题「已停用 / 已完成 (N)」 |

卡片三行（现在是四块挤在一起，`app.js:201`）：

1. 状态点 + 名称 + 「由助理创建」小标签（`createdBy === 'agent'`）+ 右侧开关
2. 调度文案 + 下次执行（相对/绝对，`fmtCountdown` 已有）
3. prompt 单行省略（`text-overflow: ellipsis`，`title` 挂全文）

操作按钮（运行 / 记录 / 编辑 / 删除）**移到 hover / focus-within 才显示**，触摸设备常显
（`@media (hover: none)`）。现状四个 icon 常驻，一屏十条任务就是四十个按钮，视觉噪音盖过信息。

执行中的卡片换一套内容：第 1 行变成「执行中 · 12s」（耗时本地每 0.5s 刷新，不靠轮询），
第 2 行「开始于 14:03」，第 3 行仍是 prompt；右侧按钮只剩「查看运行」。

### 6.3 任务详情（右列）

- **头**：名称（可点改名）、调度文案、状态徽章
- **倒计时块**：`下次执行 明天 08:30 · 还有 13 小时`。`nextRunAt` 与 `serverNow` 差值本地每秒重算，
  只在 `nextRunAt` 变化时才用服务端数据
- **按钮组**：立即运行 / 停用（启用）/ 编辑 / 删除（危险色，二次确认带任务名）
- **提示词**：默认折叠 2 行，点开展开全文 + 「复制」
- **运行记录时间线**：见 §6.4，只显示本任务

### 6.4 运行记录（时间线）

两处复用同一个渲染函数：详情页（只本任务）与「运行记录」页（全部任务）。

- **分组**：按本地日期分「今天 / 昨天 / 11 月 4 日」，组头 sticky（滚动时吸顶）。
- **行**：状态点 + 任务名 + 状态词 + 触发标记 + 相对时间 + 耗时 + 展开箭头 + 删除。
  - 触发标记只对 `missed` / `manual` 显示（「补跑」「手动」），`scheduled` 不标——多数情况是它，
    标了等于噪声。
- **展开**：`output` 前 6 行 + 「展开全部」（`max-height: 320px` 滚动），右下角「复制」。
  失败时先渲染错误块（等宽、红色左边框），再渲染 output（如果有）。
- **筛选**（仅总览页）：`全部 / 成功 / 失败 / 执行中` 四个 chip + 任务下拉。筛选状态存在内存，
  切页不丢。
- **空态**：总览页「任务还没跑过。到点执行或点『立即运行』后，记录会出现在这里」；
  任务详情页「这个任务还没有运行记录」。

### 6.5 状态语言

内部状态留在插件里，UI 只做映射（对齐 `plugin-composer-bar` 的经验：观感词不外泄）：

| status | 观感 | 色 | 文案 | 图标 |
| --- | --- | --- | --- | --- |
| `queued` | idle | 灰 + 虚线环 | 排队中 | `clock` |
| `running` | active | 主色 + 脉冲 | 执行中 · 12s | `loader` |
| `ok` | ok | 绿 | 成功 | `check` |
| `failed` | error | 红 | 失败 | `x` |
| `interrupted` | warn | 橙 | 已中断（应用退出） | `alert` |
| `skipped` | warn | 橙 | 已跳过 · 已在执行 | `slash` |

色值走主题变量：`--ok` / `--err` 已有（`style.css:15`），新增 `--warn: #d97706`（暗色主题下
`var(--pi-warning, #f59e0b)`）。所有底色用 `color-mix(in srgb, var(--x) 12%, transparent)`
派生，不硬编码浅色。

### 6.6 交互与键盘

| 动作 | 行为 |
| --- | --- |
| 点任务卡 | 宽屏：右列切换，不重绘左列；窄屏：进详情页（现状） |
| 立即运行 | 行内立刻出现 `排队中` 记录 + 按钮禁用 1s，不整页 loading |
| 删除任务 | `confirm()` 带任务名与「历史记录一并删除」提示（现状只提示前半句，`app.js:523`） |
| 删除记录 | 不确认（可再跑一次），删除后焦点留在相邻行 |
| `Esc` | 展开的结果 → 折叠；否则退一级（现状 `app.js:54`） |
| `↑` / `↓` | 左列任务间移动，`Enter` 打开 |
| 复制结果 | `navigator.clipboard.writeText`，按钮 1.2s 内变「已复制」 |

### 6.7 首次体验

空态不是一句「还没有定时任务」，给三个**可一键创建**的示例模板：

1. 每天 09:00 · 「整理今天的工作安排，输出 3 条要点」
2. 每周一 09:30 · 「汇总上周我改过的文件，写一份周报草稿」
3. 每小时 · 「检查当前目录的构建是否仍然通过，失败时说明原因」

模板点击后进编辑页并预填 prompt / schedule，用户只需确认。**不直接创建**——用户要先看见
prompt 长什么样，才知道 agent 到点会去干什么。

### 6.8 性能与数据量

| 项 | 决定 |
| --- | --- |
| 快照接口 | `snapshot()` 一次返回 `{ tasks, active: [...], lastRunByTask: {...}, serverNow }`，替代现在 `listTasks` + 每任务翻 `state.runs` |
| 列表不带正文 | `listRuns` 返回的每条只有 `outputPreview`（120 字符）+ `hasOutput`；展开时调 `getRun({id})` 拉全文 |
| 轮询 | 有 `running` 时 2s，否则 5s（现在固定 5s，`app.js:542`） |
| 去重重绘 | 沿用 `runsSignature()`（`app.js:499`），签名改成 `id + status + output.length`，避免每 2s 重排 DOM 打断阅读 |
| 不做虚拟滚动 | 单页最多 200 条，DOM 量可接受；超过就是压缩阈值该管的事 |

## 7. agent 工具

### 7.1 清单（6 个）

| 工具 | 作用 | 主参数 | 卡片 |
| --- | --- | --- | --- |
| `sched_create` | 建任务 | `name` `prompt` `kind` + 调度参数 | `kv` |
| `sched_list` | 列任务（含下次执行/上次结果） | `status` `id?` | `list` |
| `sched_update` | 改任务（含启停） | `id` + 任意可改字段 | `kv` |
| `sched_delete` | 删任务 | `id` | `kv` |
| `sched_run_now` | 立即跑一次 | `id` `waitMs?` | `kv` |
| `sched_runs` | 查运行记录 | `taskId?` `status?` `limit?` `withOutput?` | `list` |

**为什么不是 3 个**：`create` 与 `update` 的校验分支完全不同（一次性的 `at` 已过要拒绝，改时间要
重算 `nextRunAt`），合并成一个会让模型在「只想改个时间」时也要复述整个任务，出错率高；
`delete` 是危险动作，需要独立文案与人工确认语，不能混在 update 里。
**为什么不是 8 个**：把「启停」「改调度」「改 prompt」拆开，模型每次都要先判断该用哪个，
schema 也重复；`sched_update` 的部分更新语义（只传要改的字段）已经覆盖。

### 7.2 schema 草案：`sched_create`

```json
{
  "type": "object",
  "properties": {
    "name": { "type": "string", "description": "任务名，简短可辨识，如「每日简报」、npm 构建检查。最长 60 字。" },
    "prompt": { "type": "string", "description": "到点交给 agent 执行的完整指令。执行时是全新会话，看不到当前对话，所以必须自包含：写清做什么、在哪做、输出什么格式。不要写「和之前一样」。" },
    "kind": { "type": "string", "enum": ["once", "daily", "weekly", "monthly", "interval"], "description": "重复方式。daily/weekly/monthly 用 time；interval 用 everyMinutes；once 用 at。" },
    "time": { "type": "string", "description": "HH:mm，本地时间。daily/weekly/monthly 用，默认 09:00。" },
    "weekday": { "type": "integer", "description": "weekly：0=周日 … 6=周六，默认 1（周一）。" },
    "day": { "type": "integer", "description": "monthly：1-31。当月没有该日时执行在当月最后一天。" },
    "everyMinutes": { "type": "integer", "description": "interval：间隔分钟数，1-43200。60 的整数倍会显示为小时。" },
    "at": { "type": "string", "description": "once：ISO 8601 本地时间，如 2026-11-07T09:00。省略则 5 分钟后；已过去的时间会被拒绝。" },
    "cwd": { "type": "string", "description": "执行时的工作目录（绝对路径）。默认用当前会话的目录——通常不用填。" },
    "validUntil": { "type": "string", "description": "YYYY-MM-DD，最后一天（含当天）。留空 = 长期有效。" },
    "enabled": { "type": "boolean", "description": "默认 true。false = 建好但先不跑。" }
  },
  "required": ["name", "prompt", "kind"]
}
```

给模型看的 `description`（工具级）必须写清三件事：

1. **什么时候用**：「用户说『以后每天/每周几/到点提醒我做某事』时创建；一次性的『明天下午三点提醒我』
   也用这个（`kind: 'once'`），不要用其它方式记待办。」
2. **任务的持续性**：「任务会一直存在（跨会话、跨重启），到点自动执行，直到用户删掉或停用。
   创建前先用 `sched_list` 查有没有同名同 prompt 的任务，不要重复建。」
3. **执行环境**：「执行时是全新的 headless 会话，看不到这段对话，只能用内置工具
   （bash / read / write / find / grep / ls），调不到插件工具。prompt 里不要引用上下文。」

`sched_update` 用同一套参数 + `id` 必填，差别只在 `description`：「只传要改的字段，未传的保持不变。
改调度后 `nextRunAt` 会重算并按新时间复述给用户。」

`sched_runs` 的 `withOutput` 默认 `false`：「默认只返回摘要（状态、耗时、前 120 字）。用户问『上次
具体说了什么』时才传 true。」

### 7.3 返回值

统一 `{ text, details }`（`plugin-host-api.md` §5：content 只能是文本，结构化走 details）。

```js
// sched_create
{
  text: '已创建「每日简报」，每天 08:30，下次执行：明天 08:30。\n任务 id：task-20261106-a1b2c3\n' +
        '要改时间用 sched_update，要停用随时说。',
  details: { id: 'task-...', nextRunAt: 1793500200000, scheduleLabel: '每天 08:30' }
}
```

- `text` 里**必须复述 `nextRunAt` 的本地时间**：模型自己算「明天 8:30」经常算错星期/跨月，
  复述一遍就把错误暴露在对话里，用户当场能纠。
- 失败返回 `{ text, isError: true }`，不要抛异常（抛了宿主会包成 `sched_create failed: ...`，
  模型看不清是哪一步）。
- 列表类工具用小表格文本，别贴 JSON：

```
2 个定时任务

1. 每日简报（task-...a1b2）· 每天 08:30 · 下次 明天 08:30 · 上次 今天 08:30 成功
2. 周报（task-...d4e5）· 每周一 09:30 · 已停用
```

### 7.4 工具与 UI 共用一层

工具 handler **不直接改 `state`**，只做「参数映射 → 调 `methods` → 组织文案」：

```
sched_create → normalizeTaskInput(args, {createdBy:'agent', cwd: 工具 ctx.cwd})
             → methods.saveTask({task})
             → 读返回的 task.nextRunAt 组织文案
```

为此把现在写在 `saveTask` 里的校验（`main.mjs:309`）抽成 `normalizeTaskInput()`，返回
`{ task, errors: string[] }`。UI 的 `saveTask` 与工具都走它——否则两套校验必然漂移（比如
「`at` 已过去」UI 是静默标 `done`，工具那边应该报错）。

`invoke` 分发按 `background-tasks/main.mjs:105` 的写法：先判 `tool.execute`，`Object.hasOwn`
防原型链，异常兜成 `{ text, isError: true }`，不要 `try/catch` 后静默 `return {}`。

### 7.5 安全边界

插件工具**不受内置工具白名单约束，权限等同 bash**（`plugin-host-api.md` §5）。定时任务工具等于
「让 agent 在用户离开后执行任意 prompt」，比一次 bash 调用更持久，所以加四条边界：

| 边界 | 做法 |
| --- | --- |
| 可审计 | 任务在应用入口明文可见，标 `createdBy: 'agent'`；prompt 全文可读 |
| 可撤销 | 一条消息就能停用/删除；`sched_list` 是模型查状态的第一入口 |
| 不越权扩张 | 任务数上限 50；`cwd` 必须是存在的绝对路径（否则到点必失败）；prompt ≤ 8000 字 |
| 危险动作留给人 | `sched_delete` 的 description 写死「只在用户明确要求删除时调用」；不提供批量删除；不提供「改 cwd 到任意位置」的默认值 |

**执行侧的真实限制**（必须写进文档，否则实施时会误判）：`runAgentPrompt` 直接用
`pi.createAgentSession({ cwd, sessionManager: inMemory })`（`plugin-host.ts:85`），**没有传
extensions**，所以定时执行里的 agent 拿不到插件工具（`bg_start`、`ask_user` 等），只有内置工具。
这是这一轮的已知边界，不是实现缺陷；要补需要动宿主，列入 §12。

### 7.6 典型对话

```
用户：以后每天早上八点半给我整理今天的工作安排

模型：sched_create({ name: '每日简报', prompt: '整理今天的工作安排：读一遍当前项目的待办和
       最近改动，输出 3 条要点，每条一句话。', kind: 'daily', time: '08:30' })
     → 已创建「每日简报」，每天 08:30，下次执行：明天 08:30。id: task-... 
```

```
用户：那个简报改成九点吧

模型：sched_list({})            ← 先拿 id，不要猜
     → 1. 每日简报（task-...a1b2）· 每天 08:30 …
     模型：sched_update({ id: 'task-...a1b2', time: '09:00' })
     → 已更新「每日简报」，每天 09:00，下次执行：明天 09:00。
```

```
用户：昨天那次跑得怎么样

模型：sched_runs({ taskId: 'task-...a1b2', limit: 1, withOutput: true })
     → 今天 08:30 · 成功 · 42s + 结果正文
```

## 8. 通知与结果落点

### 8.1 v0.2：条件通知（调研结论见 `scheduler-notify-research.md`）

现状是「跑完必弹通知」，而用户的真实需求是「**发生变化才通知**」。调研结论：条件通知不是一句话
能开的开关，它需要三样东西——判定（agent 或机械指纹）、信号通道（agent → 插件）、策略
（插件侧 `notifyPolicy`）。三者缺一，就只能退化成「每次都通知」或「从来不通知」。

v0.2 落 P0 的全部内容（零宿主改动）：

| 部件 | 做法 |
| --- | --- |
| 基线 | 插件自动保存上次结论摘要（600 字），执行前拼进 prompt；首次执行标「无历史基线」 |
| 信号 | 双通道：结果文件（`dataDir/signals/<runId>.json`）+ 输出协议（`SCHED:changed` / `SCHED:unchanged` / `SCHED:failed`），任一命中即采信 |
| 兜底 | 都失败 → 按「有变化」通知（fail-open to notify），`signalSource: 'fallback'` |
| 策略 | 任务级 `notifyPolicy`：`always` / `on-change` / `failures` / `never` |
| 留痕 | 未通知的 run 记 `notify: 'none'` + 原因码 `notifyWhy`（`never` / `failures-ok` / `unchanged` / `manual`），人读文案由 `format.notifyLabel()` 统一出，UI 与 `sched_runs` 都读它 |

开始通知仍由 `notifyOnStart` 控制（默认开）；结束通知改为按 `notifyPolicy` 决定。

**为什么不做「每次都通知 + 让用户自己忽略」**：通知是打断，监控类任务按小时跑，一天 24 次里
23 次没有信息量，用户会关掉整个插件的通知——连真变化也一起关掉。

### 8.2 结果去哪：宿主信箱（Inbox），不回原会话

**决策（2026-11-06）**：不投回发起任务的会话，投到 pi-app 自带的通知收件箱
（顶栏 Inbox，`src/renderer/src/features/shell/notification-inbox.tsx`）。

会话回投不划算的四个理由：

1. 定时任务是**全局调度**，不属于任何一段对话（§2）。投进某段对话，等于给一条无人称的事件硬找
   一个归属。
2. **一半任务投不了**：只有「由 agent 在某个会话里创建」的任务才有 `originSessionFile`；用户在
   应用入口手动建的任务没有。
3. **污染对话**：每天一条的简报会把用户真正在聊的内容往上顶，而它本来不需要即时回应。
4. 会话被删/归档后投递目标消失，只能降级成「不投」。

信箱合适的原因：pi-app 已经有这个东西，语义也正好是「异步事件进事件容器」——
顶栏图标、未读红点（`desktop.setBadge`）、全部/未读筛选、标已读/未读、点击跳转。

#### 现状与限制（都查过代码）

| 事实 | 位置 | 影响 |
| --- | --- | --- |
| inbox 是**内存数组**，`MAX_SEEN = 200`，无持久化 | `completion-notification-controller.ts:64 / 135` | 重启清空 → **信箱是提醒，不是归档**；历史仍在应用入口的 `runs.jsonl` |
| 唯一入口是 `handleCompletion`（会话一轮结束） | 同上 `:145` | 插件事件进不去——但 controller 已把 `rememberInbox` 导出（`:225`），宿主有现成插入点 |
| 卡片点击依赖 `sessionFile`，没有就禁用并提示「会话已不存在」 | `notification-inbox.tsx:88-97` | 定时任务没有会话文件 → 必须给 card 加插件目标分支 |
| `CenterView` 没有参数（`{kind:'plugin', pluginId, viewId}`） | `plugin-manifest.ts:213` | 只能跳到视图，定位到具体 run 要靠插件自己的 `pendingFocus` |

#### 宿主改动清单（5 个文件 + 契约测试）

| 文件 | 改动 |
| --- | --- |
| `packages/shared/plugin-context.ts` | `PluginUI.inbox(item)` + `PluginInboxItem`（pluginId / title / body / tone / target / ref） |
| `completion-notification-controller.ts` | `CompletionCard` 加可选 `target?: { pluginId: string; viewId: string }`；`rememberInbox` 已导出，无需改逻辑 |
| `completion-notification.ts` | 导出 `pushPluginInbox(card)`（转发给 controller） |
| `plugins/plugin-host.ts` | `ctx.ui.inbox()` 实现，`tone` 映射到 `outcome: 'success' \| 'failed'` |
| `renderer/.../notification-inbox.tsx` | `InboxItem` 加 `target`；有 target 时点击 → `setCenterView({kind:'plugin',...})` + `markRead`；无 `sessionFile` 且无 target 才禁用 |
| `doc/dev/plugin-host-api.md` §2 表格 + `scripts/tests/plugin-typing.test.mjs` | 补齐契约（写进 ctx 就必须同步文档，否则测试挂） |

#### 投递策略（与 §8.1 共用同一份判定）

| 情况 | 系统通知 | 信箱 |
| --- | --- | --- |
| 有变化 | ✓ | ✓（正文用 `summary`） |
| 失败 | ✓ | ✓ |
| 判定 fallback（按有变化处理） | ✓ | ✓ |
| 无变化 | ✗ | ✗（只写应用入口） |
| 手动 `runNow` | ✗ | ✗ |

即：`notifyPolicy` 决定「发不发」，全局设置 `deliveryChannel`（`system` / `inbox` / `both`，
默认 `both`）决定「发到哪」。两个渠道不是二选一 —— 系统通知管「当下」，信箱管「回来补看」。

#### 插件侧的定位

宿主只打开视图，不带参数。所以 main 侧记一个 `pendingFocusRunId`，UI `boot()` 时调
`consumeFocus()` 取一次并展开那条记录。**不扩展 `CenterView` 的参数**——为一个插件的深链需求
改公共类型不划算。

#### 分两步走

| 批次 | 内容 | 依赖 |
| --- | --- | --- |
| v0.2（批次 A/B）✅ | 条件通知 + 应用入口未读 + 系统通知 | 零宿主改动 |
| v0.3（批次 C）✅ | `ctx.ui.inbox` 宿主能力 + scheduler 接入 | 5 文件 + 测试 |

**为什么不一锅端**：v0.2 的 main 侧已经是「拆模块 + 状态机 + 6 个工具 + 条件通知」一整批，再塞
一个跨 main/shared/renderer 的宿主能力，会让这批的可验收性变差（renderer 改动没有单测覆盖，
只能手测）。先把「什么时候发」做对，再换「发到哪里」。

#### 落地记录（v0.3，2026-11-06）

实际改动（比清单少了 1 个：`pluginId` 由宿主注入，插件条目里不带）：

| 文件 | 实际改动 |
| --- | --- |
| `packages/shared/plugin-context.ts` | `PluginUI.inbox(item)` + `PluginInboxItem` / `PluginInboxTone` / `PluginInboxTarget` |
| `completion-notification-controller.ts` | `CompletionCard` 加 `target` / `tone`；新增 `pushPluginInbox(pluginId, item)` |
| `completion-notification.ts` | 导出 `pushPluginInbox(pluginId, item)` |
| `src/main/plugins/plugin-host.ts` | `ctx.ui.inbox()`：校验 title、try/catch 不抛错 |
| `renderer/.../notification-inbox.tsx` | `target` 点击 → `setCenterView` + `markRead`；`tone` 决定图标与颜色 |
| `doc/dev/plugin-host-api.md` | §2 表格 + 新增 §6.3 |

与本节上面设想的差异（都是**收窄**，不是加码）：

1. **没有 `deliveryChannel` 设置**。做一个「发到系统通知 / 发到信箱 / 两个都发」的开关，
   等于让用户先理解两套渠道的存在；实际语义很清楚——条件满足就两边都投，系统通知负责
   「当下」，信箱负责「回来还看得到」。少一个设置项，少一处解释成本。
2. **去重靠 `dedupeKey`（= taskId）而不是 `ref`**：同一任务的条目在信箱里只保留最新一条，
   替换时重新变未读。没有它，一个每分钟跑的任务会把 200 格信箱刷满、红点永久点亮。
3. **没做 `pendingFocusRunId` 深链**：点信箱只切到插件视图（`CenterView` 不带参数）。
   插件自己的未读标记（`snapshot.unreadByTask` + 打开详情即 `markSeen`）足够把人引到任务上，
   再加一条「带着 runId 跳转」的公共类型改造不值当。

测试：controller 侧 4 条（未读/不弹通知、dedupeKey 替换、跨插件不串、空 title 丢弃），
scheduler 侧 2 条（到点执行同时投通知与信箱且带 target、手动执行一条都不投）。

注意 **renderer 那段没有单测覆盖**（项目里没有 inbox 的组件测试），靠手测：
`sched_create` 一个 once 任务到点后，顶栏红点亮起 → 点开列表里出现「定时任务：…」→
点击应切到定时任务视图并把该条标已读。

## 9. 风险与对策

| 风险 | 触发场景 | 对策 |
| --- | --- | --- |
| 应用关着时错过 | 关机过夜 | 已有：once 补跑、重复任务顺延（`main.mjs:181`）。UI 上把补跑记录标「补跑」，别让用户以为是准点 |
| 长任务堵住队列 | 15 分钟任务 + 每小时任务 | 队列上限 20 + `skipped/queue_full` 可见 + 超时设置项 |
| 结果只有最终答复 | inMemory 会话 dispose | 明说：运行记录展示的是最终答复，不是过程。想看过程得 P1 把每次执行落成会话（不在本轮） |
| runs.jsonl 无限增长 | 每天 24 次 × 10 任务 | 每任务保留 `historyLimit`（默认 30）+ 全局 200 + 压缩阈值 |
| 崩溃留下 running 僵尸 | 执行中退出 | 启动扫描 → `interrupted` |
| 工具被滥用建一堆任务 | 模型误判「以后每天」 | 上限 50 + `sched_list` 去重 + UI 可见 + 一条消息可停用 |
| 时区/跨月算错 | `monthly` 31 号、夏令时 | 现有 `nextMonthly` 取当月最后一天；文案统一走 `toLocaleString('zh-CN')`，不自己拼日期 |

## 10. 实施计划

两批，每批可独立验收；不写天数，按依赖顺序。

### 批次 A：main 侧（先做，UI 依赖它的形状）

1. 拆 `lib/`：`store.mjs`（data.json + runs.jsonl + 迁移 + 压缩）、`schedule.mjs`（现有纯函数原样搬）、
   `runs.mjs`（状态机）、`methods.mjs`、`tools.mjs`、`main.mjs`（薄入口）。对齐
   `background-tasks` 的模块划分（`background-tasks-design.md` §26）。
2. 运行状态机：`queued / running / ok / failed / interrupted / skipped` + 启动扫描。
3. 新接口：`snapshot()`、`getRun({id})`、`listRuns` 不带正文。
4. `normalizeTaskInput()` 抽出，`saveTask` 改用它。
5. 6 个工具 + `tool.execute` 分发 + `plugin.json` 的 `tools[]`。
6. 迁移与兼容：老 `data.json` 的 `runs` 搬进 JSONL，`schemaVersion: 2`。

**验收**：`npm run test:plugins` 全绿；`npm run typecheck:plugins` 无错；手工起一个 interval 任务，
在 `runs.jsonl` 里能看到 queued → running → ok 三条；杀进程重启后那条变 `interrupted`。

### 批次 B：UI

1. 宽屏主从布局 + 左列分组；窄屏沿用跳转。
2. 时间线渲染（按日分组、展开、复制）。
3. 运行中/排队态、hover 显示操作、空态模板。
4. 轮询节奏与签名去重。

**验收**：见 §11 手动清单。

### 批次 C（v0.3，需宿主改动）

`ctx.ui.inbox` 宿主能力（§8.2 的 5 文件清单）+ scheduler 接入信箱；`panels[]` 右栏、运行结果导出
markdown、并发可配另议。

## 11. 测试计划

### 11.1 单测（`plugins/scheduler/main.test.mjs`，参照 `background-tasks/main.test.mjs` 的 fake ctx）

- 调度：5 种 kind 的 `computeNextRun` 正反向；跨月 31 号；`validUntil` 到期；once 已过去。
- 状态机：queued → running → ok/failed；重叠触发 → `skipped/overlap`；队列上限 → `queue_full`；
  启动把 running 改成 interrupted。
- 存储：JSONL 坏行容错（末行截断）；同 id 覆盖；删除 tombstone；压缩后条数正确；老格式迁移。
- 工具：6 个工具的成功/失败路径；未知工具名 → `isError`；`at` 已过去 → 拒绝；`cwd` 不存在 → 拒绝；
  同名去重；上限 50；返回 `text` 复述 nextRunAt。
- 语义：`runNow` 不推移 `nextRunAt`（钉子用例）。

### 11.2 UI 测试（`plugins/scheduler/ui/app.test.mjs`，jsdom，参照 `background-tasks/ui/app.test.mjs`）

- 三组分组与排序；执行中卡片文案；时间线按日分组。
- 展开/折叠不重绘整页；复制按钮。
- 轮询签名：数据未变不重绘（监听 `replaceChildren` 次数）。
- 空态模板点击进编辑页并预填。

### 11.3 手动验收清单

1. 新建「每天」任务 → 卡片显示下次时间；改系统时间到点前 10 秒 → 到点自动跑，卡片变执行中。
2. 点「立即运行」→ 立刻出现「排队中」，随后变「执行中」，完成后变「成功」，耗时合理。
3. 断网/给一个注定失败的 prompt → 记录红色、错误块可见、复制可用。
4. 执行中关掉应用 → 重开后该记录显示「已中断」。
5. 让 agent「每天 8 点提醒我倒垃圾」→ 应用入口出现任务，带「由助理创建」标签。
6. 让 agent「把那个任务改成 9 点」→ 时间更新，下次执行重算。
7. 深浅色主题各看一遍：状态色、边框、展开区背景不发灰。

## 12. 开放问题

1. **结果落到哪**：已定——不投原会话，投宿主信箱（§8.2）。剩下一个小口子：`ctx.ui.inbox` 是
   通用能力，做成之后 `background-tasks` 的「任务完成回报」也可以把它当第二渠道（现在只投会话）。
   要不要顺手改，等信箱先用一轮再说。
2. **是否要「全部暂停」总开关**：一条设置项能立刻让所有任务停止触发（不改任务的 `enabled`）。
   有用但容易与单任务开关混淆，且需要 UI 上的显著位置。
3. **运行记录保留策略**：现在是「每任务 30 条」。按天（如 30 天）对低频任务更友好，但实现要每次
   比时间、压缩逻辑更绕。建议先按条数，观察实际用量再改。
4. **`runAgentPrompt` 缺插件工具**（§7.5）：补这个要动宿主（`plugin-host.ts:80` 传 extensions），
   属于宿主能力项，不在本插件范围。要不要单开一条？
5. **要不要 `panels[]` 右栏**：可以从「运行记录」里点一条，在右栏看详情，不打断应用入口的列表。
   但右栏 288px 放长文本很难受，且要维护第二份渲染分支。建议不做。
6. **任务超时默认值**：15 分钟对「读几个文件写个简报」够，对「跑构建」不够。要不要按 kind 给
   不同默认（interval 短、once 长）？倾向统一 15 分钟 + 工具参数可覆盖。

## 13. 实现记录（2026-11-06，v0.2.0）

### 13.1 落地在哪里

| 文件 | 职责 |
| --- | --- |
| `main.mjs` | 薄入口：激活流程、`tool.execute` 与 methods 分发、tick 定时器 |
| `lib/runtime.mjs` | 共享可变状态（rt）、上限常量、激活代数 `gen` |
| `lib/schedule.mjs` | 5 种调度的纯函数（从 v0.1 `main.mjs` 原样搬出） |
| `lib/task-input.mjs` | `normalizeTaskInput()`：UI 与 6 个工具共用的唯一校验 |
| `lib/store.mjs` | `data.json`（任务）+ `runs.jsonl`（折叠/墓碑/压缩/坏行容忍/迁移） |
| `lib/runs.mjs` | 运行状态机：queued/running/ok/failed/interrupted/skipped、未读、裁剪 |
| `lib/notify.mjs` | 条件通知：基线注入、结果文件 + 输出协议双通道、策略判定 |
| `lib/engine.mjs` | tick / 补跑 / 入队 / 串行 drain / execute 收尾 |
| `lib/methods.mjs` | UI 接口：snapshot / listRuns / getRun / saveTask / runNow / markSeen… |
| `lib/tools.mjs` | 6 个 agent 工具与文案 |
| `ui/app.js` + `style.css` | 主从布局、三组左列、按日时间线、空态模板、自适应轮询 |

### 13.2 与设计不一致的地方（实施结论）

1. **信箱推迟到 v0.3**：本节实现的是「条件通知 + 应用入口未读」，`ctx.ui.inbox` 未动（按 §8.2
   的分步计划）。记录里 `notify` 字段只有 `'sent' | 'none'`，原设想的 `inboxState` 没落地。
2. **未读字段**：设计的数据模型没写，实现里每条 run 加 `seen: boolean`；`snapshot` 额外下发
   `unreadByTask`，打开任务详情 / 运行记录页调 `markSeen`。迁移来的老记录一律视为已读。
3. **手动运行不发任何通知**：`trigger === 'manual'` 时既不弹开始也不弹结束（设计 §5/§8.2 的
   表格语义），因此**通知投递的验收用例走 `once` 到点执行**（main.test.mjs 里那条 5s 的用例）。
4. **`listTasks` 保留为 `snapshot` 的别名**：热重载期间可能还挂着上一份 `ui/app.js`，直接删接口
   会白屏一次。
5. **左列不自动选中任务**：宽屏首次打开右列是「从左侧选择一个任务」的占位。自动选中会把未读
   静默清掉（打开应用 ≠ 看过结果）。
6. **`runs.jsonl` 的压缩**：内存记录数 + 墓碑数 > 800 或文件 > 8MB 时重写（tmp + rename）。
   200 条上限下多数时候只追加，不做「每次执行重写一遍」。
7. **信号文件目录**：`<dataDir>/signals/<runId>.json`，读完即删；启动时清扫 24h 前的残留。
8. **`gen`（激活代数）**：`runAgentPrompt` 可能跑十几分钟，期间插件被停用/热重载时，返回的
   结果直接丢弃——否则会把旧一代的状态写进新一代的数据目录。

### 13.3 验证

- `plugins/scheduler/main.test.mjs`：29 条（调度语义、状态机、JSONL 折叠与迁移、6 个工具、
  条件通知三条通道、基线注入、失败/重叠/队列满、手动不推移 nextRunAt）。
- `plugins/scheduler/ui/app.test.mjs`：8 条（分组与排序、执行中卡片、时间线按日分组、懒加载
  展开、空态模板、未读标记、筛选、保存错误可见）。
- `npm run test:scripts` 288 条全绿；`npm run typecheck` 全链通过。
- 未实测：真实宿主里的到点触发与系统通知（需要跑起 Electron 手工验收，见 §11.3）。

### 13.4 仍未做

- v0.3：`ctx.ui.inbox` 宿主能力 + scheduler 接入（§8.2 的 5 文件清单）。
- `panels[]` 右栏、运行结果导出 markdown、全局暂停开关（§12 第 2/5 条）。
- POSIX 下的长任务中止路径只有标准语义保证，本机（Windows）无法实测。

## 14. 首次实测缺陷修复（v0.2.0 内，2026-11-06）

依据桌面《定时任务工具首次测试报告 v11》：1×P1（显示层）+ 1×P2（重名）+ 2×P3（语义/计数）。
**未改版本号**（仍是 0.2.0，按「不发版」节奏）。全部改动在插件内，零宿主改动。

### 14.1 P1：`scheduleLabel` 渲染成 `undefined`

根因不是「字段名与 schema 不匹配」，而是**派生字段被当成任务自身字段**：

- `scheduleLabel` 只由 `methods.publicTask()` 计算（它是投影，不是存储字段）；
- `lib/tools.mjs` 有两处直接读了 `rt.state.tasks` 的原始元素
  （`taskLine()` 的列表行、`list({ id })` 的标题行）；
- 所以创建/更新回执正常（走 `saveTask()` 返回的投影）、UI 正常（`snapshot` 投影过），
  唯独这两个列表入口是 `undefined`。

修法：工具层一律先 `const view = publicTask(task)`，模板只读 view。
防复发：新增 `describe('工具回执的可读性')` 一组护栏——列表/详情必须能读出「每天 08:30」，
且六条工具路径的输出文本都断言不含 `undefined` / `NaN`。这类「模板串漏字段」类型系统拦不住
（`rt.state.tasks` 是 `any[]`），只有输出层断言抓得到。

### 14.2 P2：重名不再「只看名字+提示词」

原实现判重条件是 `name && prompt` 都相同，而工具描述写的是 "duplicate is rejected"，
所以「同名不同提示词/不同时间」会被放行，与用户预期相反。

新规则：**名称唯一**（trim + 忽略大小写），校验下沉到 `methods.saveTask()` ——
UI 与工具的唯一写入口，规则只有一份（此前 UI 允许重名任务，等于两个入口两套规则）。
报错形如：

> 未创建：已存在同名任务「每日简报」（task-…，每天 08:30）：请换个名字，或直接改那个任务。

`tools.create` 里原来的两段前置检查（判重、任务数上限）一并删除，改为 `try/catch` 把
`saveTask` 的异常转成 `{ text, isError: true }`，保持「工具不抛异常」的约定。

### 14.3 P3：一次性任务的手动执行语义写进两处

行为保持不变（手动=预览，不消费原定计划），但补上说明：

1. `sched_run_now` 的描述：manual run 不改变也不取消原定时间，`once` 任务的原始时刻仍会执行。
2. 回执动态追加一句（仅 `once` 且仍有 `nextRunAt` 时）：
   `原定 11/6 20:10 仍会照常执行（手动执行不影响计划）。`

### 14.4 计数文案与「看起来迟到」

- `runCount` 只在收尾时 +1（跳过的、进行中的都不计）→ 文案由「累计执行」改为
  **「累计完成 N 次」**，有在跑的记录时追加 `· 另有 N 条进行中`。UI 详情同步改。
- 删除确认框不再拿 `runCount` 当「运行记录条数」（会少报），改为「全部运行记录」。
- `describeNext()` 在距执行 < 2 分钟时把秒带上：`interval` 任务的 `nextRunAt` 是
  「创建时刻 + N 分钟」，只显示到分钟会让人以为调度迟到（报告里的 20:10:25 就是这个错觉）。

### 14.5 验证

- `plugins/scheduler/main.test.mjs` 36 条（30 → 36，新增 6 条：重名即拒、UI 路径同样拒 + 改自己不算重名、
  列表/详情无 undefined、六条路径输出扫描、累计完成与进行中、once 手动执行提示、秒级时间）；
- `plugins/scheduler/ui/app.test.mjs` 8 条；`npm run test:scripts` 288 条；
  `npm run typecheck` 全链通过；`plugin-manifest.installed.test.ts` 4 条通过。

## 15. v13 复测反馈（v0.4，2026-11-06）

复测报告两项遗留：①未通知标注不区分策略；②`failures` 的失败分支无法构造。

### 15.1 未通知标注改为策略感知

旧实现：UI 与 `sched_runs` 都用 `notify === 'none' && signal.changed === false` 推「无变化 · 未通知」。
只在 `on-change` 下成立，`never` / `failures`（成功）那两格完全没有标注，**「没有标注」被读成
「通知过了」**。

现在由引擎在收尾时算原因码，文案只在 `format.notifyLabel()` 一处：

| 场景 | `notify` | `notifyWhy` | 展示 |
| --- | --- | --- | --- |
| 已发送 | `sent` | `''` | 无标注（有标记 = 发过了） |
| 手动 `runNow` | `none` | `manual` | 不额外标注（触发方式已标「手动」） |
| 策略 `never` | `none` | `never` | 从不通知（策略） |
| `failures` 且成功 | `none` | `failures-ok` | 未失败（策略不提示） |
| `on-change` 且无变化 | `none` | `unchanged` | 无变化（策略不提示） |

老记录（本版之前落盘的 run）没有 `notifyWhy`：回落到「`notify==='none'` 且 `changed===false`」这一条推断，
不猜其它策略，避免给历史记录编造原因。

### 15.2 `SCHED:failed`：让「失败」可表达、可测

原来 `run.status` 只取决于 `runAgentPrompt` 的 `ok`，即**会话**是否跑完（异常/超时才算失败）。
于是 `failures` 策略在真实使用中也几乎不可能触发——脚本退出码非 0 时 agent 照样会回一段话，
会话是「成功」的。报告把它归为「无法构造」，其实是语义缺口，不只是测试问题。

选**显式协议**而不是自动判退出码：agent 探索时敲错一条命令是常态，自动判失败会大面积误报；
而「整体算不算失败」只有 agent 知道。

- 协议：`SCHED:failed: 一句话原因`（原因可省，省略时取输出首行）
- `SCHED:failed` 优先级高于 `changed` / `unchanged`（混写按更严重的算）
- 命中后：`status='failed'`、`error=原因`、**保留正文**（诊断线索）、不更新基线、
  `failures` / `on-change` / `always` 策略下照常通知（`never` 依旧静默）
- 协议行不留在正文里（与 changed/unchanged 同样是给插件的指令）

### 15.3 验证

- `plugins/scheduler/main.test.mjs` 41 条（37 → 41）：`SCHED:failed` 的失败态/原因/正文/基线不污染、
  无原因时回落首行、`never` 与 `failures` 成功的原因码与工具回执文案（含重启后仍保留，`normalizeRun`
  是白名单字段）、`failures` + `SCHED:failed` 的系统通知与信箱闭环；到点用例补三条 `notifyWhy` 断言
- `plugins/scheduler/ui/app.test.mjs` 9 条（8 → 9）：时间线直接显示插件算好的原因
