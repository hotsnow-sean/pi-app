// @ts-check
/// <reference path="../plugin-sdk.d.ts" />
/**
 * 提问台 — main 侧服务。
 *
 * 这个插件只做一件事：给会话提供一个 `ask_user` 工具。模型调用它 → 宿主弹出问卷
 * （复用 QuestionnaireDialog）→ 你答完 → 答案以文本回灌给模型，agent 继续往下走。
 *
 * 与 pi 扩展版 ask 的区别：不依赖任何 pi 扩展包，走的是插件的 tools[] 通道；
 * 额外把每次问答记在插件存储里，提问台页面可以回看。
 *
 * 契约：
 *   invoke('tool.execute', { name, args, signal })  → { text, isError? }
 *   invoke('listRecords')                           → { records }
 *   invoke('clearRecords')                          → { ok: true }
 */

const MAX_QUESTIONS = 8
const MAX_OPTIONS = 8
const MAX_RECORDS_HARD = 500
/**
 * 宿主对单次插件工具调用有 20 分钟硬超时（超时后发 plugin-tool-cancel 并回
 * plugin_tool_timeout）。插件自己等得更久只会让用户白等一场——问卷还挂着，
 * 工具调用却已经被判死。留 2 分钟余量给回答之后的重启一轮。
 */
const MAX_WAIT_MS = 18 * 60_000

const SETTING_DEFAULTS = { timeoutSec: 600, recordHistory: true, historyLimit: 50 }

/** @type {import('../plugin-sdk').PluginContext} */
let ctx
let settings = { ...SETTING_DEFAULTS }
let state = { records: [] }

function loadSettings() {
  try {
    settings = { ...SETTING_DEFAULTS, ...(ctx.settings?.get?.() ?? {}) }
  } catch {
    settings = { ...SETTING_DEFAULTS }
  }
}

function load() {
  try {
    const data = ctx.storage.get()
    state = { records: Array.isArray(data.records) ? data.records : [] }
  } catch {
    state = { records: [] }
  }
}

function save() {
  ctx.storage.set(state)
}

// ---------- 工具入参规整 ----------

/**
 * 先查「会改变语义的形状问题」。
 *
 * 这里刻意不做截断：模型传 9 个选项、问卷只渲染 8 个，模型会以为问全了——
 * 这类「假成功」比报错危险得多（报告 §3.2）。超限就拒绝，并告诉它怎么改。
 */
function validateShape(raw) {
  if (!Array.isArray(raw)) return 'questions 必须是数组'
  if (raw.length === 0) return 'questions 不能为空'
  if (raw.length > MAX_QUESTIONS) {
    return `questions 最多 ${MAX_QUESTIONS} 个，你传了 ${raw.length} 个：把相近的问题合并，或分多次调用 ask_user。`
  }
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]
    const no = i + 1
    if (!item || typeof item !== 'object') return `第 ${no} 题不是对象`
    const options = Array.isArray(item.options) ? item.options : []
    // 少给选项会让 normalizeQuestions 静默丢掉整道题——用户看到的问卷比模型以为的少，
    // 而模型仍以为问全了。与「超限截断」一样，这里选择报错而不是裁剪。
    if (options.length < 2) {
      return options.length === 0
        ? `第 ${no} 题没有 options：每题至少给 2 个具体选项；只有一个选择时不必提问，直接按它做。`
        : `第 ${no} 题只有 1 个选项：至少 2 个；如果确实只有一个选择，直接按它做，不必提问。`
    }
    if (options.length > MAX_OPTIONS) {
      return `第 ${no} 题有 ${options.length} 个选项，最多 ${MAX_OPTIONS} 个：合并相近选项，或把长尾项留给用户自己输入。`
    }
  }
  return null
}

