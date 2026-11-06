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

export const PLUGIN_ID = 'background-tasks'

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
}
