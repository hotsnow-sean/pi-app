# 定时任务的条件通知与跨运行记忆：调研

Status: **research**（2026-11-06）。只做分析，不改代码。
关联：`scheduler-design.md`（v0.2 设计）、`plugin-host-api.md` §2 / §5。

## 1. 问题拆解

「提示词里写『如发生变化则通知』」这句话背后其实是三个问题，不是两个：

| # | 问题 | 本质 |
| --- | --- | --- |
| 1 | 怎么做到「有条件」通知 | 需要一条 **agent → 插件** 的信号通道，插件才知道这次要不要弹通知 |
| 2 | 会话隔离、没有记忆，怎么判断「有变化」 | 判断变化必须有**基线**；没有记忆就没有基线，这一条无解，只能「把记忆放到会话外面」 |
| 3 | （隐含）无变化时留下什么 | 不留痕，用户无法区分「没变化」和「任务没跑」 |

第 2 条是硬约束，先说结论：**「无记忆也能判断变化」是不成立的**。变化 = 与基线比较，
基线必须存在于某处。可选的位置只有三个：插件存储、任务记忆文件、外部真实数据源（每次重读并
与上一份快照比）。用户现在把基线写死在 prompt 里（「基线：state=OPEN，comments=0」），
那也是一种记忆——只是这份记忆永远停在写下它的那一刻，不会自己更新。

## 2. 现场实证：WorkBuddy 是怎么做的

拿本机一个真实在跑的自动化任务做解剖：`监控上游 issue #138 回复状况`（每 6 小时）。

### 2.1 任务 prompt（用户手写）

```
检查 GitHub 上游 issue justhil/pi-app#138 是否有新动态。
步骤：
1. 用 curl 无认证调用 GitHub API … 基线（2026-11-06 17:56 CST 记录）：state=OPEN，comments=0，
   无 labels。任何超出基线的动态都算新变化。
2. 判断动态类型：
   - 维护者或他人新评论，且内容是提问/要求补充信息 → 必须通知用户；
   - issue 被关闭或关联了 PR → 也通知用户；
   - 仅打标签、仅机器人动态、无任何变化 → 静默结束，不产生任何用户可见的通知。
3. 需要通知时，输出醒目的中文通知…
```

注意两件事：**判定规则写在 prompt 里**（谁算「变化」），**基线也写在 prompt 里**（从哪里比）。

### 2.2 每次执行首条注入的 `<automation_system_reminder>`

原文（`~/.workbuddy/projects/.../59cee3c9-….jsonl` 第 2 条消息）：

```
1. Read …\.workbuddy\memory\automations\<id>\memory.md to review prior execution history and outcomes.
2. Execute the task as specified in the user query.
3. Put the full task output in the normal assistant response…
4. At the end of this run, call send_automation_result exactly once with a concise,
   self-contained result for the task Overview. Do not include process narration.
5. If the task produces any deliverable files or attachments … call present_files.
6. Write a brief high-level execution summary to …\memory.md for future reference.
   Do NOT put the full task output, full deliverable, or detailed body content into the memory file.
7. Do NOT use the AskUserQuestion tool; this automation runs unattended, assume a default and state it.
```

四件事值得抄：**先读记忆 → 执行 → 结果写回复 → 回写摘要记忆**；另外两条是「无人在场，别问问题」
和「产出文件要显式交付」。

### 2.3 两次执行的磁盘证据

`memory/automations/<id>/memory.md`（agent 自己写的，两次执行后）：

```md
# 自动化记忆：监控 justhil/pi-app#138

## 基线
- 2026-11-06 17:56 CST：state=OPEN，comments=0，无 labels，closed_at=null

## 执行记录
- 2026-11-06 18:44 CST：… state=open，comments=0，labels=[]，updated_at 仍等于 created_at。
  **无新动态**，按规则静默处理，未向用户发出通知。
- 2026-11-06 19:09 CST：再次查询。… **无新动态**，静默结束。

## 备注
- 判断规则：维护者/他人提问评论 → 必通知；issue 关闭或关联 PR → 必通知；
  仅打标签/机器人/无变化 → 静默。
- 只通知，不代回复；不动本地仓库。
```