/** 模型给的参数不一定干净：只留下宿主问卷能安全渲染的部分 */
function normalizeQuestions(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  // 数量超限在 validateShape 就拒了；这里的 slice 只是兜底，不能靠它假装成功
  for (const item of raw.slice(0, MAX_QUESTIONS)) {
    if (!item || typeof item !== 'object') continue
    const question = String(item.question ?? '').trim()
    if (!question) continue
    const options = (Array.isArray(item.options) ? item.options : [])
      .map((option) => (typeof option === 'string' ? { label: option } : option))
      .filter((option) => option && typeof option.label === 'string' && option.label.trim())
      .slice(0, MAX_OPTIONS)
      .map((option) => ({
        label: option.label.trim(),
        ...(option.description ? { description: String(option.description).trim() } : {}),
      }))
    if (options.length === 0) continue
    out.push({
      question,
      ...(item.header ? { header: String(item.header).trim() } : {}),
      ...(item.multiSelect === true ? { multiSelect: true } : {}),
      options,
    })
  }
  return out
}

function answerText(answer) {
  if (!answer) return '（未回答）'
  if (answer.kind === 'multi') {
    const selected = Array.isArray(answer.selected) ? answer.selected : []
    return selected.length > 0 ? `已选：${selected.join('、')}` : '（未选择）'
  }
  if (answer.kind === 'custom') return `${answer.answer ?? ''}（自定义）`
  return answer.answer || '（未选择）'
}

/** 回灌给模型的文本：它要能直接读懂"问了什么、得到什么" */
function formatForModel(questions, result) {
  if (!result || result.cancelled) {
    return [
      '用户没有回答（关闭或取消了提问）。',
      '不要重复问同一组问题：先按最合理的假设继续，并在回复里说明你采用的假设。',
    ].join('')
  }
  const lines = result.answers.map((answer, index) => {
    const question = questions[answer.questionIndex]?.question ?? answer.question ?? `问题 ${index + 1}`
    return `${index + 1}. ${question} → ${answerText(answer)}`
  })
  return [`用户已回答：`, ...lines].join('\n')
}

// ---------- 提问记录 ----------

function remember(questions, result, at) {
  if (settings.recordHistory === false) return
  const limit = Math.min(MAX_RECORDS_HARD, Math.max(5, Number(settings.historyLimit) || 50))
  state.records.unshift({
    id: `ask-${at}-${Math.random().toString(36).slice(2, 8)}`,
    at,
    questions,
    cancelled: !result || result.cancelled === true,
    answers: result && Array.isArray(result.answers) ? result.answers : [],
  })
  if (state.records.length > limit) state.records.length = limit
  save()
}

// ---------- 工具执行 ----------

async function runAskTool(args, signal) {
  const shapeError = validateShape(args?.questions)
  if (shapeError) return { text: `ask_user 参数有问题：${shapeError}`, isError: true }
  const questions = normalizeQuestions(args?.questions)
  if (questions.length === 0) {
    return {
      text: 'ask_user 没有可用的题目：每个问题都需要一句 question 和至少一个 options[].label。',
      isError: true,
    }
  }
  const timeoutSec = Number(settings.timeoutSec)
  const timeoutMs =
    Number.isFinite(timeoutSec) && timeoutSec > 0 ? Math.min(timeoutSec * 1000, MAX_WAIT_MS) : 0
  const result = await ctx.ui.ask(questions, { timeoutMs, signal })
  remember(questions, result, Date.now())
  return { text: formatForModel(questions, result) }
}

const methods = {
  async 'tool.execute'({ name, args, signal }) {
    if (name !== 'ask_user') throw new Error(`unknown tool: ${name}`)
    return runAskTool(args, signal)
  },
  async listRecords() {
    return { records: state.records }
  },
  async clearRecords() {
    state.records = []
    save()
    return { ok: true }
  },
}

export async function activate(pluginContext) {
  ctx = pluginContext
  loadSettings()
  ctx.settings?.onChange?.((values) => {
    settings = { ...SETTING_DEFAULTS, ...(values ?? {}) }
    ctx.log('settings updated', settings)
  })
  load()
  ctx.log(`ask active, ${state.records.length} record(s)`)
  return {
    async invoke(method, params) {
      // hasOwn 防原型链：'constructor'/'toString' 这类名字不该被当成可用方法
      const fn = Object.hasOwn(methods, method) ? methods[method] : null
      if (!fn) throw new Error(`unknown method: ${method}`)
      return fn(params ?? {})
    },
  }
}
