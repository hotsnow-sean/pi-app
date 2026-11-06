# 插件宿主 + background-tasks 代码审查（2026-11-06）

审查范围：`plugins/background-tasks/**`（main.mjs 1644 行 / ui/app.js 476 行 / plugin.json）、
`src/main/plugins/**`（1285 行）、`packages/shared/plugin-*.ts`、worker 侧插件工具链路
（`worker-plugin-tools.ts`、`worker-handlers-turn.ts` 的 customPrompt）、renderer 侧
（`composer-plugin-bar.tsx`、`plugin-panel-frame.tsx`、`plugin-composer-bar-sync.ts`、
`plugin-message-note.tsx`、`apply-app-event*.ts`）。

结论先说：**宿主的「加载 / 启停 / 安装 / 工具注入 / 消息投递」五条主干是干净的插件化设计，
没有为 background-tasks 写任何 if-else 分支**（全仓库只有一处注释提到 `bg_output`）。
但**契约层渗入了这个插件的领域词汇**——托盘的行状态词表、行动作枚举、消息 kind 的文案，
这三处是目前唯一实质性的分离性缺陷。剩余问题以代码缺陷与平台能力缺口为主。

---

## 一、问题清单（按严重度）

### P1-1 增量读取会静默丢字节（`readLog` + `decode`）

`main.mjs:245` 的 `decode()` 在多字节字符被 chunk 边界切断时，会退到最后一个换行截断文本；
但 `readLog`（`main.mjs:305-313`）随后把 `nextOffset` 设成 **`start + bytesRead`（整块读了多少）**，
而返回的文本已经比这短。

```js
out.chunk = decode(buf.subarray(0, bytesRead))   // 可能被截短
out.chunkBytes = bytesRead                       // 仍是整块长度
out.nextOffset = start + bytesRead               // 调用方从这里续读 → 中间那段永远读不到
```

后果：任何用 `nextOffset` 做增量读的调用方（UI 的 `pullOutput`、模型的循环读取）都会
在跨 chunk 的多字节字符处**永久跳掉一行**。触发概率低（需要同时满足「chunk 边界切在
多字节字符中间」+「前面有换行」），但一旦触发就是数据缺失且无声。

修法：`decode` 返回 `{ text, bytes }`，`chunkBytes`/`nextOffset` 一律按**实际消费的字节**算。

### P1-2 重启后 `lost` 任务永远不会自动回报，面板却显示「待回报」且没有重试入口

`recover()`（`main.mjs:1003-1014`）把失联任务标成 `lost` 并写 `task.report = 'pending'`，
**但没有调用 `scheduleReport()`**；probe 里的接管补偿（`main.mjs:1030`）只处理
`status === 'running'` 的任务，而它们在 recover 阶段就已被改成 `lost`，于是这条补偿路径永远走不到。

于是三处互相矛盾：

| 层 | 实际表现 |
|---|---|
| 状态机 | `report: 'pending'` 表示「待回报」 |
| 调度 | 没有任何路径会把它投出去 |
| 面板（`ui/app.js:193`） | 徽标写「待回报」，让人以为马上会来 |
| 面板重试按钮（`ui/app.js:227`） | 只在 `failed / skipped / suppressed` 时出现，`pending` 没有 |

用户能做的只有让模型调 `retryReport`，而面板上看不出这个选项存在。

建议（二选一，推荐后者）：
1. `recover()` 里对 lost 任务走 `scheduleReport()`（重启后会补一批回报，需接受这个噪声）；
2. 保持「不自动回报」，但把状态写成 `report: 'skipped'` + `reportNote: '宿主重启时丢失进程，需手动重报'`，
   并让面板对 `lost` 无条件给「重新回报」按钮——语义诚实，也给了出口。

### P1-3 设置变更监听每「停用→启用」一次泄漏一个

`plugin-host.ts:126-132` 每次 `buildContext()` 都注册一个全局监听：

```js
onChange: (cb) => onPluginSettingsChanged((changedId, values) => { if (changedId === pluginId) cb(values) })
```

返回的取消函数插件侧丢掉了（`main.mjs:1568` 直接 `ctx.settings?.onChange?.(...)`），
宿主 `deactivatePlugin()` 也没有登记/清理这条订阅。插件每热更一次（开发期很频繁），
就多一个闭包持有**上一个模块实例**——旧模块永不 GC，且旧回调还会继续被调用。

