// @ts-check
/**
 * 插件内所有模块共享的可变状态，只有这一份。
 *
 * 拆模块后「谁都能改」的东西必须有一个明确的归属：全部收在这里，字段只能被
 * 赋值、不能被换成别的对象语义之外的东西。lib/ 里的模块要读写共享状态一律
 * `import { rt }`（经 imp() 动态加载，见各文件顶部说明），禁止再造模块级可变量。
 *
 * 放进 rt 的门槛：**至少两个模块要读写它**。只有一个模块用的（children、
 * timeouts、reportQueues、pendingDeletes、focus……）留在各自模块的闭包里，
 * 随模块的 dispose() 一起回收——deactivate 的清理项由此变少。
 */
export const SETTING_DEFAULTS = {
  reportPolicy: 'long',
  reportThresholdMs: 15_000,
  maxLogMb: 50,
}

/** 兜底 id：仅供测试夹具（ctx 不带 pluginId）与激活前的极早窗口使用。
 *  运行期一律取宿主给的 ctx.pluginId —— manifest 里的 id 改了这里不该跟着改，
 *  否则「改了 manifest 里的 id，托盘点击静默打不开面板」这类失配就会回来。 */
export const PLUGIN_ID = 'background-tasks'

/** 本插件在宿主里的真实 id：激活后以 ctx.pluginId 为准 */
export const pluginId = () => rt.ctx?.pluginId || PLUGIN_ID

export const rt = {
  /** @type {import('../../plugin-sdk').PluginContext | null} 激活时由 main 写入 */
  ctx: null,
  /** manifest `settings[]` 的当前值（activate 读一次，onChange 时由 main 整体替换） */
  settings: { ...SETTING_DEFAULTS },
  /** 任务表（落盘的就是它）：{ seq, tasks[] }，load() 时整体替换 */
  state: { seq: 0, tasks: [] },
  /** 日志目录 `<dataDir>/logs`，activate 时确定 */
  logDir: '',
  /** powershell 脚本落点 `<dataDir>/scripts`，activate 时确定 */
  scriptDir: '',
  /** 本次激活是否真的读到了本插件写过的任务表（load() 写入）。
   *  sweepOrphanFiles 据此设防：读失败一代的 known 集合是空的，任何路径
   *  （activate / clearTasks / pendingDeletes 重试）触发扫尾都会把有主日志
   *  全当孤儿删光，不可恢复。 */
  storageUsable: false,
}
