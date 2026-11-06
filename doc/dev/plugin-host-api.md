# 插件宿主 API（`feat/plugins-core` 实际可用）

本文只记录**这条分支上真实存在**的能力。AgentTeam 时期的 `ctx.agents`、`sessions.create/rename/setDuty`、
project 菜单等留在 `feat/plugin-host`，不在 core 上。（session bar 已单独移植到 core，见 §6。）

## 1. 插件形状

```
plugins/<id>/
  plugin.json      manifest（id/name/version/main + views[] + panels[] + sessionBars[] + tools[] + settings[]）
  main.mjs         main 侧：export async function activate(ctx) → { invoke(method, params) }
  lib/*.mjs        （可选）main 侧拆分模块，由 main.mjs 动态加载
  ui/index.html    （可选）中央视图 / 右栏面板，iframe 沙箱 + 宿主下发的 window.pi
  ui/session-bar.html （可选）对话区顶部的会话条
```

manifest 的 `engines['pi-desktop']`（可选，semver range，如 `">=1.4.0"`、`"^1.2"`、`"1.x || >=2.0.0"`）
**是会被校验的**：宿主版本不满足时插件不可激活，但清单本身仍被读出（id/name/version 保留在
`blockedManifest`）——设置页能看到这行插件是谁、为什么没加载，徽章是「版本不满足」，
与清单校验失败的「清单有误」分开（复审修复前这行会整个消失，用户无从排障）。
支持比较符 / `^` / `~` / `x` 通配 / 空格 AND / `||` OR；比较符与版本号之间允许空格
（`">= 1.4.0"`）。缺省组件按 npm 语义展开：`"1.4"` ≙ `"1.4.x"`、`"1"` ≙ `"1.x"`、
`">1.4"` ≙ `">=1.5.0"`、`"<=1.4"` ≙ `"<1.5.0"`、`"<1.x"` ≙ `"<1.0.0"`、`"~1"` ≙ `"1.x"`、
`"^0"` ≙ `"<1.0.0"`、`"^0.0.x"` 锁补丁位。实现见 `packages/shared/semver-range.ts`，
语法不合法时放行——它是作者的自我声明，不是安全边界。

两个已知边界：①宿主版本带 prerelease 后缀（如 `0.7.7-fork.2`）按 semver 语义比
`0.7.7` **小**，插件写 `">=0.7.7"` 会被拒载，下限请留出余量；②range 目标里的
prerelease 只在写全三位时参与比较。

`main.mjs` 是被 `import()` 进 **Electron main 进程**的普通 ESM 模块——`node:fs`、`node:child_process`
都能用。也正因为如此：抛出去的异常会直接砸在主进程里，所有异步入口必须自己 try/catch。

### 1.1 多文件插件与热重载（lib/*.mjs 的规矩）

宿主的热重载（停用 → 启用，不必重启应用）按**插件目录最大 mtime** 计算版本号，编进入口
URL 的 `?v=`。但 Node 解析静态 import 的相对路径时会**丢掉 query**——如果 lib 模块用
静态 `import './x.mjs'` 互相引用，入口换新了、它们命中的还是旧缓存，新旧两代模块
同进程并存（比完全旧更难查）。

所以多文件插件必须遵守：

- 插件内模块引用**一律走带 `?v=` 的动态导入**：入口从自己的 `import.meta.url` 摘出
  版本参数往下传，lib 收到后继续传给自己的依赖（链条参考 `plugins/background-tasks/main.mjs`）；
- 相对解析不要用 `new URL(relative, base)`：测试环境（jsdom）会给 URL 构造器打补丁，
  用 `import.meta.dirname` + `pathToFileURL` 拼；
- 跨模块共享的可变状态集中在一个 runtime 模块里（background-tasks 的 `lib/runtime.mjs`），
  只有一个模块用的状态留在各自模块闭包里，随模块的 `dispose*()` 回收。