对应会话里的工具序列（`59cee3c9`）：`Read(memory.md)` → `Bash(curl issue)` →
`Bash(curl comments)` → `Bash(mkdir 记忆目录)` → `Write(memory.md)` → `send_automation_result`。

### 2.4 关键结论：**WorkBuddy 没有「条件通知」这个机制**

查 `workbuddy.db`：

- `automation_runs` 里两次「无新动态」的执行**都建了记录**，`thread_title` 就是那句
  「暂无新动态…按规则静默处理」，`read_at` 为 `NULL`（未读）。
- `metadata_json`: `{"runKind":"scheduled","resultState":"delivered","resultEvidence":"assistant_output",…}`
  —— 系统只判「有没有产出结果」，不判「结果值不值得打扰」。
- `automations` 表里与通知有关的字段只有 `push_to_wechat` / `push_to_wecom_bot`
  （这条任务两个都是 0），没有 `notify_policy` 之类的东西。

所以「静默」是**两层叠加的假象**：

1. agent 按 prompt 里的自然语言规则，决定「这次不写通知正文，只写检查结论」；
2. 用户没开微信/企微推送，站内也只有一条未读的 run 记录，不会弹窗。

系统层面只有「渠道开关」，没有「条件」。**判定权完全在 agent 手里，判定依据是它读到的
memory.md。**

### 2.5 顺带发现的两个问题（我们不该照抄）

1. **基线有两份，会漂移**：prompt 里写死一份「17:56 state=OPEN, comments=0」，memory.md 里
   又有一份。三次执行后，prompt 里那份已经是历史文物，但模型仍会读到它，可能拿旧基线做判断。
2. **memory.md 只增不减**：没有裁剪规则，任务跑上一年就是上千行，每次执行都要全量读一遍。

## 3. 本仓库的能力边界（技术事实，附证据）

| 事实 | 证据 | 影响 |
| --- | --- | --- |
| `runAgentPrompt` 只返回**最后一条** assistant 消息的文本 | `plugin-host.ts:99` 调 `session.getLastAssistantText()`；实现见 `agent-session.js:3491`（倒序找第一条 assistant，拼接其 text 块） | 结构化信号只能靠「约定文本」，且**最后一次工具调用之后必须有总结文本**，否则拿到 `undefined` |
| 该函数只回 `{ ok, text }` / `{ ok, error }` | `plugin-context.ts:135` | 没有 usage、没有 stopReason、没有工具调用记录 |
| `session.prompt()` 返回 `Promise<void>` | `agent-session.d.ts:505` | 没有结构化输出（JSON mode）可用 |
| 默认工具是 `read / bash / edit / write`，可被用户 `defaultTools` 设置改掉 | `sdk.d.ts:44-52` 注释 + `settings-manager.d.ts:129` | agent **通常**能写文件；但不能假定一定有 write |
| SDK 层没有权限沙箱（无 `permissionMode` / `allowedTools`） | 在 `dist/core/*.d.ts` 中无匹配 | `write` 可以写 cwd 之外的绝对路径 → 插件私有目录可写 |
| `ctx.notify` 无条件、不可撤回，点击只 `app.focus()` | `plugin-host.ts:168` | 「条件」只能由插件在调用前判断 |
| 宿主没有 main→UI 推送（除托盘） | `plugin-host-api.md` §7 | UI 只能轮询；通知与应用入口是两条独立通道 |
| 调度在应用进程内（`setInterval`），应用关掉就停 | `main.mjs:393` | 「关机期间的通知」不存在；WorkBuddy 同样（`automation_runs` 里有 `ErrorAutomation-MissedWindow`） |

**最重要的一条**：inMemory 会话里**没有插件工具**（`plugin-host.ts:85` 未传 extensions /
customTools），所以 agent 调不到「通知插件」的工具——这是「信号通道」设计的硬约束，见 §4.2。

