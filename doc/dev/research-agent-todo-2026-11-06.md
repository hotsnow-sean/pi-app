# Agent Todo 工具调研：适配器、业界设计、插件方案性价比

日期：2026-11-06 · 范围：只调研，不改代码

## 0. 结论先行

1. **`pi-deck-todo` 适配器本身零功能**，它只是一份 28 行的声明式解析映射，把 pi 扩展产出的 todo 投影到输入框上方。真正的功能在 **PiDeck 桌面端内置的 `pi-deck-todo.ts` 扩展**里——那个扩展不在 npm 上（`pi-deck-todo` 包名 404），用户装 pi-app 不会自动获得它。
2. **这份适配器已经过时**：它按 `{todos:[{id,text,done}]}`（v2）写的，而 PiDeck 在 2026-08-22 / 09-05 / 09-12 三次改版后是 v3（三态 status、`activePlan.todos` 路径、widget 走文本行协议）。实测对 v3 输出会渲染出「全部 pending + 带 `☑`/`◐` 前缀 + 多一行元数据」的伪列表。
3. **业界 todo 工具的功能已经收敛**：三态状态机、单一 in_progress、常驻输入框上方、按会话隔离。真正的分歧只有三个——注入策略、要不要 plan 生命周期、要不要证据/依赖。
4. **用插件系统自建 todo 可行但性价比一般**：功能能覆盖八成，但有三个结构性缺口（todo 条视觉降级、会话分支语义丢失、注册不了 `/todos` 命令）。相比之下，**补适配器覆盖生态（几十行 JSON）的性价比高一个数量级**。

---

## 1. pi-deck-todo：适配器与本体

### 1.1 适配器是什么

`src/extension-compat/builtin/pi-deck-todo.adapter.json`（28 行）：

```json
{ "match": { "names": ["pi-deck-todo"], "tools": ["todo"] },
  "widget": { "keys": ["pi-deck-todo"], "tools": ["todo"],
              "placement": "aboveComposer", "protocol": "todo-list-v1",
              "fields": { "items": "todos", "id": "id", "text": "text", "done": "done" } } }
```

它没有任何代码，只是告诉宿主三件事：**哪个扩展**（names/tools）、**哪个 widget key**（`pi-deck-todo`）、**数据长什么样**（fields 映射）。解析器在 `src/extension-compat/todo-widget.ts` 与 `packages/shared/todo-list.ts`，渲染在 `src/renderer/src/features/composer/composer-adapter-widget-host.tsx`。

引入于 `673b51e`（2026-08-13，"add completion alerts, todo widgets, and skill management"）。

### 1.2 本体在哪

npm 上 `pi-deck-todo` **404**（`doc/guide/adapters.zh-CN.md:26` 那个 npmjs 链接是死的）。真身是：

- 仓库 `ayuayue/PiDeck` 的 `resources/extensions/pi-deck-todo.ts`（394 行）+ `pi-deck-todo-state.ts`（553 行）
- 由 `src/main/extensions/builtInExtensions.ts` 列为**内置扩展**，随 PiDeck 桌面端分发

同名易混淆的是 `@jetcrab/pi-desk-todo`（desk，不是 deck）：2026-10-26 首发、最新 1.0.14、周下载 678，是另一套东西（有 npm 包，无适配器）。

**结论**：pi-app 用户要触发这份适配器，必须自己把 PiDeck 的扩展文件放进 `~/.pi/agent/extensions` 或项目 `.pi/extensions`。默认安装下它是**死配置**。

### 1.3 v3 的功能设计（值得抄的部分）

| 设计 | 做法 | 为什么值得抄 |
|---|---|---|
| **plan 有生命周期** | `replace` 原子换整份计划、`restore` 撤销上一次替换、`clear` 显式清空 | 单条 add/update 无法表达「范围变了」；把 replace 与 restore 配对，等于给计划一个可撤销的边界 |
| **零缓存失效** | 不在每轮注入提醒，模型可见的计划由**最近一次变更的 toolResult** 携带；只在压缩/分支摘要后补一条简报 | 提醒注入会让前缀缓存每次失效（注释里记录了实测：36,480 → 17,024 的回落）。toolResult 是 append-only 历史，天然不打断缓存 |
| **补注幂等** | `todoBriefNeededAfterCompaction` 比较「最后一次压缩」与「最后一次计划可见点」的下标 | 每条 `before_agent_start` 都能安全调用，压缩后自愈、不重复追加 |
| **分支即作用域** | 状态以 v3 快照写 `pi.appendEntry('pi-deck-todo', …)`，`session_start` / `session_tree` 重建 | fork、回退、切换分支都天然跟着走，不需要额外映射 |
| **让位机制** | `isOwnTodo()` 精确比对工具来源路径；第三方 `todo` 工具接管后立即停发 widget 并清状态 | 工具名是公共资源，装两个 todo 扩展不打架 |
| **全量校验、不迁移** | 只接受 `version===3` 且全量合法的快照，坏一份就当没有计划 | 避免「静默截断一半」这种最难查的状态 |

