# 插件宿主 API（`feat/plugins-core` 实际可用）

本文只记录**这条分支上真实存在**的能力。AgentTeam 时期的 `ctx.agents`、`sessions.create/rename/setDuty`、
project 菜单等留在 `feat/plugin-host`，不在 core 上。（session bar 已单独移植到 core，见 §6。）

## 1. 插件形状

```
plugins/<id>/
  plugin.json      manifest（id/name/version/main + views[] + panels[] + sessionBars[] + tools[] + settings[]）
  main.mjs         main 侧：export async function activate(ctx) → { invoke(method, params) }
  ui/index.html    （可选）中央视图 / 右栏面板，iframe 沙箱 + postMessage
  ui/session-bar.html （可选）对话区顶部的会话条
```

`main.mjs` 是被 `import()` 进 **Electron main 进程**的普通 ESM 模块——`node:fs`、`node:child_process`
都能用。也正因为如此：抛出去的异常会直接砸在主进程里，所有异步入口必须自己 try/catch。

## 2. ctx

| 成员 | 说明 |
| --- | --- |
| `ctx.pluginId` | manifest 里的 id |
| `ctx.storage.get() / set(obj)` | 按插件隔离的 JSON 存储（`plugin-data/<id>/data.json`）。只放小状态 |
| `ctx.dataDir` | 插件的私有可写目录（`plugin-data/<id>`，已创建）。日志、缓存这类大文件放这里 |
| `ctx.settings.get()` | manifest `settings[]` 的只读快照（值由宿主设置页写入） |
| `ctx.settings.onChange(cb)` | 设置变更回调，返回解除函数 |
| `ctx.notify(title, body)` | 系统通知（点击聚焦应用） |
| `ctx.ui.ask(questions, opts)` | 弹宿主问卷并等用户作答（ask 插件的全部依赖） |
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
    kind?: string               // 'report' / 'notice' / …
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
   但带 `origin` 且正文通常自带来源前缀，界面不会当成用户自己打的字。`display: false` 的隐藏上下文
   只进模型、不进界面。

## 4. `ctx.sessions.onRunEvent`

```ts
const off = ctx.sessions.onRunEvent(({ sessionFile, phase, cwd }) => {
  // phase: started / running / idle / failed / cancelled
})
// 插件停用/重载时必须调用，否则回调悬空
off()
```

用途是决定投递语义（会话忙时排队而不是插话），**不是**判断「要不要投递」——`send` 自己处理忙闲。
注意重载后旧订阅会失效，别缓存 `off` 到磁盘。

## 5. 工具（`tools[]`）

manifest 里声明的工具会被注入每个会话，模型直接调用。执行体在 main 侧：

```js
invoke('tool.execute', { name, args, sessionFile, cwd, signal })
// → 字符串 | { text, isError?, details? } | 任意可 JSON 序列化对象
```

- `sessionFile` / `cwd` 是**发起调用的会话**透传下来的（worker 带上来的，插件在 main 侧本来拿不到）。
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

- iframe 用 `pi-plugin://<id>/<entry>` 加载，通过 `postMessage` 通信。
- 宿主 → 插件：`plugin-theme`（CSS 变量）、`plugin-settings`（声明式设置值）、
  `plugin-context`（`{ workspacePath, sessionFile, sessionId }`，切会话/切工作区时重推）、
  `plugin-invoke-result`、`plugin-open-panel-result`。
- 插件 → 宿主：
  - `plugin-invoke`（`method` 必须是 main 侧 `invoke` 能处理的键）
  - `plugin-key`（把 Esc / Cmd-K 转给宿主，否则 iframe 有焦点时快捷键失效）
  - `plugin-content-height`（**仅 sessionBars**）：上报自身高度，`0` = 收起。
    宿主按这个值撑容器；报 0 时 iframe 不卸载，随时能再撑开。
  - `plugin-open-panel`：`{ panelId, requestId }` 请求宿主切到某个右栏面板并展开。
    宿主只在面板真实存在于目录时动手，回 `plugin-open-panel-result { ok }`。
- 同一份 HTML 可以在中央视图与右栏两处渲染，按自身宽度自适应（用 `@media (max-width:460px)` 之类做窄栏分支）。

**会话条的两条约定**：
1. 归属判断由插件自己做——宿主不做反查，也不预判空态。插件报 0 就等于「这里没我事」。
2. 右上角有宿主的浮层按钮（28×28，落在 44px 条内），内容最右端要自行避让约 40–48px。

## 7. 已知限制

- 没有 `plugin-events`：main 侧无法主动推 UI，面板只能轮询（后台任务就是 1.5 秒轮询）。
- 没有 `ctx.agents`：插件不能自养常驻子会话。
- 工具调用透传的 `cwd` 是 worker 当前工作目录，不保证等于会话 workspace 根（切过 worktree 时会变）。
- `plugin-context` 的 `sessionFile` 来自 renderer（`historySessionFile`），工具体收到的
  `sessionFile` 来自 worker（`session.sessionFile`）。两者通常是同一绝对路径，但不保证逐字相同——
  插件应做归一化（大小写/分隔符/尾斜杠），必要时用 basename 兜底。
