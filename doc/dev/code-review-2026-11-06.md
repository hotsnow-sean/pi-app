# 插件系统代码审查（2026-11-06，第二轮）

范围：`src/main/plugins/*`、`packages/shared/plugin-*`、`plugins/{ask,background-tasks,scheduler}`，
以及宿主 ↔ 插件的契约面（ctx / 工具目录 / 托盘 / iframe 桥 / 提示词）。
方法：先 rebase 到最新上游拿到干净基线，再逐文件通读 + 机械核对（字面量、重复实现、
schema ↔ 实现比对），最后跑全量回归。

四条审查线（用户给定）：
1. 代码逻辑问题 2. 代码整洁程度 3. 内置插件工具提示词 4. 系统 / 宿主 / 插件的耦合性

---

## 0. 基线：rebase 结果

| 项 | 结果 |
| --- | --- |
| upstream/main | `5753545` → `999b199`（24 个提交） |
| 本地 | `feat/plugins-core` 67 个提交 rebase 到新上游，无遗留冲突 |
| 冲突 | 3 处：`apply-app-event.ts`（plugin_widget 分支）、`apply-app-event-message.ts`（isAbortUiHoldActive × pluginOrigin）、`completion-notification-inbox.test.ts`（以上游版为基 + 追加本地 describe） |
| 备份 | `backup/pre-rebase-2219` |

回归（修复后）：

| 套件 | 结果 |
| --- | --- |
| `npm run typecheck`（web / node / plugins 全链） | 通过 |
| `src/renderer` | 1151 通过 / 4 skip |
| `src/main` + `packages` + `plugins` | 1054 通过 / 7 失败（全是 `symlink` EPERM，沙箱固有，与本次改动无关） |
| `npm run test:scripts` | 288 通过 |
| `electron-vite build` | 通过 |

提交：`c18738d`（宿主）、`d7f5e96`（background-tasks）、`57c5017`（scheduler+ask）。

---

## 1. 已修：逻辑缺陷

### 1.1 宿主 `runAgentPrompt` 的超时被当成成功（P1）

`pi` SDK 的 `session.abort()` **不抛错**：`_runAgentPrompt` 只是把循环断掉然后正常
返回，`session.prompt()` 照样 resolve。于是「超时中止」这一路走回来是 `{ ok: true }`，
定时任务会把一次被掐死的执行记成成功、还会写进「有变化」的基线。

修法：把超时语义抽成 `src/main/plugins/plugin-agent-prompt.ts` 的纯函数
`runPromptWithTimeout(session, prompt, timeoutMs)`，自己记 `timedOut` 标志，
`timedOut` 时无论 `prompt()` 怎么返回都给出 `{ ok: false }`；再配 30s 的
`ABORT_GRACE_MS` 兜住「abort 之后连 resolve 都不来」的情况。

抽出来的另一个收益是**可测**：这段逻辑原来埋在 `plugin-host.ts` 里，要测就得拉起
真 `activatePlugin` + 真 SDK（jsdom 里 `new Function('import(url)')` 直接报
"dynamic import callback was not specified"，换 node 环境又被全局 setupFiles 的
`window` 炸掉）。现在是 4 条纯函数用例：abort 后正常返回也算超时 / 正常结束 /
抛错透传 / abort 后不返回由兜底计时器兜住。

### 1.2 插件数据文件的写与坏文件恢复（P1）

`storage.set()` 是**整份覆盖**，而 `readStorage` 在读不出来时 fail-open 返回 `{}`。
两件事凑在一起就是数据丢失：写盘写到一半（断电、崩溃、磁盘满）→ 下次读失败 →
宿主当作空表 → 插件下一次 `set()` 把用户的任务表永久抹掉，连「原本长什么样」都
查不到。

修法两半：
- 写：`data.json.tmp` → `renameSync` 原子替换（`plugin-host.ts` 的 `writeStorage`，
  `plugin-settings.ts` 的 `writeRaw` 同样处理）。
- 读失败：先把坏文件改名成 `data.json.corrupt-<ts>` 留证，再返回 `{}`；并
  `console.warn` 出插件 id，让「谁的数据坏了」在日志里可查。

### 1.3 `bg_clear` 的「跳过的运行中任务」不计数（P2）