## 4. 三个问题的解法

### 4.1 判定：谁来判断「有变化」

| 判据 | 谁做 | 准确性 | 成本 | 适用面 |
| --- | --- | --- | --- | --- |
| 机械指纹（文件 mtime / git HEAD / HTTP body hash） | 插件 | 高（确定性） | 执行前一次 IO，几乎零 token | 只看「数据源变没变」，不懂语义 |
| agent 判断（对照基线读事实） | agent | 中（依赖 prompt 与基线质量） | 一次完整执行 | 通用，能理解「什么样的评论算需要我们回复」 |
| 文本 diff（本次输出 vs 上次输出） | 插件 | 低 | 零 | 只适合输出高度模板化的任务 |

结论：**能机械判定的绝不交给模型**。语义判定（「这条评论是不是在问我们要信息」）只有 agent 能做，
但它必须拿到基线。

### 4.2 信号通道：agent 怎么告诉插件「这次要不要通知」

| 路径 | 做法 | 可靠性 | 成本 | 失败模式 |
| --- | --- | --- | --- | --- |
| **A 输出协议** | prompt 末尾约定：最后一行输出 `SCHED:changed` / `SCHED:unchanged`，插件解析 `run.text` | 中 | 零改动 | 模型不遵守 / 标记被后面的工具调用冲掉（`getLastAssistantText` 只取最后一条） |
| **B 结果文件** | prompt 告知一个绝对路径，要求 agent 把 `{"changed":bool,"summary":"…"}` 写入 | 较高 | 零改动（靠 write/bash） | 模型偷懒不写；Windows 路径转义出错；write 被 `defaultTools` 关掉 |
| **C customTools 注入** | 宿主给 `runAgentPrompt` 加 `customTools`，插件注入 `sched_report` 工具 | 最高（工具调用是结构化的） | **需改宿主**（`plugin-host.ts:80` + `PluginAgentPromptSpec`） | 宿主 API 扩张，要走类型/文档/契约测试 |
| **D 文本 diff** | 插件自己比 | 低 | 零 | agent 措辞随机，天天误报「有变化」 |

推荐：**B 为主 + A 为辅，双通道任一命中即采信；C 列 P1**。理由：

- B 拿到的不仅有「要不要通知」，还有 `summary`（可直接做通知正文），且不受「最后一步是工具调用」
  这个坑影响；
- A 作为 B 失败时的免费兜底（解析最后 200 字符）；
- 两条都失败 → 按「有变化」通知（**fail-open to notify**：宁可多打扰一次，不可漏掉真变化）。

### 4.3 基线：记忆放在哪

| 方案 | 谁维护 | 内容 | 能回答什么 | 代价 |
| --- | --- | --- | --- | --- |
| **插件自动基线** | 插件 | 上次 `output` 的前 600 字 + 上次执行时间 + 上次指纹 | 「上次是这么说的，这次呢」 | 零维护；token 成本 ~600/次 |
| **任务记忆文件** | agent | `dataDir/memory/<taskId>.md`，可累积任意事实 | 「这个 issue 上次我看到第几条评论」「谁在等我回复」 | agent 可能忘记写；文件会膨胀（要裁剪） |
| **外部快照** | 插件 | 上次 API 响应 / 文件指纹的 hash | 「数据源变没变」（不涉及语义） | 只适用于可机械获取的对象 |

推荐组合，按任务复杂度递进：

1. **默认（所有任务）**：插件自动基线。执行前把上次结论摘要拼进 prompt，执行后覆盖保存。
   用户什么都不用做，就能问「跟上一次比有什么变化」。
2. **任务开 `memory: true`**：插件建 `dataDir/memory/<taskId>.md`，prompt 里给路径，
   要求「先读、后写摘要」（照搬 WorkBuddy 的第 1 步 / 第 6 步）。适合需要记住多条事实的任务。
