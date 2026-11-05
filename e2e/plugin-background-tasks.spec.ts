import path from 'node:path'
import { test, expect } from '@playwright/test'
import { launchAgentApp, listen, startScriptedModel, type Seen } from './helpers/scripted-agent'

/**
 * 后台任务插件：起进程 → 干别的 → 回来读输出 → 面板里看得见。
 *
 * 覆盖的是插件自己的闭环（工具链 + 任务表 + 日志增量读 + 中央视图），
 * 而「跑完自动回话」由 e2e/plugin-session-send.spec.ts 单独证明宿主侧链路。
 */
test('background task runs detached, its output is readable, and the panel lists it', async () => {
  test.setTimeout(180_000)
  process.env.PI_PLUGINS_DIR = path.resolve('plugins')
  const seen: Seen[] = []
  const model = startScriptedModel((_firstUser, toolTexts) => {
    if (toolTexts.length === 0) {
      return {
        tool: {
          name: 'bg_start',
          args: { command: 'echo bg-hello-world', label: '演示任务' },
        },
      }
    }
    // 输出是异步到达的：读到之前一直再查一次（每次都带最新的 offset）
    const last = toolTexts.at(-1) ?? ''
    if (last.includes('bg-hello-world')) return { text: '读完了' }
    if (toolTexts.length > 10) return { text: '没能读到输出' }
    return { tool: { name: 'bg_output', args: { id: 'bg-1' } } }
  }, seen)
  const port = await listen(model)
  const agent = await launchAgentApp(port, { language: 'zh' })
  const { win } = agent
  try {
    await agent.send('跑一个后台任务')

    // 1. 插件工具进了模型可见的工具列表
    await expect.poll(() => seen[0]?.tools?.includes('bg_start') ?? false, { timeout: 40_000 }).toBe(true)

    // 2. bg_start 立刻返回任务 id（没有等命令跑完）
    await expect.poll(() => seen[1]?.toolTexts?.[0] ?? '', { timeout: 40_000 }).toContain('bg-1')

    // 3. bg_output / bg_list 读到真实内容
    await expect
      .poll(() => seen.at(-1)?.toolTexts?.join('\n') ?? '', { timeout: 60_000 })
      .toContain('bg-hello-world')
    await expect.poll(() => seen.at(-1)?.toolTexts?.join('\n') ?? '', { timeout: 30_000 }).toContain('演示任务')

    // 4. 会话正常收尾（工具链没把这一轮卡住）
    await expect(win.getByText('读完了')).toBeVisible({ timeout: 30_000 })

    // 5. 中央视图：任务行、命令、状态都在
    const entry = win.locator('[data-plugin-view="background-tasks:main"]')
    await expect(entry).toBeVisible({ timeout: 20_000 })
    await entry.click()
    await expect(win.locator('[data-plugin-center="background-tasks"]')).toBeVisible({ timeout: 10_000 })
    const frame = win.frameLocator('iframe[src^="pi-plugin://background-tasks"]')
    await expect(frame.locator('body')).toBeVisible({ timeout: 20_000 })
    await expect(frame.getByText('演示任务')).toBeVisible({ timeout: 20_000 })
  } finally {
    await agent.close()
  }
})