修法：`PluginInstance` 里存一份 `disposers: Array<() => void>`，`buildContext` 把
`settings.onChange` / `ui` / `sessions` 的订阅都塞进去，`deactivatePlugin` 统一回收。

### P2-1 面板入口的路径穿越校验用 `startsWith`

`plugin-host.ts:317-324`：

```js
const full = path.resolve(found.dir, entry)
const root = path.resolve(found.dir)
if (!full.startsWith(root)) return null
```

前缀比较挡不住**同前缀兄弟目录**：插件目录 `/plugins/bg`、`../bg-evil/x` 解析后是
`/plugins/bg-evil/x`，`startsWith('/plugins/bg')` 为真 → 越界读取成功。
另外 Windows 上大小写不同也会误判（`C:\Plugins` vs `c:\plugins`）。

修法：`const rel = path.relative(root, full); if (rel.startsWith('..') || path.isAbsolute(rel)) return null`。

### P2-2 `reportQueues` 用原始 `sessionFile` 作 key，与 `sameSession` 不一致

同一个插件内有两套会话身份判定：
- 托盘/面板：`sameSession()`（归一化 + basename 兜底，`main.mjs:133-150`、`ui/app.js:159-172`）
- 回报队列：`reportQueues.set(task.sessionFile, ...)`（`main.mjs:836`）——**原始字符串**

如果工具侧与推送侧拿到的是同一会话的不同写法（相对路径 vs 绝对路径，v0.6.1 的注释里
就承认过这种可能），两条回报会落到两个队列、发成两条消息，而面板显示只有一个会话。
建议队列 key 也走 `normSession`。

### P2-3 回报投递失败会把任务的真实错误覆盖掉

`deliver()`（`main.mjs:990-997`）：投递失败时写 `task.error = error.message`。
而 `task.error` 原本承载的是任务本身的失败原因（超时说明、spawn 错误），
面板 `error` 字段与 `bg_list` 都在读它——投递一次失败，用户就看不到任务为什么失败了。

建议拆成两个字段：`error`（任务事实）与 `reportError`（投递问题）。

### P2-4 `describeStart` 在记录被清掉的 120ms 窗口内返回假回执

`main.mjs:1105`：`const fresh = taskById(task.id)`，若这 120ms 里用户清空了任务，
`fresh` 是 `null`，代码不判空直接落到「还在跑」分支，用**已删除的 task 对象**拼一条
「已在后台启动（pid …）」回执——模型据此以为任务活着，实际上记录与日志都没了。概率极低，
但属于「回执撒谎」，与本项目一贯的红线冲突。加一个 `if (!fresh) return { text: '…已被清理' }` 即可。

### P2-5 面板错误横幅会粘住

`ui/app.js:353-359` 在 invoke 失败时 `lastError = msg; rebuild()`。
而错误横幅只在**列表为空**的分支渲染（`ui/app.js:247-251`），且恢复后
`tick()` 的签名比较会走 `updateMeta()`——它只改 count/policy/meta 三个字段，
不清横幅。于是「一次瞬时失败 + 空列表」之后，那条红框会一直挂着，
直到有任务出现触发一次 rebuild。

修法：成功路径里检测 `lastError` 非空则 `lastError = ''; lastSignature = null`。

### P2-6 `maxLogMb` 的设置文案与行为不符

`plugin.json:307`：「输出超过上限后会**停止写入**主日志，避免磁盘被刷爆。」
实际 `main.mjs:1046-1050`：超限直接 `stopTask(task, true, 'log-limit')`——**杀进程**。

这不是小差别：用户按文案理解会以为只是截断日志，实际工作被终止。改文案即可
（或真按文案实现，但「杀任务」是更安全的选择）。

### P2-7 `engines` 解析了但从不校验

`plugin-manifest.ts:154-158` 声明了 `engines['pi-desktop']`，注释写「宿主版本约束（semver range）」，
全仓库没有任何地方读它（`grep engines` 只命中 browser 模块）。声明了却从不生效的契约
比没有更糟——插件作者会以为写了就有人管。

### P2-8 `discoverPlugins()` 每次全盘扫描，且在热路径上

`findPlugin()` → `discoverPlugins()` → 对每个插件目录 `readFileSync + JSON.parse(plugin.json)`。
调用点包括：每轮 `prompt.send`（`ipc/handlers/prompt.ts:53`）、每次
`ctx.sessions.send`（`plugin-host.ts:194`）、每次设置读写、每次面板环境推送。