工具面：`action: list | add | update | delete | replace | restore | clear`，状态三态 `pending/in_progress/completed`，`id` 为自增正整数，单条文本上限 1000 字，计划上限 100 项，模型可见输出截到 30 项。

### 1.4 适配器与 v3 已经脱节（实测）

用真实 adapter + 真实数据跑探针（跑完已删）：

| 输入 | 结果 |
|---|---|
| v3 widget 行 `['[[pid:todo-plan:leaf-1:3]]', '☑ #1 读需求文档', '◐ #2 改 reducer', '☐ #3 补测试']` | **4 项全部 `pending`**，元数据行被当成待办，`☑`/`◐` 前缀未剥离 |
| v2 工具载荷 `{todos:[{id:1,text:'…',done:true}]}` | 正确（`completed`） |
| v3 快照 `{version:3, activePlan:{todos:[…]}}` | `null`（路径应为 `activePlan.todos`） |
| v3 工具结果 `[{type:'text',text:'…'}]` | `null` |

三处不匹配：①`fields.items` 应为 `activePlan.todos`；②`fields.done` 已被 v3 废弃，应改 `status`；③适配器没有 `textLines` 配置，而 v3 的 widget 是**文本行协议**（`☑/◐/☐ #id text`，首行是元数据），需要 `textLines.skip` 跳过元数据行 + `status` 标记映射。

对照 `magic-context-todo.adapter.json` 就有完整的 `textLines`（`○◐✓✗` → 四态）——同一套解析器，配置齐全与不齐全差别很大。

**修好只需改一个 JSON 约 10 行**（fields 两条 + textLines 一段），不需要碰代码。

### 1.5 覆盖面的真实缺口

内置的 todo 类适配器只有两份：`pi-deck-todo`（过时）和 `magic-context-todo`（`todowrite`，跨会话记忆插件附带）。而 pi 生态当前最活跃的三个 todo 扩展**都没有适配器**：

| 包 | 版本 | 特征 |
|---|---|---|
| `@juicesharp/rpiv-todo` | 2.15.0 | `todo` 工具 + `/todos` + blockedBy + 分支回放 + 9 语言 |
| `@nredd/pi-todo` | 2.13.11 | 上面那套的 fork：completed 需证据、deferred 需理由、plan-mode 播种 |
| `@leo-alvarenga/pi-todo-list` | 0.5.0 | add/update/remove/list/clear + blockedBy + 批量 |

也就是说：**pi-app 现在的 todo 展示能力整体处于半失效状态**——唯一能用的那份指向一个用户装不到的包，生态里真在用的几个都不认识。

---

## 2. 业界 agent todo 的功能设计

### 2.1 横向对照

| 产品 | 工具形态 | 状态模型 | 注入策略 | 持久化 | UI |
|---|---|---|---|---|---|
| **Claude Code（旧）** | `TodoWrite`，每次全量覆盖 | pending / in_progress / completed | 早期有 nag 提醒（3 轮） | 会话消息 | 面板 |
| **Claude Code（≥2.1.268）** | `TaskCreate` / `TaskGet` / `TaskUpdate` / `TaskList` | + `deleted`；字段含 `subject` / `activeForm` / `owner` / `blockedBy` / `metadata` | 结构化工具调用，模型自行决策 | 会话 | 结构化渲染 |
| **Gemini CLI** | `write_todos`，全量替换 | pending / in_progress / completed / cancelled / blocked | 状态回写 | session 级 | 输入框上方，`Ctrl+T` 展开 |
| **Cline** | Focus Chain（自动生成） | 完成 / 进行 / 待办 | **每 6 条消息**注入一次「你在做什么/完成了什么/下一步」 | 上下文 | 侧栏 |
| **Cursor** | Plan mode：`create_plan`（带 steps + todos）+ `todo_write`（支持 `merge`） | pending / in_progress / completed | 状态回写 + 计划先审后执行 | 计划可存成仓库 Markdown | 输入框 + 聊天流 |
| **Manus** | `todo.md` | 勾选 | **每步重写并置于上下文末尾**（利用近因偏好） | 文件系统 | 无（模型自用） |
| **PiDeck v3** | `todo`（7 个 action） | 三态 + plan 生命周期 | **零注入**，靠 toolResult 携带 + 压缩后补简 | 会话分支快照 | composer 上方 widget |
| **rpiv-todo / pi-todo** | `todo`（增删改查） | 三态 + blockedBy（+ deleted） | 每次变更快照 | 会话分支回放 | 编辑器上方面板 |

