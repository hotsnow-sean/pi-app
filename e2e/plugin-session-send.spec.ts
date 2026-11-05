import path from 'node:path'
import { test, expect } from '@playwright/test'
import { launchAgentApp, listen, startScriptedModel, type Seen } from './helpers/scripted-agent'

/**
 * 插件 → 会话投递（ctx.sessions.send）：后台任务插件赖以「跑完自己回话」的那条链路。
 *
 * 证据链：
 *   模型调用插件工具 → worker 把 sessionFile 交给 main 侧的插件（透传）
 *   → 插件调 ctx.sessions.send → 宿主向该会话投递 custom message 并驱动一轮
 *   → 模型在下一轮请求里读到这条消息 → 时间线上也能看到。
 *
 * fixture 插件只做这一件事，见 e2e/fixtures/plugins/ping-back。
 */
test('plugin tool sends a message back into the calling session', async () => {
  test.setTimeout(180_000)
  process.env.PI_PLUGINS_DIR = path.resolve('e2e/fixtures/plugins')
  const seen: Seen[] = []
  const model = startScriptedModel((_firstUser, toolTexts) => {
    if (toolTexts.length === 0) return { tool: { name: 'ping_back', args: {} } }
    return { text: '收到，继续' }
  }, seen)
  const port = await listen(model)
  const agent = await launchAgentApp(port, { language: 'zh' })
  const { win } = agent
  try {
    await agent.send('做个回话测试')

    // 1. 插件工具真的进了模型可见的工具列表
    await expect.poll(() => seen[0]?.tools?.includes('ping_back') ?? false, { timeout: 40_000 }).toBe(true)

    // 2. 工具执行时拿到了发起会话（透传），插件投递成功
    await expect
      .poll(() => seen.at(-1)?.toolTexts?.join('\n') ?? '', { timeout: 40_000 })
      .toContain('sent')

    // 3. 宿主驱动了新一轮，模型请求里带着那条回报
    await expect
      .poll(() => seen.some((s) => s.messages.some((m) => m.text.includes('【回话测试】'))), { timeout: 60_000 })
      .toBe(true)

    // 4. 界面上同样可见：custom message 占用户位，但不是无名无姓的伪造输入
    await expect(win.getByText('【回话测试】后台任务回报已送达').first()).toBeVisible({ timeout: 30_000 })
  } finally {
    await agent.close()
  }
})
