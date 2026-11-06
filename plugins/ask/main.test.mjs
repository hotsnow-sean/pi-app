// 用 jsdom 环境只是因为全局 setup 会摸 window；被测代码是纯 node
import { beforeEach, describe, expect, it } from 'vitest'
import { activate } from './main.mjs'

/**
 * ask 插件的入参契约。
 *
 * 报告 §3.2 的问题不是「没校验」而是「静默截断」：模型传 9 个选项，问卷只渲染 8 个，
 * 模型以为问全了。所以这里的重点是**超限必须报错**，而不是被 slice 悄悄吃掉。
 */

let handle
let asked
let stored

function fakeCtx() {
  stored = {}
  asked = []
  return {
    dataDir: '/tmp/ask-test',
    pluginId: 'ask-test',
    storage: {
      get: () => stored,
      set: (value) => {
        stored = value
      },
    },
    settings: { get: () => ({}), onChange: () => {} },
    log: () => {},
    ui: {
      ask: async (questions) => {
        asked.push(questions)
        return { answers: questions.map((_, index) => ({ questionIndex: index, answer: '选定 A' })) }
      },
    },
    sessions: { send: async () => {}, onRunEvent: () => () => {} },
  }
}

function ask(args) {
  return handle.invoke('tool.execute', { name: 'ask_user', args })
}

const options = (n) => Array.from({ length: n }, (_, i) => ({ label: `选项 ${i + 1}` }))

beforeEach(async () => {
  handle = await activate(fakeCtx())
})

describe('ask_user 入参上限', () => {
  it('rejects too many options instead of rendering a truncated questionnaire', async () => {
    const res = await ask({ questions: [{ question: '选哪个？', options: options(9) }] })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('最多 8 个')
    expect(res.text).toContain('9 个')
    // 关键：没有弹出只有 8 项的问卷——模型不会以为问全了
    expect(asked).toHaveLength(0)
  })

  it('rejects too many questions for the same reason', async () => {
    const res = await ask({
      questions: Array.from({ length: 9 }, (_, i) => ({ question: `第 ${i + 1} 题？`, options: options(2) })),
    })
    expect(res.isError).toBe(true)
    expect(res.text).toContain('最多 8 个')
    expect(asked).toHaveLength(0)
  })

  it('still asks within the limit and reports answers as text', async () => {
    const res = await ask({ questions: [{ question: '选哪个？', options: options(2) }] })
    expect(res.isError).toBeFalsy()
    expect(asked).toHaveLength(1)
    expect(asked[0][0].options).toHaveLength(2)
    expect(res.text).toContain('用户已回答')
  })

  it('blocks prototype-chain method names on invoke', async () => {
    await expect(handle.invoke('constructor', {})).rejects.toThrow('unknown method')
    await expect(handle.invoke('toString', {})).rejects.toThrow('unknown method')
  })
})