### 2.2 五条共性

1. **三态起步**：`pending / in_progress / completed` 是事实标准，第四态才轮到 `cancelled`（Gemini、pi 适配器）或 `blocked`（Gemini、pi 生态的 blockedBy）。
2. **至多一个 in_progress**：Gemini 文档明写「Only one task can be marked in_progress at any time」；Claude Code 早期也是这个约束。并行诉求改由 `blockedBy` / 多 agent 表达，而不是放宽状态。
3. **常驻输入框上方 + 可折叠**：进度计数（`2/7`）+ 当前项文案是普遍配置，折叠键几乎人手一个（`Ctrl+T`、`ctrl+shift+t`、`Alt+T`）。
4. **按会话隔离**：都是 session 级状态，都能扛 `/reload` 与 compaction。跨会话共享的只有 Manus 那种文件方案。
5. **工具是给模型看的，不是给人编辑的**：没有一家把「用户在面板上手动勾选」当主路径——UI 是投影，写入永远来自模型。

### 2.3 三处分歧（也是设计上真正要选的地方）

**① 注入策略：每轮提醒 vs 零注入**

- Cline 每 6 条消息注入一次，Claude 早期 3 轮没调用就 nag。代价是提示前缀反复失效。
- PiDeck v3 把这条走到底：**完全不注入**，计划可见性由「最近一次变更的 toolResult」承担，只在压缩后补一条。注释里给了实测数据（中转站缓存从 36,480 掉到 17,024）。
- Manus 是另一个极端：每步重写文件到上下文末尾，用近因偏好强制模型看见。

三者不是对错，是「缓存成本 vs 漂移风险」的取舍。**pi 生态的语境里，零注入是更先进的答案**（因为 toolResult 天然在历史里，且 KV-cache 对长会话更重要）。

**② 要不要 plan 生命周期**

- 只有 PiDeck（`replace` / `restore`）和 Cursor（`create_plan` 先审后执行、`todo_write merge`）显式处理「计划整体换了」这件事。
- 大多数工具只有增删改，把「范围变了」交给模型自己逐条改——实践中会出现「旧项残留、新项叠加上去」。
- 这是 PiDeck v3 最值得抄的一点：**给计划一个身份（plan id）+ 一次原子替换 + 一次撤销**。

**③ 要不要证据 / 依赖**

- `@nredd/pi-todo` 要求 `completed` 必须带证据（命令 + 结果 / commit / 测试名），deferred 必须带理由；`@juicesharp/rpiv-todo` 与 `pi-todo-list` 支持 `blockedBy`，并拒绝悬空 id / 自阻塞 / 环。
- 这是「防止 agent 假完成」的方向，代价是每次完成都要多一轮输出。适合严谨场景，不适合日常。

---

## 3. 用插件系统做内置 todo 的性价比

### 3.1 能力映射：插件能覆盖什么

| 需要的能力 | 插件系统现状 | 结论 |
|---|---|---|
| 给 agent 一个工具 | `plugin.json` 的 `tools[]`（`parameters` 是 JSON Schema，支持 enum / 数组 / 嵌套） | ✅ 完整 |
| 拿到发起会话的上下文 | `tool.execute` 透传 `sessionFile` / `cwd` / `signal`（`plugin-context.ts:243`） | ✅ 够用 |
| 输入框上方常驻条 | `ctx.ui.setComposerBar(sessionFile, bar)`：summary + detail + ≤8 行 + `panelId` | ⚠️ 可表达，但见 3.2 ① |
| 完整视图 / 编辑 / 历史 | `views[]` + `panels[]`（iframe，走 `window.pi`） | ✅ 富 UI 都能做 |
| 持久化 | `ctx.storage`（`data.json`，原子写）+ `ctx.dataDir` | ✅ 但要自己按会话分键 |
| 声明式设置 | `manifest.settings[]` + `ctx.settings.onChange` | ✅ 现成 |
| 主动提醒用户 | `ctx.ui.inbox` / `ctx.notify` / `ctx.sessions.send` | ✅ 比扩展强（扩展没有信箱） |
| 热重载 / 可停用 | 停用即卸载，目录级 `?v=` 缓存穿透 | ✅ |

### 3.2 三个结构性缺口

**① todo 条会视觉降级。**
宿主的 todo 条是**为 adapter 量身定做**的（`composer-adapter-widget-host.tsx`）：进度环、`2/7` 计数、当前项文案、四态图标（`Circle` / 半填充圆 / `CheckCircle2` / `XCircle`）、优先级色点、`max-h-40vh` 滚动。插件的 `composerBar` 是通用托盘：8 行、`label` + `state` + `meta`、图标只有 `stop`。要做成同样的观感，只能在 summary 里拼字符串，或者在右栏 iframe 里重画一套（那就不常驻了）。

