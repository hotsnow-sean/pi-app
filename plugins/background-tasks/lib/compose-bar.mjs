// @ts-check
/// <reference path="../../plugin-sdk.d.ts" />
/**
 * 输入框上方的托盘（composer bar）：业务状态 → 宿主观感词的映射与推送。
 *
 * 注意 `state` / `tone` 用的是**宿主的观感词表**（active/ok/error/idle/warn），
 * 不是本插件的状态机：宿主不认识 running/lost，也永远不该认识。业务状态到观感的
 * 映射是插件的责任，见 rowStateOf——返回类型故意标成宿主的
 * `PluginComposerBarRowState`，写错一个词（比如顺手写 `'running'`）在类型检查下
 * 立刻现形，不必等用户看到一行被画成默认样式的托盘。
 *
 * 归属判断用 format.sameSession 而不是自己写：工具侧的 sessionFile 来自 worker，
 * 推送侧也只是插件自己知道的值，归一化只该有一份实现，两份早晚会漂。
 */

// 插件内模块一律走 imp() 动态加载并透传 ?v=（见 main.mjs 顶部）：静态 import 解析
// 相对路径时会丢掉 query，热重载会命中旧模块缓存。import.meta.url 自带本次激活的
// v，链条从入口自然向下传，每个模块都拿到同一代。
import { pathToFileURL } from 'node:url'
import { join as joinPath } from 'node:path'
// 版本参数从自己的 URL 上摘下来往下传；不用 new URL 做相对解析——
// jsdom 测试环境会给 URL 构造器打补丁，相对解析会落到 document.baseURI 上
const Q = import.meta.url.includes('?') ? `?${import.meta.url.split('?')[1]}` : ''
const imp = (name) => import(pathToFileURL(joinPath(import.meta.dirname, `${name}.mjs`)).href + Q)
const { rt, pluginId } = await imp('runtime')
const { fmtDuration, sameSession } = await imp('format')

/** 右栏面板的完整 id（宿主 catalog 里的形式）。
 *  推送时现算而不是模块加载时定死：模块加载早于 activate，ctx 还没进来；
 *  id 以宿主给的 ctx.pluginId 为准，manifest 改 id 不会在这里失配。 */
const panelId = () => `plugin:${pluginId()}:tasks`
/** 托盘里最多列几条：再多就该去右栏看，而不是把输入框顶上去 */
const BAR_MAX_ROWS = 8

function barMeta(task) {
  if (task.status === 'failed') return `退出码 ${task.exitCode ?? '?'}`
  if (task.status === 'stopped') return task.stopReason === 'timeout' ? '已超时' : '已停止'
  if (task.status === 'lost') return '状态丢失'
  return fmtDuration((task.endedAt ?? Date.now()) - task.startedAt)
}

/**
 * @param {any} task
 * @returns {import('../../plugin-sdk').PluginComposerBarRowState}
 */
function rowStateOf(task) {
  if (task.status === 'running') return 'active'
  if (task.status === 'exited') return 'ok'
  if (task.status === 'lost') return 'warn'
  if (task.status === 'stopped') return 'idle'
  return 'error'
}

/**
 * 这个会话在托盘里该显示什么。
 *
 * @param {string} sessionFile
 * @returns {import('../../plugin-sdk').PluginComposerBarState | null}
 */
export function composerBarFor(sessionFile) {
  const mine = rt.state.tasks.filter((t) => sameSession(t.sessionFile, sessionFile))
  if (mine.length === 0) return null
  const running = mine.filter((t) => t.status === 'running').sort((a, b) => b.startedAt - a.startedAt)
  const failed = mine.filter((t) => t.status === 'failed' || t.status === 'lost')
  const summary = running.length
    ? `${running.length} 个任务在运行`
    : failed.length
      ? `${failed.length} 个任务失败`
      : `${mine.length} 个任务已结束`
  const ordered = [...running, ...mine.filter((t) => t.status !== 'running').sort((a, b) => b.startedAt - a.startedAt)]
  return {
    summary,
    detail: (running[0] ?? failed[0] ?? ordered[0])?.label ?? '',
    tone: running.length ? 'active' : failed.length ? 'error' : 'ok',
    rows: ordered.slice(0, BAR_MAX_ROWS).map((t) => ({
      id: t.id,
      label: t.label,
      state: rowStateOf(t),
      // 运行中的耗时由宿主现算：推一次就固化的「12s」会骗人
      ...(t.status === 'running'
        ? { startedAt: t.startedAt, actions: [{ id: 'stop', icon: 'stop', title: '停止' }] }
        : { meta: barMeta(t) }),
    })),
    panelId: panelId(),
  }
}

/** 把某个会话的托盘状态推给宿主；bar 为 null 表示这个会话没东西可显示 */
export function pushComposerBar(sessionFile) {
  if (!sessionFile) return
  try {
    rt.ctx?.ui?.setComposerBar?.(sessionFile, composerBarFor(sessionFile))
  } catch (error) {
    // 托盘是锦上添花：推不动不能影响任务本身
    rt.ctx?.log?.('composer bar push failed', error)
  }
}

/** 某条任务变了之后刷新它所属会话的托盘 */
export function pushBarForTask(task) {
  if (task?.sessionFile) pushComposerBar(task.sessionFile)
}