对 2~3 个插件是毫秒级，但这是**同步 FS IO 在对话主链路上**，且随插件数线性增长。
建议加一层目录缓存（安装/卸载/启停时失效），并把 `pluginToolDescriptors()` 的结果缓存到
「插件集合未变」为止——每轮 prompt 重发一遍全部工具 schema（含 parameters）本身也不便宜。

### P2-9 `deactivate()` 不 await

`plugin-host.ts:276`：`void instance.deactivate?.()`。类型签名是 `() => unknown`，
宿主永远等不到异步收尾。插件若在 deactivate 里做异步清理（落盘、停子进程），
紧接着的 re-activate 就会和它竞态——开发期「停用→启用」正是最常走的路径。
建议签名改 `() => unknown | Promise<unknown>` 并 `await`（`deactivatePlugin` 改成 async）。

### P3 级（顺手可修）

| # | 位置 | 问题 |
|---|---|---|
| 1 | `main.mjs:5`、`:19` | 注释漂移：仍说「把进程 detached 出去」「同会话 5 秒内合并」，两条都是早期设计，现已相反（刻意不 detached、窗口已删） |
| 2 | `plugin-message-note.tsx:7-12` | 又定义了一份 `PluginMessageOrigin`，与 `@shared/plugin-message` 重复；改一处漏一处只是时间问题 |
| 3 | `main.mjs:154-156` | `PLUGIN_ID = 'background-tasks'`、`PANEL_ID = 'plugin:background-tasks:tasks'` 硬编码，而宿主已经给了 `ctx.pluginId`；改了 manifest 里的 id/panel id 会静默失配（托盘点了打不开面板） |
| 4 | `main.mjs:133-150` vs `ui/app.js:157-172` | `normSession/sameSession` 同一份逻辑写两遍（同一插件内），注释也承认「与 main.mjs 同一套规则」 |
| 5 | `main.mjs:1510` | `clearTasks` 对每个 victim 各推一次托盘：同会话清 5 条 = 5 次全窗口广播 + 5 次面板重算 |
| 6 | `main.mjs:1020-1022` + `:1589` | `recover()` 与 `activate()` 都补推托盘，启动时每个会话被推两次（幂等但多余） |
| 7 | `worker-plugin-tools.ts:158` | 函数体首行和声明挤在同一行（`{  const callId`），格式化漏网 |
| 8 | `plugin-tools.ts:82` | `asDetails(raw)` 在同一个表达式里调两次；另外非对象 `details` 被静默丢弃，无日志 |
| 9 | `plugin-composer-bar.ts:58` | 托盘状态变了就向**所有窗口**广播；多窗口下每个窗口都重算一次（当前只有主窗口，暂无害） |
| 10 | `plugin-panel-frame.tsx:162` | `plugin-content-height` 硬夹到 400px，插件想更高会被静默截断，契约里没写这个上限 |

---

## 二、分离性评估：插件 vs 宿主

### 2.1 做得好的部分（有据可查）

| 能力 | 判定 | 依据 |
|---|---|---|
| 发现 / 启停 / 安装 / 卸载 | **完全解耦** | `plugin-manager.ts` 只认 `plugin.json`，无任何插件特判 |
| 工具注入 | **完全解耦** | `tools[]` → `PluginToolDescriptor` → worker inline extension，模型侧零感知 |
| 工具执行 | **完全解耦** | `invoke('tool.execute')` 通用入口，参数与返回值形状由约定而非宿主分支决定 |
| 会话投递 | **完全解耦** | `ctx.sessions.send` 只认 `sessionFile + content + origin`，不解释业务 |
| 消息来源标注 | **基本解耦** | `PluginMessageOrigin{pluginId,label,kind,detail}` 是通用的「谁说的」结构，任何插件都能用 |
| 右栏 / 中央视图 / 会话条 | **完全解耦** | manifest 声明贡献点，宿主只给位置与高度 |
| 工具卡 | **完全解耦** | 复用 adapter 的 `template(kv/list/tree/media)`，宿主不为插件写渲染代码 |

关键证据：`grep -rn "background-tasks|bg_start|bg_output..." src packages`（排除测试与注释）
**零命中**。这在这个项目的历史里是相当罕见的好成绩——说明主体设计确实是从「插件」而不是
「这个插件」出发的。

### 2.2 三个渗漏点（唯一实质性问题）

#### ① 托盘把「任务生命周期」写进了宿主契约