**② 会话分支语义丢失。**
扩展的状态活在会话文件里（`appendEntry` + `session_tree` 重建），fork / 回退 / 切分支全自动跟随。插件只有 `storage`，按 `sessionFile` 分键，**fork 出的新会话不会带走父会话的 todo，回退也不会还原**——因为 `ctx` 拿不到会话分支条目，插件根本读不到历史。这是两种模型最本质的差异，不是工程量问题。

**③ 注册不了 `/todos` 命令。**
`PluginManifest` 没有 `commands` 字段（对照 `packages/shared/plugin-manifest.ts`：只有 `views` / `panels` / `tools` / `settings`）。生态里几乎所有 todo 扩展都配一个 `/todos` 打印全量列表，插件做不到。

**④ 一个附带成本：工具名冲突。**
`todo` 是公共名字，PiDeck 的 `isOwnTodo()` 让位机制证明冲突是现实发生的。插件工具应带前缀（`todo_write` / `todo_list`），而这恰好是 Claude Code 与 Gemini 的命名，模型先验更好。

### 3.3 四个方案对比

| 方案 | 改动面 | 得到 | 失去 / 风险 |
|---|---|---|---|
| **A. 修现有适配器** | 1 个 JSON，约 10 行（fields 改 `activePlan.todos` + `status`，补 `textLines`） | PiDeck 用户看到正确的三态与进度 | 仍依赖用户自己装扩展；覆盖率只有 1 个生态扩展 |
| **B. 给生态补适配器** | 每份约 20～40 行 JSON（rpiv-todo / pi-todo / pi-todo-list） | 生态里真在用的三个扩展都能显示；零代码 | 需要跟上游工具 schema 演进；仍是「装扩展才有」 |
| **C. 插件自建 todo** | 新插件约 700～1000 行（工具 + reducer + 存储 + 托盘 + 右栏 UI + 测试） | 开箱即用、跨会话视角、信箱提醒、可停用 | 3.2 的三个缺口全占；与生态 todo 扩展抢工具名 |
| **D. 宿主加 todo 贡献点** | 宿主 200～300 行（给 `composerBar` 加 todo 变体，或让插件推 `TodoWidgetItem[]` 走既有渲染）+ 插件 | 插件供数据、宿主原生渲染，观感与现有 todo 条一致 | 宿主多一份向后兼容责任；分支语义仍然拿不到 |

### 3.4 建议（按性价比排序）

1. **先做 A（约 10 行 JSON）**。它把一份已经半坏的配置修好，成本几乎为零，且顺带验证 `textLines` 这条解析路径确实好用。
2. **再做 B（几十行 JSON）**。生态里三个活跃扩展都没有适配器，补齐之后 pi-app 的「todo 展示」这件事才算真的成立——而且全部是配置，不引入新的维护面。
3. **C 只在有明确产品诉求时才做**：比如「不装任何扩展也要有 todo」「要跨会话看所有项目的计划」「要接信箱提醒」。否则它是在用 1000 行代码重造一个已经被生态做了 5 遍的东西，还丢分支语义与 `/todos`。
4. **D 是 C 的补丁而非替代**：如果真要做 C，先把「插件能不能推 `TodoWidgetItem[]` 给现成渲染」这个能力补上，比在插件里重画一套托盘更省，也更统一。

**一句话**：这份适配器的价值在于「让宿主认识生态里的 todo」，不在于「宿主自己有一个 todo」。真要自建，插件系统能做，但它的独特价值在跨会话视角与信箱，不在 todo 本体。

---

## 4. 证据索引

- 适配器：`src/extension-compat/builtin/pi-deck-todo.adapter.json`（引入于 `673b51e`，2026-08-13）
- 解析：`src/extension-compat/todo-widget.ts`、`packages/shared/todo-list.ts`（`STATUS_ALIASES` 已兼容 `complete/done/skipped/canceled/in-progress/active`）
- 投影：`src/worker/desktop-widget-host.ts`（`setWidget` 数组分支走 `todoItemsFromTextLines`，对象分支走 `captureFromPayload`）
- 渲染：`src/renderer/src/features/composer/composer-adapter-widget-host.tsx`
- 插件能力：`packages/shared/plugin-context.ts`、`packages/shared/plugin-composer-bar.ts`（`MAX_ROWS = 8`）、`packages/shared/plugin-manifest.ts`（无 `commands`）
- PiDeck 本体：`ayuayue/PiDeck` → `resources/extensions/pi-deck-todo.ts` + `pi-deck-todo-state.ts`（提交：07-03 新增、08-22 plan 生命周期、09-05 三态、09-12 零失效）
- 对照配置：`src/extension-compat/builtin/magic-context-todo.adapter.json`（完整 `textLines`）
