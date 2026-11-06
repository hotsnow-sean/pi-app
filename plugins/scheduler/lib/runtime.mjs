// @ts-check
/// <reference path="../../plugin-sdk.d.ts" />
/**
 * 插件内所有模块共享的可变状态，只有这一份。
 *
 * 拆模块之后「谁都能改」的东西必须有明确归属：全部收在这里，字段只能被赋值，
 * 不能被换成别的语义。lib/ 里的模块要读写共享状态一律 `import { rt }` 经 imp()
 * 动态加载（见 main.mjs 顶部），禁止再造模块级可变量。
 *
 * 放进 rt 的门槛：**至少两个模块要读写它**。只有一个模块用的（例如 tick 定时器
 * 的具体句柄语义、压缩阈值判断的局部计数）留在各自模块的闭包里，随 dispose 回收。
 */

export const SETTING_DEFAULTS = {
  notifyOnStart: true,
  defaultCwd: '',
  historyLimit: 30,
  taskTimeoutMinutes: 15,
  notifyPolicy: 'on-change',
}

export const TICK_MS = 5_000
/** 错过判定的宽限：只超过这一点点的不算「错过」（避免 tick 抖动） */
export const GRACE_MS = 60_000
/** 全局运行记录上限；每任务另有 historyLimit */
export const MAX_RUNS = 200
/** 任务数上限：定时任务等于「离线执行任意 prompt」，不设限等于开后门 */
export const MAX_TASKS = 50
/** 串行队列上限：到点撞车的任务不至于无限积压 */
export const QUEUE_LIMIT = 20
/** 单条运行记录正文上限（落盘）。模型最终答复本来就不该长 */
export const OUTPUT_LIMIT = 16_384
/** 列表接口只回预览，展开才拉全文 */
export const PREVIEW_CHARS = 120
/** 注入下次 prompt 的基线长度 */
export const BASELINE_CHARS = 600
/** 压缩阈值：内存记录数下限（另一个条件是文件大小） */
export const COMPACT_MIN_RUNS = 400
export const RUNS_MAX_BYTES = 8 * 1024 * 1024

export const rt = {
  /** @type {import('../../plugin-sdk').PluginContext | null} 激活时由 main 写入 */
  ctx: null,
  /**
   * manifest `settings[]` 的当前值（activate 读一次，onChange 时整体替换）。
   * @type {Record<string, any>}
   */
  settings: { ...SETTING_DEFAULTS },
  /** 插件私有目录（`plugin-data/scheduler`），激活时确定 */
  dataDir: '',
  /** 运行记录 append-only 文件 */
  runsFile: '',
  /** 条件通知的信号文件目录 */
  signalDir: '',
  /** 任务表（data.json 的内容）：load 时整体替换 */
  /** @type {{ schemaVersion: number, tasks: any[] }} */
  state: { schemaVersion: 2, tasks: [] },
  /** 运行记录的内存折叠结果 runId → run（时序靠 queuedAt 排序，不靠 Map 顺序） */
  /** @type {Map<string, any>} */
  runs: new Map(),
  /** 待执行队列；runId 在入队时就已落盘，执行只是把状态推进到 running */
  /** @type {Array<{ task: any, trigger: string, runId: string }>} */
  queue: [],
  draining: false,
  /** @type {any} */
  timer: null,
  /** 已追加但未压缩的删除墓碑数 */
  tombstones: 0,
  /** 队列满的提示节流（同一波积压只提醒一次） */
  lastQueueFullAt: 0,
  /** runs.jsonl 当前字节数（压缩判断用，不每次 stat） */
  fileBytes: 0,
  /** data.json 是否读到了本插件写过的表（读失败时不拿空表覆盖磁盘） */
  storageUsable: false,
  /**
   * 激活代数。deactivate 后仍在飞的异步回调（runAgentPrompt 还没返回）据此
   * 放弃收尾——否则会把旧一代的状态写进新激活的数据目录。
   */
  gen: 0,
  /** 本代是否活着：停用后置 false，写盘/通知/日志一律短路 */
  live: false,
}

/** 带 `[plugin:scheduler]` 前缀的日志；停用后静默（旧代异步回调不该再吵） */
export function log(...args) {
  if (!rt.live) return
  try {
    rt.ctx?.log(...args)
  } catch {
    /* 日志失败不该影响业务 */
  }
}

/** 这一代是否还能产出副作用 */
export function isLive() {
  return rt.live && rt.ctx !== null
}

/**
 * activate 时重置全部共享状态。
 *
 * 原生 ESM 缓存按 URL 共享，同一进程里多次 activate（热重载、测试）复用的是同一批
 * 模块实例，所以「新一次激活」必须显式把上一代的内存状态清干净，只保留宿主给的 ctx。
 */
export function resetRuntime() {
  rt.state = { schemaVersion: 2, tasks: [] }
  rt.runs = new Map()
  rt.queue = []
  rt.draining = false
  rt.timer = null
  rt.tombstones = 0
  rt.fileBytes = 0
  rt.lastQueueFullAt = 0
  rt.storageUsable = false
  rt.settings = { ...SETTING_DEFAULTS }
  rt.dataDir = ''
  rt.runsFile = ''
  rt.signalDir = ''
}
