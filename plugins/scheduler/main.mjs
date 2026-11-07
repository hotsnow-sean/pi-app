// @ts-check
/// <reference path="../plugin-sdk.d.ts" />
/**
 * 定时任务 — main 侧入口。
 *
 * 给用户「到点让 agent 自己跑一段活」的能力：一次 / 每天 / 每周 / 每月 / 间隔，
 * 支持有效期、启停、立即运行、条件通知与运行历史。任务与历史都归插件自己管，
 * 运行记录落在应用入口（`views[]`）——定时任务是全局调度，不属于任何一段对话。
 * 每轮执行会往任务自己的记忆文件追加一条记录，下一轮再注入 prompt（lib/memory.mjs）。
 *
 * 契约：
 *   invoke('tool.execute', { name, args, sessionFile, cwd }) → { text, details? }
 *   invoke('snapshot' | 'listRuns' | 'getRun' | 'deleteRun' | 'saveTask' | 'deleteTask'
 *          | 'setTaskEnabled' | 'runNow' | 'nextRunPreview' | 'markSeen')
 *
 * ── 多文件结构与热重载 ─────────────────────────────────────────────────────
 *
 * 本体拆在 lib/（runtime / format / schedule / task-input / store / runs / memory /
 * notify / engine / methods / tools），这里只保留激活流程与 invoke 分发。插件内的模块引用
 * **一律走 imp() 动态加载并透传 ?v=**：静态 import 解析相对路径时会丢掉 query，
 * 而宿主的热重载是把版本号编进入口 URL（按插件目录最大 mtime，见 plugin-host.ts 的
 * pluginDirVersion）——不透传的话，改了 lib、没改 main 的热更会命中旧模块缓存，
 * 新旧两代模块同进程并存。入口从 import.meta.url 拿到自己的 v，链条自然向下传。
 *
 * ⚠️ 规矩：lib/ 里禁止出现指向插件内文件的静态 import（node:fs 这类外部模块随意）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// 版本参数从自己的 URL 上摘下来往下传；不用 new URL 做相对解析——
// jsdom 测试环境会给 URL 构造器打补丁，相对解析会落到 document.baseURI 上
const Q = import.meta.url.includes('?') ? `?${import.meta.url.split('?')[1]}` : ''
const imp = (name) => import(pathToFileURL(path.join(import.meta.dirname, 'lib', `${name}.mjs`)).href + Q)

const { rt, resetRuntime, log, TICK_MS } = await imp('runtime')
const { loadSettings, load } = await imp('store')
const { recoverInterrupted, sweepSignals } = await imp('runs')
const { sweepMemory } = await imp('memory')
const { tick, recoverMissed } = await imp('engine')
const { methods } = await imp('methods')
const { tools } = await imp('tools')

/** manifest 里的工具名 → tools 对象的键。名字是给模型看的，键是代码里的 */
const TOOL_KEYS = {
  sched_create: 'create',
  sched_list: 'list',
  sched_update: 'update',
  sched_delete: 'remove',
  sched_run_now: 'runNow',
  sched_runs: 'runs',
  sched_memory: 'memory',
}

/** @param {import('../plugin-sdk').PluginContext} pluginContext */
export async function activate(pluginContext) {
  // 同一进程里可能多次激活（热重载、测试）：上一代的内存状态必须清干净
  resetRuntime()
  rt.gen += 1
  rt.live = true
  rt.ctx = pluginContext
  rt.dataDir = pluginContext.dataDir || path.join(os.tmpdir(), 'pi-scheduler')
  rt.runsFile = path.join(rt.dataDir, 'runs.jsonl')
  rt.signalDir = path.join(rt.dataDir, 'signals')
  rt.memoryDir = path.join(rt.dataDir, 'memory')
  rt.notesDir = path.join(rt.dataDir, 'notes')
  try {
    fs.mkdirSync(rt.signalDir, { recursive: true })
    fs.mkdirSync(rt.memoryDir, { recursive: true })
    fs.mkdirSync(rt.notesDir, { recursive: true })
  } catch (error) {
    log('create data dirs failed', error)
  }

  loadSettings()
  // 设置页改完立即生效，不必重启插件；回调里整体替换以拿到宿主合并后的完整值
  pluginContext.settings?.onChange?.((values) => {
    rt.settings = { ...rt.settings, ...(values ?? {}) }
    log('settings updated', rt.settings)
  })

  load()
  // 上次进程停在 queued/running 的记录先改成 interrupted，再判断补跑
  recoverInterrupted()
  sweepSignals()
  // 删任务/换代都可能留下孤儿记忆；按目录扫是唯一兜底。
  // 但 storage 读取失败时 tasks 会是空的「假空表」——这时扫一遍会把所有记忆删光
  // （与 load() 里 storageUsable 的 fail-open 保护同源），必须跳过。
  if (rt.storageUsable || rt.state.tasks.length > 0) {
    sweepMemory(rt.state.tasks.map((task) => task.id))
  }
  recoverMissed()

  rt.timer = setInterval(tick, TICK_MS)
  log(`scheduler active, ${rt.state.tasks.length} task(s), ${rt.runs.size} run(s), data ${rt.dataDir}`)

  return {
    async invoke(method, params) {
      if (method === 'tool.execute') {
        const { name, args, sessionFile, cwd } = params ?? {}
        const key = Object.hasOwn(TOOL_KEYS, String(name || '')) ? TOOL_KEYS[String(name || '')] : null
        // hasOwn 防原型链：'constructor' 这类名字不该被当成可用工具
        const fn = key && Object.hasOwn(tools, key) ? tools[key] : null
        if (!fn) return { text: `unknown tool: ${name}`, isError: true }
        try {
          return await fn(args ?? {}, { sessionFile: String(sessionFile || ''), cwd: String(cwd || '') })
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
  rt.live = false
  if (rt.timer) clearInterval(rt.timer)
  rt.timer = null
  // 换代：还在 runAgentPrompt 里等结果的旧一代返回后不再写盘/通知
  rt.gen += 1
  // 队列里的记录保持 queued 落盘状态，下次激活会被扫成 interrupted
  rt.queue = []
  rt.ctx = null
}
