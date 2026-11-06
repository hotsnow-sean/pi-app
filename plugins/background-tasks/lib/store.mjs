// @ts-check
/**
 * 任务表的读写与上限维护：唯一的宿主 storage 出入口。
 *
 * load()/save() 是「整体替换」语义：save 每次都把最新 tasks 数组整个交给 storage，
 * 重启模拟（二次 activate）才能读到最新一份。tailText 这类只在内存里活到回报完成的
 * 字段在 save 时摘掉，不落盘。
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
const { rt, SETTING_DEFAULTS } = await imp('runtime')
const { removeTaskFiles } = await imp('files')

const MAX_TASKS = 50

export function loadSettings() {
  try {
    rt.settings = { ...SETTING_DEFAULTS, ...(rt.ctx?.settings?.get?.() ?? {}) }
  } catch {
    rt.settings = { ...SETTING_DEFAULTS }
  }
}

/**
 * 读任务表。返回「读到了一份本插件写过的表」：
 * false = 首次启动或读失败（宿主 readStorage 是 fail open，文件损坏时静默返回 {}）。
 * 调用方（activate）据此决定要不要扫孤儿文件——把损坏后的空表当真，
 * sweepOrphanFiles 会把有主日志全当孤儿删掉，不可恢复（复审 P1）。
 */
export function load() {
  try {
    const data = rt.ctx.storage.get() ?? {}
    // save() 永远写 seq 与 tasks，两个字段任一存在才算「本插件写过的表」；
    // 首次启动（还没写过）本来也没有孤儿可扫，跳过无害
    const usable =
      data !== null && typeof data === 'object' && (data.seq !== undefined || Array.isArray(data.tasks))
    rt.state = {
      seq: Number(data.seq) || 0,
      tasks: Array.isArray(data.tasks)
        ? data.tasks
            .filter((t) => t && typeof t.id === 'string')
            // v4.1 起 report:'sent' 改名 'queued'：sent 读起来像「用户已收到」，
            // 实际只代表已交给宿主投递。旧持久化记录读入时统一迁移。
            .map((t) => (t.report === 'sent' ? { ...t, report: 'queued' } : t))
        : [],
    }
    if (!usable) rt.ctx?.log?.('storage looks empty or unreadable, orphan sweep will be skipped')
    return usable
  } catch (error) {
    rt.state = { seq: 0, tasks: [] }
    rt.ctx?.log?.('storage load failed, orphan sweep will be skipped', error)
    return false
  }
}

export function save() {
  // 停用后旧代回调（disposeTasks 摘监听之外的第二道闸）不得再写盘：
  // storage.set 是整份覆盖，会把新代刚写好的任务表抹掉
  if (!rt.ctx) return
  try {
    rt.ctx.storage.set({
      seq: rt.state.seq,
      // tailText 只在内存里活到回报完成，不落盘
      tasks: rt.state.tasks.map(({ tailText, ...rest }) => rest),
    })
  } catch (error) {
    rt.ctx?.log?.('storage save failed', error)
  }
}

export function taskById(id) {
  return rt.state.tasks.find((t) => t.id === id) ?? null
}

export function pruneTasks() {
  const limit = Math.max(10, Math.min(MAX_TASKS, 200))
  // 从最旧的往前找可删的：运行中的任务跳过而不是整体停手——之前那样遇到一个 running
  // 尾巴就 break，任务数会悄悄突破上限。
  while (rt.state.tasks.length > limit) {
    let victimIndex = -1
    for (let i = rt.state.tasks.length - 1; i >= 0; i -= 1) {
      if (rt.state.tasks[i].status !== 'running') {
        victimIndex = i
        break
      }
    }
    if (victimIndex === -1) break
    const [victim] = rt.state.tasks.splice(victimIndex, 1)
    removeTaskFiles(victim)
  }
}
