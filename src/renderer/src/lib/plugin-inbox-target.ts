import type { PluginInboxTarget } from '@shared/plugin-context'

/**
 * 插件信箱条目的落点决策：右栏面板优先，其次中央插件视图。
 *
 * 抽成纯函数是因为**回落规则**容易写错：插件写了 `panelId` 但那个面板没装
 * （用户禁用/插件升级删了面板），此时不能静默吞掉点击——要么退回 `viewId`，
 * 要么明确告诉用户点不开。让组件自己 if-else 三遍，早晚会漏一支。
 *
 * `resolvePanelGlobalId` 而不是一个布尔判断：manifest 里写的是**局部** id（`probe`），
 * 右栏目录里存的是完整 id（`plugin:<插件>:<面板>`）。这里如果只回答「存不存在」，
 * 调用方拿到手的仍是局部 id，`setActivePanel('probe')` 会查不到 prefs 而回落成
 * 第一个可用页签——表现是「右栏亮了，但不是那个面板」。所以直接把它换成完整 id。
 */
export type InboxTargetAction =
  | { kind: 'panel'; panelId: string }
  | { kind: 'center'; pluginId: string; viewId: string }
  | { kind: 'none' }

export function resolveInboxTargetAction(
  target: PluginInboxTarget | undefined,
  resolvePanelGlobalId: (panelId: string) => string | null,
): InboxTargetAction {
  if (!target) return { kind: 'none' }
  const localPanelId = String(target.panelId || '').trim()
  const globalPanelId = localPanelId ? resolvePanelGlobalId(localPanelId) : null
  if (globalPanelId) return { kind: 'panel', panelId: globalPanelId }
  const viewId = String(target.viewId || '').trim()
  if (viewId) return { kind: 'center', pluginId: target.pluginId, viewId }
  return { kind: 'none' }
}

/** 一次点击实际要做的事（顺序敏感，所以先算成计划再执行） */
export type InboxJumpPlan = {
  /** 先回到条目所属的会话（切过去，或退化成只读预览） */
  jumpSession: boolean
  /** 叠加亮出的右栏面板（完整 id） */
  panelId?: string
  /** 切中央插件视图——**只有不跳会话时才会发生** */
  center?: { pluginId: string; viewId: string }
  /** 什么都做不了：UI 要提示「打不开」，别静默关掉弹窗 */
  empty: boolean
}

/**
 * 把「跳会话」与「打开插件落点」合成一个计划。
 *
 * 两条规则被单拎出来（都是踩过的坑）：
 * 1. **会话优先**：右栏面板是会话的附属物，只亮面板不切会话，用户看到的是别的会话的
 *    面板。所以插件条目带了 `sessionFile` 就先回会话，右栏自然跟上。
 * 2. **有会话时忽略中央视图**：`viewId` 会占满主区域，刚切过去的会话立刻被插件页顶掉，
 *    用户会以为「没跳过去」。想同时给，就只给 `panelId`（右栏叠加）而不是 `viewId`。
 */
export function planInboxJump(hasSession: boolean, action: InboxTargetAction): InboxJumpPlan {
  const panelId = action.kind === 'panel' ? action.panelId : undefined
  const center =
    action.kind === 'center' && !hasSession
      ? { pluginId: action.pluginId, viewId: action.viewId }
      : undefined
  return {
    jumpSession: hasSession,
    ...(panelId ? { panelId } : {}),
    ...(center ? { center } : {}),
    empty: !hasSession && !panelId && !center,
  }
}

/**
 * 子代理的会话文件：`<父会话目录>/<父会话 stem>/<runId>/run-<i>/session.jsonl`。
 *
 * 这类会话不在侧栏列表里，点开只能只读预览；而**别的项目**的普通会话同样不在
 * 当前列表里，却应该切项目并正常打开（要有输入框、侧栏跟着高亮）。两者必须
 * 区分开：混在一起的结果要么是「以为跳过去了其实只是预览」，要么是把子会话
 * 绑上 worker——后者会让用户能往一个别人的子代理里插话。
 */
export function isDerivedChildSessionFile(sessionFile: string | null | undefined): boolean {
  const normalized = String(sessionFile || '').trim().replace(/\\/g, '/')
  return /\/run-\d+\/session\.jsonl$/i.test(normalized)
}