`clearTasks` 的过滤是「先判 keepRunning 再判选中」，跳过分支的条件写的是
`wanted.includes('running')`。不传 `status` 时 `wanted` 是空数组，运行中的任务
明明被跳过了却不进 `skippedRunning`，回执于是说「没有已结束的任务可清理」——
而实际是两个任务正在跑。这是排障陷阱：用户会以为任务表空了。

修法：先算「本来会被选中」，再看 `keepRunning` 决定跳不跳，命中就计数。补一条
钉子用例（只有运行中任务 + 不传 status → `skippedRunning: 1`，文案不得出现
「没有已结束的任务可清理」）。

### 1.4 `shell` 参数在两个平台上都能静默变形（P1，假成功）

三处：
- `shell:'cmd'` / `'powershell'` 在 POSIX 上被 **静默忽略**，实际跑的是 `/bin/sh`。
  调用方拿 sh 的结果当成 cmd 的结果。
- 入参白名单不存在：schema 里只有 4 个值，但 `buildSpawnSpec` 对任意字符串都默默
  回落（Windows 落 bash、POSIX 落 sh）。模型传 `pwsh`（实现里恰好有这个没声明的
  别名）或 `zsh` 都不会报错。
- 那个未声明的 `pwsh` 别名本身就是「schema 与实现不一致」的证据。

修法：`shell.mjs` 收一份 `SHELLS = ['auto','bash','cmd','powershell']` 白名单，
不认识就抛错并列出可选值；POSIX 分支收到 `cmd`/`powershell` 直接抛
「只有 Windows 支持」。删掉 `pwsh` 别名。补两条用例（含 POSIX 分支的平台判断）。

理由与 `assertCmdCompatible` 同源：**宁可报错，不让调用方拿着错的结果继续跑**。

### 1.5 `sched_update` 把空 `at` 静默改成「五分钟后」（P2）

`normalizeTaskInput` 对 once 缺 `at` 会回落到 `now + 5min`——那是给 `sched_create`
的便利默认（「提醒我一下」不必自己算时刻）。同一条回落作用在**编辑**上就是
「悄悄把一次性任务挪到五分钟后」，而回执只说「已更新」，用户看不到时间变了。

链路：`pickPatch` 认为 `at: ''` 是「传了」→ 合并进 `merged.schedule.at` →
`normalizeTaskInput` 里 `''` 是 falsy，当成「没给」→ 走默认。

修法：`sched_update` 收到空字符串 `at` 直接 `isError`，并说明「一次性任务必须有
具体时刻，要换重复方式请传 `kind`」。用例断言：拒绝 + `nextRunAt` 与改前一致
（只断言拒绝是不够的，得证明计划没被动过）。

### 1.6 `ask` 的等待上限超过宿主的工具硬超时（P2）

`timeoutSec` 允许设到 7200s，但宿主对单次插件工具调用有 20 分钟硬超时
（`src/worker/worker-plugin-tools.ts` 的 `CALL_TIMEOUT_MS`）。设 2 小时的
结果是：问卷还挂在屏幕上，工具早就被宿主掐掉了，用户答完也没人接。

修法：等待上限按 `MAX_WAIT_MS = 18min` 截断（留 2 分钟给收尾），设置项描述写明
宿主的 20 分钟上限，`max` 从 7200 收到 1080。

### 1.7 小项

| 位置 | 问题 | 修法 |
| --- | --- | --- |
| `scheduler/lib/format.mjs` | `skipText` 没有 `offline`，跳过原因是空白 | 补「插件未激活」 |
| `plugin-host.ts` `activatePlugin` | 手拼 `file://` + 分隔符替换 | 用 `pathToFileURL().href`（插件目录来自 userData，路径含 `#`/`?` 时手拼的串会被解析成 fragment/query） |
| `plugin-host.ts` `activateEnabledPlugins` | 为了拿 `discoverPlugins` 走了一次 `await import('./plugin-manager')` | 改静态 import |
| `plugin-ui.ts` `cancelPluginUIRequests` | `hostWindow()` 在循环里反复取 | 提到循环外 |

---

## 2. 已修：整洁度

### 2.1 `pi-plugin://` 的定址规则曾有三份实现