守门：`scripts/tests/plugin-typing.test.mjs` 检查插件模块里不得出现指向插件内文件的
静态 import（多行写法也算）、不得直写 `import('./x.mjs')` 这类相对路径动态导入、
定义了 `imp()` 的模块必须真的把 `?v=` 拼进 URL；每个 lib 文件必须开 `// @ts-check`
且被 `plugins/tsconfig.json` 覆盖。

### 1.2 manifest `settings[]`（声明式设置项）

字段定义在 `packages/shared/plugin-manifest.ts`（zod schema，manifest 校验会把关）：

| 字段 | 说明 |
| --- | --- |
| `key` | 存储键，插件内唯一（`/^[a-zA-Z][a-zA-Z0-9_.-]*$/`），也是 `ctx.settings.get()` 的 key |
| `type` | `boolean` / `string` / `number` / `select` |
| `label` | 表单标签；宿主不翻译，文案插件自带 |
| `description?` | 表单下的说明文字 |
| `default?` | 默认值，类型须与 `type` 匹配（`select` 用 string），不符 manifest 校验失败 |
| `placeholder?` | 输入框占位文本 |
| `options?` | `select` 必填，`{ value, label }[]` |
| `min?` / `max?` / `step?` | `number` 的范围与步进 |
| `multiline?` | `string` 用多行文本框 |
| `secret?` | `string` 用密码框（仅遮挡显示，落盘文件仍是明文） |

值由宿主持久化在 `plugin-data/<id>/settings.json`；插件侧只读（`ctx.settings.get()`），
设置页表单即时保存，不进草稿体系。

## 2. ctx

**权威声明在 `packages/shared/plugin-context.ts`**（宿主的 `buildContext()` 标注同一个类型，
少成员、多成员都编译不过）。下面这张表必须与它逐项一致——有契约测试守着
（`scripts/tests/plugin-typing.test.mjs`）。

插件里拿类型的方式（`main.mjs` 是无类型 ESM，靠 JSDoc）：

```js
// @ts-check                                          ← 逐文件开关，不加就只补全不报错
/// <reference path="../plugin-sdk.d.ts" />
/** @type {import('../plugin-sdk').PluginContext} */
let ctx
```

`npm run typecheck:plugins` 会检查所有 `plugins/*/main.mjs` 与 `plugins/*/lib/*.mjs`
（`npm run typecheck` 已含它）。

| 成员 | 说明 |
| --- | --- |
| `ctx.pluginId` | manifest 里的 id。不要自己写死字符串常量 |
| `ctx.storage.get() / set(obj)` | 按插件隔离的 JSON 存储（`plugin-data/<id>/data.json`）。只放小状态 |
| `ctx.dataDir` | 插件的私有可写目录（`plugin-data/<id>`，已创建）。日志、缓存这类大文件放这里 |
| `ctx.settings.get()` | manifest `settings[]` 的只读快照（值由宿主设置页写入） |
| `ctx.settings.onChange(cb)` | 设置变更回调，返回解除函数 |
| `ctx.notify(title, body)` | 系统通知（点击聚焦应用） |
| `ctx.ui.ask(questions, opts)` | 弹宿主问卷并等用户作答（ask 插件的全部依赖） |
| `ctx.ui.setComposerBar(sessionFile, bar)` | 往**输入框上方的托盘**推一条摘要（见 §6.2）；`null` = 这个会话没有东西可显示 |
| `ctx.ui.inbox(item)` | 投一条到**顶栏信箱**（与「一轮跑完」的完成卡同一个信箱，见 §6.3） |
| `ctx.runAgentPrompt({cwd, prompt, timeoutMs})` | 起一个**独立 inMemory 会话**跑一次 prompt，阻塞到结束。用户看不见、历史不连续 |
| `ctx.sessions.send(spec)` | 往**用户自己的会话**投递消息并驱动一轮（见 §3） |
| `ctx.sessions.onRunEvent(cb)` | 订阅会话运行事件（见 §4） |
| `ctx.log(...args)` | 带插件前缀的日志 |