`packages/shared/plugin-composer-bar.ts:12-13`：

```ts
export type PluginComposerBarRowStatus = 'running' | 'exited' | 'failed' | 'stopped' | 'lost'
export type PluginComposerBarTone = 'running' | 'done' | 'error'
```

这五个词就是 background-tasks 的状态机（`stopped` 还是它的专属语义：用户停止/超时/日志超限）。
宿主 renderer 直接按它选图标与配色（`composer-plugin-bar.tsx:19-25`、`:52-68`），
`normalizePluginComposerBar` 对未知值静默回落成 `'running'`。

后果：**任何第二个想用托盘的插件，要么说后台任务的方言，要么被宿主显示成「运行中圆圈」。**
这不是理论风险——它会让下一个插件作者去看 bg 的代码来「对齐词表」，从那一刻起宿主契约就被
一个插件绑架了。

同样的问题在 `row.action?: 'stop'`（`plugin-composer-bar.ts:30`）与宿主侧
`notifyPlugin(pluginId, action: 'select' | 'stop', id)`（`composer-plugin-bar.tsx:44`）：
宿主枚举了它认识的**业务动作**，且 `'composerBarAction'` 这个方法名被写死在宿主里。

建议改成「呈现词表 + 插件自定义动作用 id」：

```ts
type RowState = 'active' | 'ok' | 'error' | 'idle'   // 只表达观感，不表达业务
interface Row { id; label; state: RowState; meta?; startedAt?;
                actions?: Array<{ id: string; icon: 'stop'; title?: string }> }
// 宿主回调：composerBarAction({ action: <插件自己的 action.id>, rowId })
```

`state` 由插件决定（`status === 'running' ? 'active' : status === 'exited' ? 'ok' : …`），
宿主不再认识 `lost`。改动集中在 `plugin-composer-bar.ts` 的 normalizer、
`composer-plugin-bar.tsx` 的图标映射、插件 `composerBarFor()` 三处，一天内可完成，
且能顺带解掉「新插件必须读 bg 代码」这个隐性成本。

#### ② 消息 kind 的文案写在宿主 i18n 里

`plugin-message-note.tsx:99`：`origin.kind === 'report' ? t('timeline:pluginMessage.kindReport') : origin.kind`。

`kind` 的注释说「宿主不解释，只用于样式与筛选」，但代码里给 `report` 配了中文文案。
这是「半解释」：其他 kind 会原样显示成英文标识符。

建议：`PluginMessageOrigin` 增加 `kindLabel?: string`，插件自带文案（本插件传「回报」），
宿主只做兜底。这样 `report` 不再是宿主词汇表里的成员。

#### ③ 渲染组件的注释与命名仍然指向单一插件

`plugin-message-note.tsx:85-88` 的文档注释：「插件投递的消息（**目前是后台任务回报**）…」。
组件本身是通用的（折叠 + 围栏切块 + 代码块），但它是为了一个插件的形态写的：
折叠阈值 6 行 / 400 字是按「一条回报 70 行」定的，摘要取「正文第一句」也是按
`【后台任务回报】bg-3「…」已完成` 这种首行格式优化的。

这不算缺陷（先有实现再抽象是合理的），但值得记一笔：**如果第二个插件投递长消息时
摘要行不像话，别急着改这个组件，先看 origin 里有没有 `detail` 可用来做摘要。**

### 2.3 契约的「可执行性」问题（比渗漏更值得投钱）

插件的 `main.mjs` 是**无类型的 ESM**，`ctx` 的形状只存在于
`doc/dev/plugin-host-api.md` 与 `buildContext()` 返回的对象字面量里（`plugin-host.ts:101-225`）。
宿主没有任何编译期或运行期的契约校验，于是历史上出现过这类事故：
「工具 schema 没写的参数等于不存在」「`sessions.send` 冷启动会话没有插件工具」。这两条
都不是疏忽，而是**没有类型/契约检查的必然结果**。

建议（按性价比排序）：

1. `buildContext` 返回显式类型 `PluginContext`（放 `packages/shared/plugin-context.ts`），
   宿主实现与文档同源；
2. `npm pack` 一个极小的 `pi-plugin-sdk`（或只发布 `.d.ts`），插件里 `/** @type {import('...')} */`
   就能在 JS 里白拿补全与错误提示；
3. manifest 的 zod schema 已是 single source of truth（好），可以顺手 `zod-to-json-schema`
   出一份 `plugin.schema.json` 给编辑器用。