`plugin-manifest.ts` 的 `pluginViewUrl`、`plugins/protocol.ts` 的解析、`plugin-panel-frame.tsx`
的模板字符串——前两份**零调用者**，且斜杠规则不同（一份 `replace(/^\/+/, '')`，
一份按 pathname 解析）。

修法：新增 `packages/shared/plugin-panel-url.ts`（`PLUGIN_UI_SCHEME` /
`DEFAULT_PLUGIN_UI_ENTRY` / `pluginEntryUrl()` / `pluginEntryPath()`），protocol 与
renderer 共用，删掉零调用者的 `pluginViewUrl`。7 条单测覆盖：默认入口、前导斜杠、
空 entry、`pluginEntryPath(pluginEntryUrl(x))` 互逆、空路径回落、百分号解码。

### 2.2 `manifest` 用 `null as unknown as` 蒙过编译器

`plugin-manager` 的扫描结果里，不可激活的插件 `manifest` 是 null，但类型声明成
非空，于是 4 处用 `null as unknown as PluginManifest` 转换。消费者被迫靠猜。

修法：改判别式联合

```ts
type ManifestRead = { dir: string; error?: string; errorKind?: 'manifest' | 'engines' } & (
  | { manifest: PluginManifest; blockedManifest?: undefined }
  | { manifest: null; blockedManifest?: PluginManifest }
)
```

缓存类型用独立的 `DiscoveredBase`（**不能用 `Omit<DiscoveredPlugin, 'enabled'>`**：
`Omit` 会把联合拍平，判别关系丢光）。`discoverPlugins` 的 map 也必须分两支返回
——`{...p, enabled: ...}` 的 spread 同样会让联合两侧属性求并集。

---

## 3. 已修：内置插件的工具提示词

判定标准四条，逐条过了一遍三个 manifest（ask 1 + background-tasks 6 + scheduler 6 = 13 个工具）：

1. **不写实现做不到的承诺**（`force` 在 Windows 上无效、`shell:'cmd'` 在 POSIX 上不存在）
2. **入参名与实现一致**（`nextOffset` vs `offset`）
3. **省略即默认的地方要说出来**（`waitMs` 隐式 1000ms）
4. **状态词不冒充业务、失败判定归属明确**（`failed` 是 agent 自报，不是退出码）

| 工具 | 问题 | 改法 |
| --- | --- | --- |
| `bg_output` | 顶层描述「pass **nextOffset** from a previous call」，真实入参是 `offset`（`nextOffset` 只是回执字段）。照着传会被静默丢弃并**重复返回日志尾部** | 改为「pass `offset` — the nextOffset a previous reply gave you」 |
| `bg_stop` × `force` | 描述写「Kill immediately instead of asking the process to exit first」，但 Windows 侧恒发 `kill -9 -<pgid>` + `taskkill /T /F`，这个参数在 Windows 上等于没有 | 如实写：`force` 只在 macOS/Linux 上决定 SIGKILL vs SIGTERM，Windows 一律硬杀 |
| `bg_stop` × `waitMs` | 不传时实际等 1000ms（`tools.mjs`），schema 没写 | 补「Default 1000 — pass 0 to return as soon as the signal is sent」 |
| `bg_start` × `shell` | 枚举里 `cmd`/`powershell` 没说是 Windows 专用 | 补「Both are Windows-only: asking for them on macOS/Linux is an error」 |
| `sched_update` × `at` | 没写空串会怎样（实际会落到「五分钟后」） | 补「An empty string is rejected too — a once task always needs a concrete time」 |
| `ask_user` | 没写这次调用**会阻塞整轮**、超时回来是「未回答」；也没写反向的克制（别问自己能查到的） | 补：阻塞语义 + 「别用它做显而易见下一步的礼貌确认」+「别问能从文件/git/文档查到的信息」，保留「该问就问，别猜需求」 |

`sched_create` / `sched_runs` 的描述在前两轮已经校准过（失败判定归属、未通知原因），
本轮复核无新问题。

---

## 4. 耦合性专项：结论是干净的

### 证据

`src/**` 与 `packages/shared/**` 的**非测试代码**里，`scheduler` / `sched_` /
`background-tasks` / `bg_*` 的字面量只剩 1 处——`plugin-host.ts:297` 的一句注释
（举例说明版本透传，可接受）。没有 `if (pluginId === 'xxx')` 这类特判。