选 `runAgentPrompt` 还是 `sessions.send`：前者适合「定时跑一段无关的活」，后者适合「结果必须回到这段对话里」。

## 3. `ctx.sessions.send`

```ts
await ctx.sessions.send({
  sessionFile: string,          // 目标会话（工具调用会自动带上发起会话）
  content: string,
  origin?: {                    // 界面上标来源，不冒充用户输入
    pluginId: string
    label: string
    kind?: string               // 'report' / 'notice' / …，宿主不解释
    kindLabel?: string          // kind 的界面文案，插件自带（如「回报」）
    detail?: string
  },
  deliverAs?: 'steer' | 'followUp' | 'nextTurn',
})
```

行为保证：

1. **定向到会话而不是前台**：目标会话没有活 worker 时，宿主按会话 meta 的 cwd 冷启动，用户切到别的会话不影响投递。
2. **投递前补发插件工具目录**：冷启动的 worker 默认没有插件工具，宿主会先同步一次，`bg_output` 这类工具才调得到。
3. **空闲首轮补 system**：SDK 的 `sendCustomMessage({triggerTurn})` 会跳过 `before_agent_start` 与 system 准备，
   直接投递会导致「全新会话的第一轮没有任何 system」。宿主在空闲首轮按 `prompt()` 的顺序补齐；拿不到
   SDK 内部结构时退回原生路径（退化成投递成功但首轮缺 system，不会更坏）。
4. 落盘是 `custom_message`（`customType: plugin_host_message`）：进模型上下文、在时间线上占用户位，
   但带 `origin` 且正文通常自带来源前缀，界面不会当成用户自己打的字。
   插件投递固定 `display: true`——`PluginSendSpec` 没有 `display` 字段，插件侧没有
   「只进模型不进界面」的口子（此前文档错误地承诺过 `display: false`，已修正）。

## 4. `ctx.sessions.onRunEvent`

```ts
const off = ctx.sessions.onRunEvent(({ sessionFile, phase, cwd }) => {
  // phase: started / running / idle / failed / cancelled / state
  //        （`state` 表示只同步了状态，不是一轮的开始或结束）
})
// 插件停用/重载时必须调用，否则回调悬空
off()
```

`phase` 的词表直接取宿主的 `RunEvent['phase']`（`PluginSessionRunPhase`），**别在插件里
另造一套**——宿主只发这六个值，多写一个永远是死分支。缺失 phase 的畸形事件宿主不再派发
（以前会给空字符串，让订阅者把「未知」当成一个状态存起来）。

用途是决定投递语义（会话忙时排队而不是插话），**不是**判断「要不要投递」——`send` 自己处理忙闲。
注意重载后旧订阅会失效，别缓存 `off` 到磁盘。

## 5. 工具（`tools[]`）

manifest 里声明的工具会被注入每个会话，模型直接调用。执行体在 main 侧：

```js
invoke('tool.execute', { name, args, sessionFile, cwd, signal })
// → 字符串 | { text, isError?, details? } | 任意可 JSON 序列化对象
```

- `sessionFile` / `cwd` 是**发起调用的会话**透传下来的（worker 带上来的，插件在 main 侧本来拿不到）。
  形状见 `PluginToolExecuteParams`（`import('../plugin-sdk').PluginToolExecuteParams`）。
- `args` 里**只有 manifest `parameters` 声明过的键**。schema 没写的参数模型看不到，handler 里
  读到的永远是 `undefined`——本仓库踩过这个坑（一个可选参数漏进 schema，调用方传了也没用）。
  **改 handler 前先回头看 schema**，这是唯一能让参数真的到达的入口。
