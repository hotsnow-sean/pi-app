import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight } from '@renderer/components/icons'
import type { PluginMessageOrigin } from '@shared/plugin-message'
import { CodeBlockView } from './code-block-view'
import { enrichPlainTextWithPaths } from './markdown-inline-paths'

/** 短回报直接铺开：为两行字加一次点击不值当 */
const FOLD_AFTER_LINES = 6
const FOLD_AFTER_CHARS = 400

type MessageBlock = { kind: 'text'; text: string } | { kind: 'code'; lang: string; code: string }

/**
 * 把正文按 ``` 围栏切成「散文 / 代码」两类块。
 * 回报里的 tail 输出本来就包在围栏里，纯文本渲染会把三行反引号原样露出来，
 * 展开后也看不出输出边界。
 */
export function splitMessageBlocks(text: string): MessageBlock[] {
  const blocks: MessageBlock[] = []
  let buffer: string[] = []
  let code: string[] | null = null
  let lang = ''

  const flushText = () => {
    if (!buffer.length) return
    const joined = buffer.join('\n')
    if (joined.trim()) blocks.push({ kind: 'text', text: joined })
    buffer = []
  }

  for (const line of text.split('\n')) {
    const fence = /^\s*```(.*)$/.exec(line)
    if (code) {
      if (fence) {
        blocks.push({ kind: 'code', lang, code: code.join('\n') })
        code = null
        lang = ''
      } else {
        code.push(line)
      }
      continue
    }
    if (fence) {
      flushText()
      code = []
      lang = fence[1].trim()
      continue
    }
    buffer.push(line)
  }
  // 围栏没收口（文本被截断）也要照常显示，别把整段吞掉
  if (code) blocks.push({ kind: 'code', lang, code: code.join('\n') })
  flushText()
  return blocks
}

/** 折叠态的那一行：取正文里第一句有内容的话，通常就是「bg-3 已完成，耗时 3.2s」 */
function summaryLine(blocks: MessageBlock[]): string {
  for (const block of blocks) {
    if (block.kind !== 'text') continue
    const line = block.text
      .split('\n')
      .map((item) => item.trim())
      .find(Boolean)
    if (line) return line
  }
  for (const block of blocks) {
    if (block.kind !== 'code') continue
    const line = block.code
      .split('\n')
      .map((item) => item.trim())
      .find(Boolean)
    if (line) return line
  }
  return ''
}

/**
 * 插件投递的消息在对话流里的展示：徽标常驻，正文超过阈值才折成一行摘要——
 * 一次回报最多能带 3 个任务各 20 行 tail，全铺开能把整屏占满。
 *
 * kind 的文案由插件自带（`origin.kindLabel`）：宿主不认识任何插件的 kind，
 * 写死一张映射表只会让其他插件的 kind 显示成英文标识符。
 */
export function PluginMessageNote({ origin, text }: { origin: PluginMessageOrigin; text: string }) {
  const { t } = useTranslation()
  const blocks = useMemo(() => splitMessageBlocks(text), [text])
  const lineCount = useMemo(() => text.replace(/\s+$/, '').split('\n').length, [text])
  const summary = useMemo(() => summaryLine(blocks), [blocks])
  // 展开态由用户点出来优先；没点过时看长度：短回报默认铺开
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const foldable = lineCount > FOLD_AFTER_LINES || text.length > FOLD_AFTER_CHARS
  const open = userOpen ?? !foldable
  const kindText = origin.kindLabel || origin.kind

  return (
    <div className="timeline-plugin-note">
      <button
        type="button"
        onClick={() => {
          if (!foldable) return
          setUserOpen(!open)
        }}
        className="timeline-plugin-head"
        data-foldable={foldable ? 'true' : 'false'}
        aria-expanded={foldable ? open : undefined}
      >
        <span className="timeline-plugin-badge">
          <span className="timeline-plugin-badge-label">{origin.label}</span>
          {kindText ? <span className="timeline-plugin-badge-kind">{kindText}</span> : null}
          {origin.detail ? (
            <span className="timeline-plugin-badge-detail">{origin.detail}</span>
          ) : null}
        </span>
        {foldable ? (
          <span className="timeline-plugin-fold-hint">
            {open ? t('timeline:collapse') : t('timeline:expand', { count: lineCount })}
          </span>
        ) : null}
        {foldable ? (
          <ChevronRight
            className="chevron-expand h-3 w-3 timeline-text-placeholder"
            data-open={open ? 'true' : 'false'}
          />
        ) : null}
      </button>
      {open ? (
        <div className="timeline-plugin-body" data-independent-scroll>
          {blocks.map((block, index) =>
            block.kind === 'code' ? (
              <CodeBlockView
                key={index}
                code={block.code}
                lang={block.lang || undefined}
                // 外层已经折过一次，代码块里不再二次折叠：点开就是要看输出
                previewLines={block.code.split('\n').length}
                maxHeightExpanded="max-h-none"
                className="my-1.5"
              />
            ) : (
              <div key={index} className="timeline-plugin-text">
                {enrichPlainTextWithPaths(block.text)}
              </div>
            ),
          )}
        </div>
      ) : (
        <div className="timeline-plugin-summary">{enrichPlainTextWithPaths(summary)}</div>
      )}
    </div>
  )
}