四条通用机制各自成立：

| 机制 | 宿主知道什么 | 插件提供什么 |
| --- | --- | --- |
| `ctx` | 能力清单（storage / settings / notify / ui / sessions / runAgentPrompt / log），`buildContext(): PluginContext` 用多余属性检查守着 | 只调用 |
| 工具目录 | 名字 + schema + 归属 pluginId | manifest `tools[]` |
| 托盘 | **观感词**（active/ok/error/idle/warn）+ 行 id + 动作 id | 文案 + 自定义 action id |
| iframe 桥 | 通用 postMessage 协议（hello / invoke / content-height / open-panel / key） | 自己的 UI |

`plugin-composer-bar.ts` 的注释把这条边界写得很清楚：「词表只表达观感，不表达业务」，
`normalizePluginComposerBar` 还做了兜底校验（认不出的 state 按 `active` 画）。
`plugin_widget`、`plugin-data`、`plugin-open-session` 同理，都是机制不是业务。

### ~~唯一实质性的耦合债~~：iframe invoke 桥被复制了三份，且已经分叉（**已修，见 §7**）

| 插件 | 发 hello | invoke 超时 | 失败处理 |
| --- | --- | --- | --- |
| ask | 有 | **无**（宿主不回就永远 pending） | reject |
| background-tasks | **无** | **无** | reject |
| scheduler | 有 | 10s | reject + 提示「宿主没有响应」 |

三份 `applyTheme()` / `api()` 逐字相似却各改各的。这类「胶水」不该由每个插件重写：
它承载的是宿主协议，写错了（比如漏超时）不会有任何报错，只会表现为「按钮一直在转」。

**修法（§7 已实施）**：宿主在 `pi-plugin://` 上占用保留 hostname `__host` 下发
`bridge.js`，插件 HTML 一行 `<script src="pi-plugin://__host/bridge.js"></script>`
拿到 `window.pi`。协议 CSP 本来就是 `script-src pi-plugin:`，handler 只需在
hostname 上分叉；桥脚本用 Vite 的 `?raw` **构建期内联成字符串**，绕开 extraResources
与 asar 路径——`bundle-paths.ts` 那类坑一个都不用踩。

---

## 5. 记录「不改」的四项

### 5.1 `bg_stop` 在 Windows 上不做「先礼后兵」

`signalTree` 的注释写得很直白：Windows 上「停止后台任务」从来不是优雅关闭，
TERM 只会让忽略它的命令赖着不走，而 `waitForTerminal` 本来就会升级到强杀。
所以**改文档不改行为**——schema 之前承诺了一个做不到的语义，是文档的错。

### 5.2 退出码自动判定「失败」

不做。agent 探索时敲错命令是常态（`grep` 没匹配到就是 1），自动判失败会大面积
误报；「整体算不算失败」由执行 agent 按 prompt 里的成功标准自报（`SCHED:failed`）。
这一条在上一轮已经定过，本轮复核 tool 描述与此一致。

### 5.3 主侧 / UI 两份 `fmtDuration` / `fmtBytes`

差异是 `未知` ↔ `—`、`0B` ↔ `''`。受众不同（一份进模型回执、一份进 DOM），
而且 UI 是纯 ESM 脚本、`lib/` 是带 `node:fs` 的模块，共享需要额外机制。
**保留**，但记在这里：如果以后要统一，先统一到「文案归 main、UI 只消费 details」。

### 5.4 16 份 `const Q + imp()` 模板

`plugins/` 下 14 个 lib 模块 + 2 个入口逐字复制了同一段 6 行导言。看着像该抽，
但它承载的是一条**易碎的不变式**（插件内模块必须透传 `?v=`，否则热重载命中旧缓存）。
抽成 `lib/imp.mjs` 会多一层自举（`imp.mjs` 自己也得先被带版本地加载），
把「为什么必须透传」藏进实现细节里——而这条不变式的守门测试
（`plugin-typing.test.mjs`）恰好要能一眼看懂每个模块都做了这件事。
**保留，且同步在文档里保留解释**。

---

## 6. 剩余风险

