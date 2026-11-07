import { beforeEach, describe, expect, it } from 'vitest'
import { useUIStore } from '@renderer/stores/ui-store'
import {
  isCurrentReadOnlyPreview,
  isReadOnlyPreviewSession,
  isSubagentSessionPreview,
} from './subagent-session-preview'

describe('subagent session preview identity', () => {
  it('should_remain_read_only_after_running_sidebar_children_are_reclaimed', () => {
    expect(isSubagentSessionPreview({
      workspacePath: '/workspace',
      parentSessionId: 'parent-session',
      parentSessionFile: '/sessions/parent.jsonl',
      previewSessionFile: '/sessions/child.jsonl',
      children: [],
    }, '/sessions/child.jsonl')).toBe(true)
  })
})

/**
 * 「只读预览」的统一判定。
 *
 * 背景（实机反馈）：插件 `ctx.sessions.reveal` 打开子代理会话后，中间和普通会话一模一样，
 * 输入框能打字、还能把消息真的发给子代理。根因是只读只由 `subagentSessionGroup` 驱动，
 * 而 reveal 路径为了不显示无关的兄弟会话导航条，主动把那个组清空了。
 *
 * 所以判定必须收敛成「兄弟组 OR 通用预览标记」，且两者互不依赖。
 */
describe('read-only preview detection', () => {
  beforeEach(() => {
    useUIStore.setState({
      historySessionFile: null,
      readOnlyPreviewFile: null,
      subagentSessionGroup: null,
    })
  })

  it('没有预览标记 → 不是只读', () => {
    expect(isReadOnlyPreviewSession(null, '/sessions/a.jsonl')).toBe(false)
    expect(isReadOnlyPreviewSession(undefined, '/sessions/a.jsonl')).toBe(false)
  })

  it('路径写法不同也算同一段（盘符大小写 / 分隔符）', () => {
    expect(isReadOnlyPreviewSession('c:\\work\\A.jsonl', 'C:/work/A.jsonl')).toBe(true)
  })

  it('标记指向别的会话 → 不是只读', () => {
    expect(isReadOnlyPreviewSession('/sessions/a.jsonl', '/sessions/b.jsonl')).toBe(false)
  })

  it('通用预览标记生效：当前视图只读', () => {
    useUIStore.setState({
      historySessionFile: '/sessions/child.jsonl',
      readOnlyPreviewFile: '/sessions/child.jsonl',
    })
    expect(isCurrentReadOnlyPreview()).toBe(true)
  })

  it('兄弟组生效：当前视图只读（老路径不受影响）', () => {
    useUIStore.setState({
      historySessionFile: '/sessions/child.jsonl',
      subagentSessionGroup: {
        workspacePath: '/workspace',
        parentSessionId: 'parent-session',
        parentSessionFile: '/sessions/parent.jsonl',
        previewSessionFile: '/sessions/child.jsonl',
        children: [],
      },
    })
    expect(isCurrentReadOnlyPreview()).toBe(true)
  })

  it('普通会话：两条路都不成立', () => {
    useUIStore.setState({
      historySessionFile: '/sessions/a.jsonl',
      readOnlyPreviewFile: '/sessions/b.jsonl',
    })
    expect(isCurrentReadOnlyPreview()).toBe(false)
  })

  it('两个来源互不污染：兄弟组判定只看组', () => {
    useUIStore.setState({ readOnlyPreviewFile: '/sessions/b.jsonl' })
    expect(isSubagentSessionPreview(null, '/sessions/b.jsonl')).toBe(false)
  })
})