3. **任务配 `watch`（P1）**：执行前算指纹，没变就**根本不跑 agent**，只记一条 `skipped/unchanged`。
   这是最省钱的形态，但只适用于数据源可机械读取的任务。

## 5. 设计草案（可直接接进 v0.2 实施）

### 5.1 prompt 组装：三段式

```
【任务】<用户 prompt>

【上次执行】2026-11-05 08:30 · 成功 · 用时 42s
【上次结论】<上次 output 前 600 字>
（首次执行时这两行替换为「这是第一次执行，没有历史基线」）

【本次约定】
1. 先重新获取事实，再与「上次结论」比较，不要依赖对话历史（本次是全新会话）。
2. 结束前，把判定写入这个文件（用 write 工具，路径必须一字不差）：
   C:\Users\<user>\AppData\Roaming\pi-desktop\plugin-data\scheduler\signals\<runId>.json
   内容：{"changed": true 或 false, "summary": "一句话说明变了什么或为什么没变"}
3. 最后一条消息必须是给你自己看的总结文本，**写完信号文件后不要再调用任何工具**，
   并在最后一行写：SCHED:changed 或 SCHED:unchanged
```

三条约定分别对应：基线注入（§4.3-1）、结果文件（§4.2-B）、输出协议兜底（§4.2-A）。
第 3 条最后半句「写完信号文件后不要再调用工具」是为了绕开 `getLastAssistantText` 的坑（§3 第一行）。

### 5.2 判定链（fail-open）

```
读信号文件 ──有 changed 字段──→ 用它
   │ 没有 / 解析失败
   ↓
解析 run.text 末尾 200 字符的 SCHED:(changed|unchanged)
   │ 命中
   ↓ 没命中
按 changed = true 处理，并在 run 记录上标 signalSource: 'fallback'
```

首次执行（无基线）→ `changed = true`，`signalSource: 'first-run'`。
执行失败（`ok: false`）→ 按 `notifyPolicy` 决定，默认**通知**（失败一定值得知道）。

### 5.3 任务级通知策略（`notifyPolicy`）

| 值 | 行为 | 适用 |
| --- | --- | --- |
| `always` | 每次都通知（现状） | 提醒类任务（「该喝水了」） |
| `on-change`（建议默认） | 只有 `changed` 才通知；无变化只写记录 | 监控类任务（issue、价格、构建） |
| `failures` | 只在失败时通知 | 巡检类任务（成功是常态） |
| `never` | 从不通知，只更新应用入口 | 纯记录类任务 |

`notifyPolicy` 是**任务级**字段（不是全局设置）：同一个插件里，提醒类任务要 `always`，
监控类任务要 `on-change`，一个全局开关管不了。

### 5.4 run 记录新增字段

```js
{
  changed: boolean | null,          // null = 没判定（失败/中断）
  signalSource: 'file' | 'text' | 'fallback' | 'first-run' | 'none',
  summary: string,                  // 信号文件里的 summary，直接做通知正文
  notify: 'sent' | 'suppressed' | 'skipped',   // suppressed = 判定无变化
  baselineUsed: boolean             // 这次是否注入了上次结论
}
```

### 5.5 UI 呈现

**「静默」必须可见**，否则用户会以为任务没跑。运行记录行加一个次级标记：

| 情况 | 行尾标记 | 颜色 |
| --- | --- | --- |
| 有变化 + 已通知 | 已通知 | 主色 |
| 无变化 | 无变化 · 未通知 | 次要灰 |
| 判定失败按通知处理 | 无法判定 · 已通知 | 次要灰 |
| 失败 | 失败 | 红 |

任务卡片上补一句「连续 3 次无变化」，让用户知道监控在正常工作（WorkBuddy 的未读点只有
「有没有结果」，我们的场景更该区分「结果是什么性质」）。

### 5.6 通知文案

```
[有变化]
标题：每日简报 · 有变化
正文：<summary，最多 120 字>

[无变化] 不弹通知
[失败]   标题：每日简报 · 执行失败
         正文：<error 前 120 字>
```