1. **~~iframe 桥的分叉~~（§7 已修，待真机实测）**：三份客户端合一成宿主下发的
   `window.pi`，统一 10s 超时，面板卸载时宿主发 `plugin-dispose` 把挂起的调用
   reject 掉。**未验证的一点**：沙箱 iframe 从 `pi-plugin://__host/bridge.js` 取
   子资源这一段，构建产物里已经内联好了，但没在真机上跑过——CSP `script-src pi-plugin:`
   在语法上覆盖它，opaque origin 发起自定义协议的子资源请求也没有理论障碍，仍要实测确认。
2. **POSIX 分支缺实证**：本机是 Windows，`detached: true` + `kill(-pid)` 的收整组
   只有单测里的 `if (process.platform !== 'win32')` 分支，从未真跑过。改动 POSIX
   停止链路前必须先能在 Linux/macOS 上跑一遍
   `plugins/background-tasks/main.test.mjs` 的 process tree termination 段。
3. **7 条 symlink EPERM**：沙箱里 `symlink()` 不可用，属环境限制，非代码问题。
   换到正常 Windows 会话或 CI 上验证一次即可。
4. **热重载的已知边界**（文档已记）：直接改插件目录内的 `plugin.json` 不会改根目录
   mtime，`discoverPlugins` 缓存不失效 → 改 manifest 要重启应用。

---

## 7. 桥归宿主：调研与实施

### 7.1 业界怎么做（同构案例）

| | 沙箱 | 宿主给的能力 | 请求/响应 |
|---|---|---|---|
| VS Code webview | iframe + 严格 CSP + `localResourceRoots` | 注入全局 `acquireVsCodeApi()` | 官方只给 `postMessage`，Promise 化留给社区 |
| Figma plugin | UI 是 iframe（null origin），主侧是独立 JS 沙箱 | 沙箱里注入 `figma` 对象 | `parent.postMessage({ pluginMessage })` |
| 阿里云千问内嵌应用 | WebView / iframe 两种 | WebView 注入 `window.qwBridge`；**iframe 明确「宿主不注入脚本，页面自己封」** | `bridge-request` / `bridge-response` + `id` |
| inSCADA 自定义 HTML | `sandbox="allow-scripts allow-forms"` | 注入 `InscadaApi` 代理 | `INSCADA_API_CALL` / `_RESPONSE` + `requestId` |

四个里三个把桥放在宿主侧，插件只写业务。唯一让页面自己封的是阿里云的 iframe 分支，
但那是**第三方页面**（宿主无权往别人站里注脚本）。我们的插件 UI 是宿主自己仓库里的代码，
性质更接近 VS Code / Figma，所以「每个插件各写一份客户端」在这个形态里是少数派。

VS Code 还有一句值得照抄的约束：`acquireVsCodeApi()` 的返回值必须保持私有，
不能泄漏到全局作用域。

### 7.2 一个躲不开的约束

`sandbox="allow-scripts"` 不带 `allow-same-origin`，iframe 就是 opaque origin：

- `event.origin` 恒为字符串 `"null"`，**没有鉴权价值**（所有沙箱 iframe 长得一样）；
  唯一可靠判据是 `event.source === frame.contentWindow`。
- 父 → 子 `postMessage` 的 `targetOrigin` **只能传 `'*'`**：`"null"` 不是合法 URL，
  会抛 `SyntaxError: Invalid target origin`。所以现有代码里的 `'*'` 不是偷懒，是被逼的。
- `'*'` 的真实风险（penpal 文档专门警告过）：iframe 若被导航到第三方页面，那个页面会
  收到本该发给插件的消息。当前没有缓解手段，属于已知风险——插件 HTML 只加载
  `pi-plugin://` 资源，导航到外站的路径本身也不存在。

### 7.3 抄进来的四条

1. **每个往返必须有超时**。penpal 官方把「默认不超时」写成坑；`@xoxo-labs/figma-kit`
   给 `figmaAPI.run` 定 15s，理由和我们的情况一字不差：卡死的沙箱应该表现为
   rejected promise，而不是永远转圈的 spinner。
2. **通道要有销毁语义**。penpal 的 `connection.destroy` 会把挂起的调用 reject 掉
   （`ERR_CONNECTION_DESTROYED`）。对应到我们：面板卸载 / 插件停用时 reject 所有
   pending，否则那些 `invoke` 只能等各自的超时，没有超时的就永远挂着。