- 单次调用超时 20 分钟；用户 Esc 会 abort，`signal` 同步触发。
- 工具名全局唯一：与内置工具或其它插件重名会被跳过（记日志，不覆盖）。
- 插件工具**不受**内置工具白名单约束，权限等同 bash。

**返回值怎么选**（这是踩过的坑）：

- 模型读到的 `content` **只能是文本**——返回对象会被 stringify，调用方还得 `JSON.parse`。
- 推荐 `{ text, details }`：`text` 写给人/模型看（可读的 key: value，不要把 JSON 贴进去），
  `details` 放原始对象，宿主一路带到 worker 的 tool result（`details` 字段）。
- 代码执行类模式（codemode）里，`details` 才是被当对象用的那一份；正文永远只是文本。


## 6. UI（`views[]` / `panels[]` / `sessionBars[]`）

三个落点，同一套 iframe 与消息协议：

| 贡献点 | 落点 | 用途 |
|---|---|---|
| `views[]` | 侧栏「应用」+ 中央内容区 | 插件的主界面，整块工作区 |
| `panels[]` | 右栏（窄，约 288px） | 旁注性质的列表/详情，可与对话并排看 |
| `sessionBars[]` | 对话区顶部 | 跟着**当前会话**走的一条窄带，回答「这个会话后台在干什么」 |

- iframe 用 `pi-plugin://<id>/<entry>` 加载，入口 HTML 里引一行**宿主下发的桥**，
  之后只用 `window.pi`：

  ```html
  <script src="pi-plugin://__host/bridge.js"></script>
  <script src="app.js"></script>
  ```

  **不要自己写 postMessage 客户端**。`postMessage` 是单向广播，没有返回值、没有
  「这条回包对应哪次请求」的概念；请求配对、超时、面板卸载时的清理都得自己造，每个插件
  各写一份必然分叉（宿主侧这份已经因为分叉出三种行为而收回）。桥现在只有一份实现，
  插件只管业务。

**`window.pi`（插件 UI 唯一需要知道的接口）**

| 成员 | 说明 |
|---|---|
| `pi.invoke(method, params?, { timeoutMs? })` | 调 main 侧 `methods[method]`，返回 Promise。默认 **10s 超时**，超时 reject 且 `error.code === 'timeout'`；`timeoutMs: 0` 关闭（慎用） |
| `pi.on('theme'\|'settings'\|'context'\|'dispose', fn)` | 订阅宿主推送，返回取消函数 |
| `pi.settings` / `pi.context` / `pi.theme` / `pi.panelId` | 最近一次的值（只读快照，每次推送换引用） |
| `pi.openPanel(panelId)` | 请求宿主切到某个右栏面板并展开，resolve 成 `boolean` |
| `pi.setContentHeight(h)` | **仅 sessionBars**：上报自身高度，`0` = 收起，上限 400px |
| `pi.forwardKey(key, { mod })` | 把 Esc / Cmd-K 转给宿主（iframe 有焦点时宿主收不到 keydown） |
| `pi.dispose()` | 主动关闭通道（一般不用；面板卸载由宿主触发） |

- 握手由桥自动完成，插件不需要发 hello；主题也由桥落到 `documentElement`，
  插件只需在 `style.css` 里给 `--pi-*` 写兜底值。
- 超时、销毁、跨会话重推这些行为都由桥保证：面板卸载时宿主发 `plugin-dispose`，
  桥会把挂起的调用全部 reject（`error.code === 'disposed'`），不会留下永远转圈的按钮。
- 插件没引桥（HTML 漏了那行 script）时，`window.pi` 不存在：请按
  `const bridge = window.pi || { ...降级对象 }` 兜底，让面板显示「桥未加载」
  而不是白屏。

**线上协议**（宿主 ↔ 桥，插件作者不用碰，改这里要同步 `plugin-panel-frame.tsx` 的注释）：

