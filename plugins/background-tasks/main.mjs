// @ts-check
/// <reference path="../plugin-sdk.d.ts" />
/**
 * 后台任务 — main 侧服务（入口）。
 *
 * 给会话一套「起长命令、干别的、跑完自己回来汇报」的能力。pi 内置的 bash 工具是
 * 同步等待的，长命令会把一轮对话卡死；这里把命令交给 shell 起在后台（刻意不 detached，
 * Electron 主进程里 detached 子进程会「起了但从不退出、也没有输出」）、输出直写日志文件，
 * 任务结束时通过 ctx.sessions.send 把结果投回发起它的那个会话。
 *
 * 契约：
 *   invoke('tool.execute', { name, args, sessionFile, cwd, signal }) → { text, details? }
 *   invoke('listTasks' | 'readOutput' | 'stopTask' | 'removeTask' | 'retryReport'
 *          | 'rerunTask' | 'clearTasks' | 'refreshBar')
 *   invoke('composerBarAction', { action: 'select' | 'stop', id })
 *        → 输入框托盘的点击回调；select 顺带把 focus.seq +1，右栏面板比 seq 翻到那一条
 *
 * 三条设计红线（见 doc/dev/background-tasks-design.md）：
 *   1. 输出不经宿主内存：由 shell 把 stdout/stderr 分别重定向到两个文件，
 *      几百 MB 也压不垮 main 进程。分流是为了让「失败时看 stderr」不用翻整份日志。
 *   2. 任务表落盘：宿主重启后按 pid 探测接管，对不上的记 lost 并允许手动重新回报。
 *   3. 回报要克制：默认只报「超过阈值或失败」的任务，一条消息最多展开 3 个任务——
 *      否则模型连开十个任务会把对话淹掉。投递走 steer（插话），不再做合并窗口。
 *
 * ── 多文件结构与热重载 ─────────────────────────────────────────────────────
 *
 * 本体拆在 lib/（runtime / format / log-io / shell / files / store / compose-bar /
 * report / tasks / tools / methods），这里只保留激活流程与 invoke 分发。插件内的
 * 模块引用**一律走 imp() 动态加载并透传 ?v=**：静态 import 解析相对路径时会丢掉
 * query，而宿主的热重载是把版本号编进入口 URL（按插件目录最大 mtime，见
 * plugin-host.ts 的 pluginDirVersion）——不透传的话，改了 lib、没改 main 的热更
 * 会命中旧模块缓存，新旧两代模块同进程并存。入口从 import.meta.url 拿到自己的
 * v，链条自然向下传，每次激活整个目录都拿到同一代。
 *
 * ⚠️ 规矩：lib/ 里禁止出现指向插件内文件的静态 import（node:fs 这类外部模块随意）。
 *
 * 已知边界：原生 ESM 缓存按 URL 全进程共享，lib 模块在同一个测试进程里跑多个
 * 测试文件时是同一个实例——本插件的隔离靠 activate()/deactivate() 重建状态，
 * 不要在测试里绕过这两个入口直接 import lib。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// 版本参数从自己的 URL 上摘下来往下传；不用 new URL 做相对解析——
// jsdom 测试环境会给 URL 构造器打补丁，相对解析会落到 document.baseURI 上
const Q = import.meta.url.includes('?') ? `?${import.meta.url.split('?')[1]}` : ''
const imp = (name) => import(pathToFileURL(path.join(import.meta.dirname, 'lib', `${name}.mjs`)).href + Q)

const { rt, SETTING_DEFAULTS } = await imp('runtime')
const { loadSettings, load } = await imp('store')
const { recover, disposeTasks } = await imp('tasks')
const { sweepOrphanFiles, disposeFiles } = await imp('files')
const { disposeReports } = await imp('report')
const { pushComposerBar } = await imp('compose-bar')
const { findBash } = await imp('shell')
const { tools } = await imp('tools')
const { methods } = await imp('methods')

// ---------- 生命周期 ----------

/** @param {import('../plugin-sdk').PluginContext} pluginContext */
export async function activate(pluginContext) {
  rt.ctx = pluginContext
  loadSettings()
  const dataRoot = rt.ctx.dataDir || path.join(os.tmpdir(), 'pi-background-tasks')
  rt.logDir = path.join(dataRoot, 'logs')
  // powershell 任务要一个 .ps1 落点：直接塞命令行会被引号转义搞坏
  rt.scriptDir = path.join(dataRoot, 'scripts')
  fs.mkdirSync(rt.logDir, { recursive: true })
  fs.mkdirSync(rt.scriptDir, { recursive: true })

  rt.ctx.settings?.onChange?.((values) => {
    rt.settings = { ...SETTING_DEFAULTS, ...(values ?? {}) }
    // deactivate 先于宿主回收订阅执行，排队中的设置事件可能在 rt.ctx 置空后才到
    rt.ctx?.log?.('settings updated', rt.settings)
  })

  load()
  recover()
  // 收掉历史遗留的孤儿日志（被拒绝启动的、删不掉的、早期漏删的 ps1）：
  // 它们没有任务记录，bg_clear 永远够不着，只能靠扫目录。
  // 「任务表没读到就不能扫」的守卫在 sweepOrphanFiles 本体里（rt.storageUsable），
  // 因为 clearTasks / pendingDeletes 重试也会触发扫尾（二轮复审 P1）
  sweepOrphanFiles()

  // 重启后补推托盘：托盘只在任务事件时推送，重启后没有任何事件，
  // 结果就是面板里有列表、对话框上方却毫无痕迹。面板能看到的，托盘也得能看到。
  for (const sf of new Set(rt.state.tasks.map((t) => t.sessionFile).filter(Boolean))) {
    pushComposerBar(sf)
  }

  rt.ctx.log(
    `background-tasks active, ${rt.state.tasks.length} task(s), log dir ${rt.logDir}, shell ${
      process.platform === 'win32' ? findBash() || 'cmd (bash not found)' : process.env.SHELL || 'sh'
    }`,
  )
  return {
    async invoke(method, params) {
      if (method === 'tool.execute') {
        const { name, args, sessionFile, cwd } = params ?? {}
        // hasOwn 防原型链：'constructor'/'toString' 这类名字不该被当成可用工具
        const fn = Object.hasOwn(tools, String(name || '')) ? tools[String(name || '')] : null
        if (!fn) return { text: `unknown tool: ${name}`, isError: true }
        try {
          const result = await fn(args ?? {}, { sessionFile: String(sessionFile || ''), cwd: String(cwd || '') })
          return result
        } catch (error) {
          return { text: `${name} failed: ${error?.message ?? error}`, isError: true }
        }
      }
      const handler = Object.hasOwn(methods, method) ? methods[method] : null
      if (!handler) throw new Error(`unknown method: ${method}`)
      return handler(params ?? {})
    },
  }
}

export async function deactivate() {
  // 只解定时器与记账，不杀任务：用户可能正等它出结果，重启后 recover() 再接管
  disposeTasks()
  disposeReports()
  disposeFiles()
  // 摘掉本代伸向宿主的最后一根手指：dispose 后可能还有漏网回调（异步竞态），
  // 它们摸到 rt.ctx 时不该再读设置/发消息/写 storage——save() 等处据此 no-op
  rt.ctx = null
}