3. **握手带版本号**。penpal 的 `connection.promise` 要等双方交换完方法表才 resolve。
   我们只有 hello/ready 不带版本，宿主改协议时旧插件 UI 会静默错位。
4. **错误用码**。penpal 有 `ERR_CONNECTION_TIMEOUT` 这类可编程码，插件侧才能区分
   「超时可重试」和「方法不存在，重试没用」。

**没抄的两条**：消息形状白名单（`event.data` 来自不可信一侧，`method` 会直接透到
`methods[name]`——目前靠 main 侧 methods 表兜底，够用）；MessageChannel 私有端口
（比广播更干净，但要改握手的时序，等有第二个消费者再说）。

### 7.4 为什么没引 penpal

- **origin 模型对我们的情况失效**：`WindowMessenger` 默认用当前 origin 做
  `allowedOrigins`，我们要用就得设 `childOrigin: '*'`，而它的文档明确写着
  `*` is discouraged。引个库还要绕开它最主要的安全设计。
- **它是「双方预先声明方法表」的代理模型**：`connectToChild({ methods })` 要求宿主
  先知道对方有什么方法。我们的 `methods` 是插件运行时动态提供的、宿主不认识方法名，
  它最值钱的那层 typed proxy 用不上，只剩 message 封装——那部分自己写 60 行更可控。

顺带确认：Electron 官方至今不建议用 `<webview>` 标签，推荐 iframe 一类方案，
我们走 iframe 是符合建议的。

### 7.5 实施内容

- 新增 `packages/shared/plugin-bridge.ts`：`PLUGIN_BRIDGE_PROTOCOL`（=1）、
  保留 hostname `__host`（`PLUGIN_ID_PATTERN` 要求字母开头，插件 id 永远撞不上）、
  `pluginBridgeUrl()`、`isPluginBridgeRequest()`。
- 新增 `src/main/plugins/bridge/bridge.js`：IIFE，ES2017 以内，不 import 任何东西。
  对外 `window.pi = { invoke, on, off, openPanel, setContentHeight, forwardKey, dispose,
  protocol, panelId, settings, context, theme, disposed }`；`window.pi` 用
  `writable:false, configurable:false` 定义，后来的脚本改不掉它。
- `protocol.ts`：hostname 命中 `__host` 时直接返回桥源码（`Content-Type: text/javascript`）。
  源码用 Vite 的 `?raw` **构建期内联**（产物里能看到 `#region src/main/plugins/bridge/bridge.js?raw`），
  运行时不读磁盘——extraResources / asar / chunk 化三种路径坑一次踩完。
- `plugin-panel-frame.tsx`：`plugin-ready` 带 `protocol`；`plugin-hello` 走统一入口；
  卸载时向 iframe 发 `plugin-dispose`（用单独记的 `frameWindowRef`，因为 `useEffect`
  cleanup 时 DOM ref 已经置空）；换面板时重置 `readySentRef`，新文档要重新握手。
- 三个插件：HTML 加一行 script，`app.js` 删掉自写的 `waiters` / `invokeSeq` /
  `applyTheme` / hello / 超时定时器（合计约 120 行），改成一个降级对象 + `api()` 别名。
- 新测试：`src/main/plugins/__tests__/plugin-bridge.test.ts` 15 条（用 `node:vm` 造
  干净 realm 真跑源码：握手、配对、超时、迟到回包、dispose、跨 frame 消息、重复加载、
  协议版本一致）；`packages/shared/plugin-bridge.test.ts` 4 条；
  `scripts/test-utils/fake-bridge.mjs` 给两个 UI 测试共用。

### 7.6 效果

| 插件 | 之前 | 现在 |
|---|---|---|
| ask | 无超时 | 10s + dispose |
| background-tasks | 无 hello、无超时 | 桥自动握手 + 10s + dispose + context 事件 |
| scheduler | 10s 超时 | 同左，代码少 40 行 |

插件侧现在只剩业务逻辑；协议改动只动两处（`bridge.js` 与 `plugin-panel-frame.tsx`），
且版本号不一致时桥会 warn。
