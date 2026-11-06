import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { PluginMessageNote, splitMessageBlocks } from './plugin-message-note'

// 代码高亮是异步 shiki（重），这里只关心折叠行为
vi.mock('@renderer/lib/shiki-highlighter', () => ({
  highlightCodeToHtml: async (code: string) => `<pre>${code}</pre>`,
}))

const ORIGIN = {
  pluginId: 'background-tasks',
  label: '后台任务',
  kind: 'report',
  detail: 'bg-3, bg-5',
}

const SHORT = ['【后台任务回报】bg-3「编译」已完成，耗时 3.2s。', '（该任务没有 stdout 输出）'].join(
  '\n',
)

const LONG = [
  '【后台任务回报】bg-3「编译」已完成，耗时 3.2s。',
  '最后输出（stdout）：',
  '```',
  'line 1 of the tail',
  'line 2 of the tail',
  'line 3 of the tail',
  '```',
  '完整日志：C:/tmp/bg-3.log（共 120 行），需要更多内容时用 bg_output 读。',
  '以上任务仅供知晓，继续当前工作即可。',
].join('\n')

/** 头部那一个按钮（展开后代码块里还有 copy 按钮，不能按 role 抓） */
function head(container: HTMLElement): HTMLButtonElement {
  const el = container.querySelector('.timeline-plugin-head')
  if (!el) throw new Error('头部按钮没渲染出来')
  return el as HTMLButtonElement
}

describe('splitMessageBlocks', () => {
  it('把围栏切出来，散文与代码分开', () => {
    const blocks = splitMessageBlocks(['前言', '```bash', 'echo hi', '```', '后记'].join('\n'))
    expect(blocks).toEqual([
      { kind: 'text', text: '前言' },
      { kind: 'code', lang: 'bash', code: 'echo hi' },
      { kind: 'text', text: '后记' },
    ])
  })

  it('围栏没闭合也不吞内容（回报被截断时）', () => {
    const blocks = splitMessageBlocks(['前言', '```', 'half line'].join('\n'))
    expect(blocks).toEqual([
      { kind: 'text', text: '前言' },
      { kind: 'code', lang: '', code: 'half line' },
    ])
  })
})

describe('PluginMessageNote', () => {
  it('短回报直接铺开，不给自己加一次点击', () => {
    const { container } = render(<PluginMessageNote origin={ORIGIN} text={SHORT} />)

    // 正文是整块 pre-wrap 文本，按片段匹配而不是整串相等
    expect(container.textContent).toContain('该任务没有 stdout 输出')
    // 不可折叠时按钮不带 aria-expanded，点它也不该有任何反应
    expect(head(container)).not.toHaveAttribute('aria-expanded')
    fireEvent.click(head(container))
    expect(container.textContent).toContain('该任务没有 stdout 输出')
  })

  it('长回报默认折成一行摘要：徽标和任务 id 常驻，正文收起来', () => {
    const { container } = render(<PluginMessageNote origin={ORIGIN} text={LONG} />)

    expect(screen.getByText('bg-3, bg-5')).toBeInTheDocument()
    expect(screen.getByText('【后台任务回报】bg-3「编译」已完成，耗时 3.2s。')).toBeInTheDocument()
    expect(screen.queryByText(/line 1 of the tail/)).not.toBeInTheDocument()
    expect(head(container)).toHaveAttribute('aria-expanded', 'false')
  })

  it('点开看到全文，围栏渲染成代码块而不是裸反引号', async () => {
    const { container } = render(<PluginMessageNote origin={ORIGIN} text={LONG} />)

    fireEvent.click(head(container))

    expect(head(container)).toHaveAttribute('aria-expanded', 'true')
    // 代码块亮化是异步的，节点会被替换，所以等文本出现而不是抓节点
    await waitFor(() => expect(container.textContent).toContain('line 1 of the tail'))
    // 正文里不该再出现裸围栏
    expect(container.textContent).not.toContain('```')
  })

  it('再点一次收回折叠态', () => {
    const { container } = render(<PluginMessageNote origin={ORIGIN} text={LONG} />)

    fireEvent.click(head(container))
    fireEvent.click(head(container))

    expect(head(container)).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(/line 1 of the tail/)).not.toBeInTheDocument()
  })
})