### 5.7 记忆文件的裁剪

`dataDir/memory/<taskId>.md` 超过 40 行 / 4KB 时，插件在下次执行前重写：保留
「## 基线」与「## 备注」两节 + 最近 10 条执行记录。**裁剪由插件做，不指望 agent 自律**——
WorkBuddy 的 memory.md 就是没有裁剪，长任务会一直长。

## 6. 风险与坑

| 风险 | 说明 | 对策 |
| --- | --- | --- |
| 最后一步是工具调用 → `text` 为空 | `getLastAssistantText` 只取最后一条 assistant；写信号文件后若不再总结，`text` 可能是 `undefined` | prompt 强制「写完不要再调工具」；信号文件为主通道，不依赖 text |
| 模型忽略约定 → 天天误报 | fail-open 的代价 | `signalSource: 'fallback'` 可统计；连续 N 次 fallback 在 UI 提示「这个任务的判定不可靠」 |
| 记忆文件无限增长 | 每次都全量读 | 插件裁剪（§5.7） |
| 基线注入撑大 prompt | 600 字/次 ≈ 600 token | 上限 600 字，超出截断并标注「（已截断）」 |
| 「变化」定义模糊 | agent 每次判定可能摇摆 | 创建任务时用 `sched_create` 的 description 引导写出「什么算变化」；UI 上把这个规则单独展示（区别于执行 prompt） |
| 首次执行无基线 | 一定判「有变化」 | 标 `signalSource: 'first-run'`，通知文案里写「首次执行」 |
| 应用没开就不跑 | 用户可能以为「云端在跑」 | 应用入口与任务卡明确「应用关闭期间不执行」（与 WorkBuddy 一致） |
| 通知通道单一 | 只有系统通知，点击不能深链 | 已知限制，写进文档；P1 可考虑 `sessions.send` 投递到会话 |
| 多任务同时无变化 | 不通知，但记录会刷屏 | 运行记录按任务分组 + 「无变化」折叠（同一任务连续无变化合并为一行：`连续 3 次无变化`） |

## 7. 建议的落地顺序

| 阶段 | 内容 | 依赖 |
| --- | --- | --- |
| **P0（并入 v0.2）** | `notifyPolicy`（always / on-change / failures / never）；插件自动基线注入；输出协议 `SCHED:` 解析 + fail-open；run 记录补 `changed / signalSource / notify`；UI 标「无变化·未通知」 | 无，全部在插件内 |
| **P1** | 结果信号文件（更稳的通道）；任务记忆文件 + 裁剪；机械指纹 `watch`（未变不跑） | 无 |
| **P2** | 宿主 `runAgentPrompt` 支持 `customTools`，插件注入 `sched_report` 工具（彻底摆脱文本协议） | 宿主改动（`plugin-host.ts:80`、`plugin-context.ts`、契约测试、文档） |

P0 完全不动宿主，且能覆盖用户当前这个 issue 监控任务的全部需求。

## 8. 待拍板

1. **默认 `notifyPolicy`**：建议 `on-change`。代价是「提醒类任务」创建时必须显式选 `always`，
   否则用户设了「每天 9 点提醒我喝水」却因为无变化被静默——所以 `sched_create` 需要按 prompt 语义
   给默认值（提醒类 → always，监控类 → on-change），并在返回文案里说明这次用的哪档。
2. **是否默认开启记忆文件**：建议**不默认**（token 与维护成本），只有任务需要累积多条事实时才开。
3. **机械指纹要不要进 v0.2**：建议不进。它是「省钱」优化，不是「能不能做到」的关键；且要设计一套
   `watch` 配置语法（文件/命令/HTTP），容易失控。
4. **通知会不会太多**：如果用户有 5 个监控任务，每个都 `on-change`，正常日子 0 条、异常日 5 条——
   这是对的。但如果 agent 判定不稳，fallback 会让它退化成「天天 5 条」。建议上线后观察
   `signalSource` 分布，fallback 比例高就说明 prompt 模板需要打磨。
