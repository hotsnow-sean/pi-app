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

### 唯一实质性的耦合债：iframe invoke 桥被复制了三份，且已经分叉

| 插件 | 发 hello | invoke 超时 | 失败处理 |
| --- | --- | --- | --- |
| ask | 有 | **无**（宿主不回就永远 pending） | reject |
| background-tasks | **无** | **无** | reject |
| scheduler | 有 | 10s | reject + 提示「宿主没有响应」 |

三份 `applyTheme()` / `api()` 逐字相似却各改各的。这类「胶水」不该由每个插件重写：
它承载的是宿主协议，写错了（比如漏超时）不会有任何报错，只会表现为「按钮一直在转」。

**建议的修法（本轮未做，理由见下）**：让宿主在 `pi-plugin://` 上占用一个保留
hostname 提供桥脚本，例如 `pi-plugin://host/bridge.js`，插件 HTML 里一行
`<script src="pi-plugin://host/bridge.js"></script>` 即可拿到
`window.piBridge = { invoke(method, params), onEnvironment(cb) }`。可行性：协议
的 CSP 已经是 `script-src pi-plugin:`（同 scheme 的脚本本来就允许），
`protocol.ts` 只需在 handler 里对 `hostname === 'host'` 走另一条文件根。
风险点是**打包期路径**：桥脚本要么进 extraResources，要么由 bundler 内联成字符串
——这正是 `bundle-paths.ts` 那类坑的现场，需要单独一轮 + 打包后实测。
另外 `discoverPlugins` 要跳过 `_` 开头的目录，否则设置页会多出一行「plugin.json not found」。

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

1. **iframe 桥的分叉还在**（见 §4），最现实的影响是 ask 面板的 invoke 没有超时：
   宿主侧正常路径都会回包，所以现在不发作；一旦 renderer 重载或 IPC 抛错，
   那个按钮就永远转圈。
2. **POSIX 分支缺实证**：本机是 Windows，`detached: true` + `kill(-pid)` 的收整组
   只有单测里的 `if (process.platform !== 'win32')` 分支，从未真跑过。改动 POSIX
   停止链路前必须先能在 Linux/macOS 上跑一遍
   `plugins/background-tasks/main.test.mjs` 的 process tree termination 段。
3. **7 条 symlink EPERM**：沙箱里 `symlink()` 不可用，属环境限制，非代码问题。
   换到正常 Windows 会话或 CI 上验证一次即可。
4. **热重载的已知边界**（文档已记）：直接改插件目录内的 `plugin.json` 不会改根目录
   mtime，`discoverPlugins` 缓存不失效 → 改 manifest 要重启应用。