→ 1、2 已落地（见 §五「2.3 的落地方式」），3 未做。

### 2.4 平台能力缺口（与具体插件无关，但会咬到下一个插件）

| 缺口 | 影响 |
|---|---|
| `engines` 不校验（P2-7） | 插件声明「需要 host ≥ x」没有任何意义 |
| 无权限模型 | 任何 renderer 代码可 `plugin.invoke` 任意插件任意方法（`ipc.ts:182`），插件工具还能带任意 `cwd` 起进程——本地单用户应用可接受，但「插件是第三方代码」这句在文档里已经出现了 |
| `deactivate` 不 await（P2-9） | 异步收尾必然竞态 |
| 订阅无登记（P1-3） | 热更次数 = 泄漏次数 |
| `discoverPlugins` 无缓存（P2-8） | 同步 FS 在对话主链路上 |
| iframe `postMessage(..., '*')` | sandbox 无 `allow-same-origin` 时 origin 是 `null`，用 `'*'` 是现实妥协；但应至少在消息里带上 `pluginId` 校验，防止「另一个 iframe 恰好拿到引用」这类跨插件串话 |
| 无插件级别的超时/熔断 | `invoke` 挂住 = iframe 的请求永远 pending；`sessions.send` 慢 = 回报队列阻塞（当前靠主动 `waitMs` 上限兜） |

---

## 三、插件侧工程问题

1. **单文件 1644 行，七种职责**：shell 解析（`buildSpawnSpec`/`findBash`）、日志 IO（`readLog`/`decode`）、
   状态持久化（`load`/`save`）、调度（`reportQueues`/`recover`/probe）、文案拼装（`buildReport`）、
   工具层（`tools`）、UI 方法层（`methods`）、生命周期（`activate`）。
   建议按职责拆成 `shell.mjs / log-io.mjs / store.mjs / report.mjs / tools.mjs`，
   入口只留 `activate` 与装配。拆完每个文件 150~300 行，`main.mjs` 才能继续加东西。

2. **模块级单例状态**：`ctx / state / settings / reportQueues / deletedIds / children / timeouts /
   focus / sessionPhases` 全是模块变量。测试必须「activate 一次、共用一个 dataDir」，
   跨用例状态靠 `beforeEach` 重建 dataDir 兜——这也是 `plugin-composer-bar.test.ts`
   当初「跨用例状态残留」踩过的坑。拆模块时顺手把可变状态收进一个 `Runtime` 对象，
   测试可以显式 new 一个，不必靠重建目录隔离。

3. **UI 侧零构建**：`ui/app.js` 用字符串拼 HTML + 手写 `esc()`。当前没问题（转义覆盖完整），
   但 `rowHtml` 里的 `data-id="${esc(task.id)}"` 这类拼接一旦漏一处就是 XSS 面
   （虽然内容都来自本插件）。可以考虑保持现状，但在 `ui/README` 里写死「所有插值必须过 esc」。

4. **测试形状**：34+3 条测试覆盖得不错，但有两类缺口——
   - **没有并发/竞态测试**：`reportHold`、`deletedIds`、`describeStart` 的 120ms 窗口全靠人肉推理
     （P2-4 这种漏洞本可以被一条「清空发生在启动回执期间」的用例抓住）；
   - **`ui/app.test.mjs` 只测了清空路径**，`tick` 的错误横幅、`pullOutput` 的增量合并都没有用例。

5. **`plugin.json` 与代码耦合**：`tools[].name` / `panels[].id` / `settings[].key` 在两侧各写一份，
   没有一致性校验。可以加一条契约测试（扫 `main.mjs` 里 `invoke` 的方法名与 manifest 的工具名对齐），
   类似已有的 `ipc-channel-sync.test.mjs`。

---

## 四、建议的推进顺序

| 批次 | 内容 | 理由 |
|---|---|---|
| 1 | P1-1（读丢字节）、P1-2（lost 的回报语义）、P1-3（监听泄漏） | 三条都是「静默错误」，用户看不见，正好和本项目 v8 的主题一致 |
| 2 | P2-1/2/3/4/5/6 | 低风险小改，一次提交可清掉 |
| 3 | 托盘词表通用化（2.2 ①）+ kind 文案外移（②） | 趁第二个插件还没动手，改契约成本最低 |
| 4 | `PluginContext` 类型化 + SDK `.d.ts`（2.3） | 投入最大、收益最持久；越晚做成本越高 |
| 5 | 插件 main 拆模块（三.1-2） | 纯重构，可与 4 并行 |
| 6 | `engines` 校验、`deactivate` await、目录缓存、订阅登记 | 平台能力补齐，一次做完 |