- 宿主 → 插件：`plugin-ready`（`{ panelId, protocol }`）、`plugin-theme`（CSS 变量）、
  `plugin-settings`（声明式设置值）、`plugin-context`（`{ workspacePath, sessionFile, sessionId, placement }`，
  切会话/切工作区时重推）、`plugin-invoke-result`、`plugin-open-panel-result`、`plugin-dispose`。
- 插件 → 宿主：`plugin-hello`、`plugin-invoke`、`plugin-open-panel`、`plugin-key`、
  `plugin-content-height`。
- 协议版本是 `packages/shared/plugin-bridge.ts` 的 `PLUGIN_BRIDGE_PROTOCOL`，与桥脚本里
  那一份必须一致（有测试守着）；不一致时桥只 warn，不中断。

**会话条的两条约定**：
1. 归属判断由插件自己做——宿主不做反查，也不预判空态。插件报 0 就等于「这里没我事」。
2. 右上角有宿主的浮层按钮（28×28，落在 44px 条内），内容最右端要自行避让约 40–48px。

**`placement`：同一份 HTML 的三种落点**。宿主不替插件判断「该显示哪些数据」，只如实
告诉它自己挂在哪儿：

| 值 | 落点 | 语义 |
| --- | --- | --- |
| `center` | 左栏应用入口打开的中央视图（`views[]`） | **全局视图**：可以展示跨会话的全部数据，是用户做全局管理的地方 |
| `panel` | 右栏面板（`panels[]`） | **会话内视图**：只跟当前 `sessionFile` |
| `sessionBar` | 对话顶部的会话条（`sessionBars[]`） | 同上，会话内 |

缺省按 `panel` 处理（收缩的那一侧）——宿主漏传时不会把别的会话的数据摆出来。同一条
「收缩」惯例也适用于插件工具：`tool.execute` 的 `meta.sessionFile` 是**发起调用的会话**，
跨会话的读写不该由工具顺手做（后台任务的 `bg_*` 就是这么收的，见其设计文档）。

### 6.2 输入框托盘（`ctx.ui.setComposerBar`）

比 `sessionBars[]` 更贴近视线的落点：**输入框上方那条窄带**，和 adapter 的 todo tray 同一位置、
同一套视觉（`.composer-accessory-row`）。区别是**宿主原生渲染**，没有 iframe。

```ts
ctx.ui.setComposerBar(sessionFile, {
  summary: '2 个任务在运行',   // 摘要行主文案，插件自己组织语言
  detail: '构建桌面端',        // 摘要行次要文案（通常是当前任务）
  tone: 'active',             // active | ok | error，只影响图标与色调
  rows: [                     // 展开后最多 8 行
    {
      id: 'bg-3',             // 插件自己的行 id
      label: '构建桌面端',
      state: 'active',        // active | ok | error | idle | warn —— 只表达观感
      startedAt: Date.now(),  // 进行中的行：宿主据此显示实时耗时
      actions: [{ id: 'stop', icon: 'stop', title: '停止' }],
    },
  ],
  panelId: 'plugin:<id>:<panel>',  // 点行时宿主打开这个右栏面板
} | null)
```

**词表是「观感」不是「业务」**：宿主只认 `active/ok/error/idle/warn` 这五个状态词与
`active/ok/error` 三个语气词，认不出的值一律按 `active` 画。插件自己的状态机（比如
`running/exited/lost`）留在插件里，由插件决定映射到哪种观感——**不要指望宿主认识你的业务状态名**。

约定与边界：
- **`rows[].startedAt`**：给了就由宿主显示实时耗时。进行中的行别自己算一个「12s」推上来——
  推一次就固化的数字会骗人。
- **`rows[].actions[]`**：行尾按钮。`id` 是**插件自己定义的动作 id**，点击后原样回传：
  `invoke('composerBarAction', { action: <你的 id>, id: <行 id> })`；宿主只负责画，
  不解释 id 的含义。`icon` 由宿主枚举（目前只有 `'stop'`，省略即按它画），
  `title` 是悬浮提示（插件自带文案，不给则用宿主的中文兜底）。