其中第 3 批与第 4 批是**唯一与「分离性」直接相关**的两件事；其余都是普通代码质量问题。
如果只做一件，做 2.2 ①——它是当前唯一「宿主为某个插件的业务语义背书名」的地方。

---

## 五、修复进度（2026-11-06 当日）

| 批次 | 内容 | 状态 |
|---|---|---|
| 1 | P1-1 / P1-2 / P1-3 + P2-1~P2-6 + P2-9 | ✅ `da024b9` |
| 2 | 2.2 ① 托盘词表通用化、② kind 文案外移、③ 注释与重复类型 | ✅ 插件 v0.7.0 |
| 3 | 2.3 `PluginContext` 类型化 + 插件侧 SDK 入口 | ✅ `49a3197` |
| 4 | 3.1 插件 main 拆模块 + 宿主目录级 cache bust | ✅ 本轮 |
| 5 | P2-7 engines 校验、P2-8 目录缓存、P3 小项收尾 | ✅ 本轮 |

批次 1 与批次 2 都补了测试，且都用「回滚到旧代码」验证过测试确实会失败。

### 2.3 的落地方式（与建议的差异）

建议原文是「`npm pack` 一个极小的 `pi-plugin-sdk`」。实际做成了**仓库内转出 + 逐文件 pragma**：

- 权威声明 `packages/shared/plugin-context.ts`，宿主 `buildContext()` 标注它；
- `plugins/plugin-sdk.d.ts` 只 `export * from` 那一份（不复制结构，避免漂移）；
- `plugins/tsconfig.json` 用 `allowJs + checkJs:false`，靠每个 `main.mjs` 首行的
  `// @ts-check` 逐文件开启——全项目开 `checkJs` 会把 node_modules 里的 JS 一起查，
  噪音 30 条起步；
- `npm run typecheck` 已把 `typecheck:plugins` 串进去。

没做成独立 npm 包，是因为当前只有仓库内三个内置插件：真要对外发布时，把
`plugin-sdk.d.ts` 抽成包即可，类型定义本身不用动。

顺手修掉的两处**真问题**（都是开了检查才暴露的）：

1. `readLog(task, {...})` 的四个参数被 TS 当成全必填，`tailOf` 只传三个 → 类型报错。
   根因是「省略 offset = 读尾部」这个语义从没写进签名。补 JSDoc 后才说清楚。
2. `plugins/scheduler/main.mjs` 里 `result.error` 在非 `strictNullChecks` 下取不到
   （联合判别在该模式下不生效）——改成 `'error' in result`，两种模式都成立。

**已知边界**：插件项目没开 `strictNullChecks`（无类型 JS 全开有 218 条存量错误）。
所以类型检查保证的是**形状**（成员名、枚举值、参数必填性），不保证 null 安全。
这条写进了 `plugin-host-api.md` §2，别指望它挡住 `undefined` 解引用。

**仍然待办**（按建议顺序）：

| 项 | 说明 |
|---|---|
| ~~3.1 插件 main 拆模块~~ | ✅ 已拆（薄入口 + 10 个 lib，见 background-tasks-design.md §26） |
| ~~P2-7 `engines` 校验~~ | ✅ 批次 5（`packages/shared/semver-range.ts` 精简 range 匹配 + readManifest 校验，不满足 = 不可激活并进设置页诊断） |
| ~~P2-8 `discoverPlugins` 目录缓存~~ | ✅ 批次 5（缓存键 = 各根目录 mtime，enabled 现算、启停抬代数；`pluginToolDescriptors()` 挂发现代数上缓存） |
| ~~P3 小项~~ | ✅ 批次 5：P3-1/2/6/8 已随批次 1/2/4 顺手修掉；本轮修 P3-3（`ctx.pluginId` 为准，硬编码只做测试兜底）、P3-4（两份实现物理上合不了——iframe 没 node 模块——改为导出 + ui/main 等价性守门测试）、P3-5（clearTasks 按会话聚合推送）、P3-7（格式）、P3-9（broadcastEvent 收敛到 ipc/registry）、P3-10（400px 上限提成 MAX_CONTENT_HEIGHT 并写进 plugin-host-api.md） |