- **点行**：宿主先打开 `panelId`（若该面板真实存在），再回调
  `composerBarAction({ action: 'select', id })`。`select` 是宿主唯一的保留字（表示「看详情」），
  插件的动作 id 不要叫这个名字。插件用这个方法记账/定位，不给也能用（就是打不开详情）。
- 这条**不是第二个面板**：只有摘要 + 若干行。要展示命令全文、实时输出、分页，放右栏。
- 一个会话可以有多条（不同插件），各占一行；插件推 `null` 表示自己在这个会话没话说，
  托盘随之消失，**不会留一条空壳把输入框顶下去**。
- 状态走 app event（`plugin_widget`），不是轮询：任务从「运行中」变「结束」是 main 侧才知道的时刻。

### 6.3 顶栏信箱（`ctx.ui.inbox`）

「这件事已经发生，你现在不在跟前」的落点：与「一轮跑完」的完成卡**共用同一个信箱**
（同一个未读红点、同一个 Dock 徽章计数、同一套标已读），区别只是点开之后跳哪。

```ts
ctx.ui.inbox({
  title: '定时任务：每日简报',        // 一行，宿主会截断
  body: '有变化：3 条新评论',          // 一两句摘要，详情归插件视图
  tone: 'success',                    // info | success | warn | error（只影响图标与颜色）
  target: { pluginId: 'scheduler', viewId: 'main' },  // 点开跳到哪个插件的哪个视图
  dedupeKey: 'task-123',              // 同一个 key 只留最新一条
})
```

**它是什么、不是什么**：

- 是「值得你知道的一次事件」；**不是归档**。宿主信箱是 main 侧内存数组（上限 200 条、
  重启即空），完整历史必须留在插件自己的存储里（定时任务放在 `runs.jsonl`）。
- 不弹系统通知、不发声——想同时打扰用户就自己调 `ctx.notify`。两者**独立成败**：
  通知可能被系统设置吞掉，信箱还在。
- 没有 `target` 也能用：条目照常进信箱、照常点亮未读，只是点不动。
- `dedupeKey` 命中时**替换旧条目并重新变未读**。高频任务（每分钟一次）必须给：
  否则 200 格信箱会被同一个任务刷满，红点也永远消不掉。

**边界**：`title` 为空时宿主直接丢弃（只打日志），不抛错——后台执行路径不该因为
一次信箱写入失败而中断。点击行为是「切中央视图」，**不带参数**：定位到具体那条记录
要靠插件自己的未读标记（`snapshot.unreadByTask` 那类），别指望宿主把 runId 传进去。


## 7. 已知限制

- 没有通用的 `plugin-events`：除托盘与信箱外，main 侧仍不能主动推 UI，面板/信箱都靠轮询（后台任务面板 1.5 秒、顶栏信箱 4 秒）。
- 没有 `ctx.agents`：插件不能自养常驻子会话。
- 工具调用透传的 `cwd` 是 worker 当前工作目录，不保证等于会话 workspace 根（切过 worktree 时会变）。
- `plugin-context` 的 `sessionFile` 来自 renderer（`historySessionFile`），工具体收到的
  `sessionFile` 来自 worker（`session.sessionFile`）。两者通常是同一绝对路径，但不保证逐字相同——
  插件应做归一化（大小写/分隔符/尾斜杠），必要时用 basename 兜底。
- **类型检查只保证形状，不保证 null 安全**：插件项目的 tsconfig 没开 `strictNullChecks`
  （无类型 JS 全开代价太大），所以 `ctx.foo.bar` 里 `foo` 可能是 `undefined` 这件事
  TS 不会拦。联合类型（如 `runAgentPrompt` 的返回值）在该模式下判别收窄也不生效，
  用 `'error' in result` 这类写法代替 `if (result.ok)` 分支取值。
