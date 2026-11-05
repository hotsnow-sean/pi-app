import path from 'node:path'
import { test, expect } from '@playwright/test'
import { launchAgentApp, listen, startScriptedModel, type Seen } from './helpers/scripted-agent'

/**
 * 输入框托盘：插件把「这个会话后台在干什么」推到输入框上方，位置与 todo tray 相同。
 *
 * 覆盖四件事——
 *   1. 插件 main 推的状态真的到了 renderer（app event 链路 + 会话归属）；
 *   2. 折叠态只有一行摘要，点开才列出任务；
 *   3. 点某条任务 → 右栏面板被打开并定位到那一条；
 *   4. 任务结束后摘要从「运行中」变成「已结束」——推送而不是轮询的意义就在这。
 *
 * 会话归属最容易漂：工具的 sessionFile 来自 worker，推送侧是插件自己记的值。
 * 所以这条 e2e 真跑一次，而不是只测组件。
 */
test('composer tray shows this session tasks and opens the right panel on click', async () => {
  test.setTimeout(180_000)
  process.env.PI_PLUGINS_DIR = path.resolve('plugins')
  const seen: Seen[] = []
  const model = startScriptedModel((_firstUser, toolTexts) => {
    if (toolTexts.length === 0) {
      return {
        tool: {
          name: 'bg_start',
          args: { command: 'sleep 6', label: '托盘演示' },
        },
      }
    }
    return { text: '任务已经跑起来了' }
  }, seen)
  const port = await listen(model)
  const agent = await launchAgentApp(port, { language: 'zh' })
  const { win } = agent
  try {
    await agent.send('在后台跑个长任务')

    await expect.poll(() => seen[1]?.toolTexts?.[0] ?? '', { timeout: 60_000 }).toContain('bg-1')
    await expect(win.getByText('任务已经跑起来了')).toBeVisible({ timeout: 60_000 })

    // 1. 托盘挂在输入框上方，摘要行由插件推来
    const bar = win.locator('section[data-plugin-bar="background-tasks"]')
    await expect(bar).toBeVisible({ timeout: 30_000 })
    await expect(bar).toContainText('1 个任务在运行', { timeout: 30_000 })
    await expect(bar).toContainText('托盘演示')

    // 2. 折叠态不列任务（默认只占一行），点开才展开
    await expect(bar.locator('[data-row-id]')).toHaveCount(0)
    await bar.locator('button.adapter-widget-trigger').click()
    await expect(bar.locator('[data-row-id]')).toHaveCount(1, { timeout: 10_000 })

    // 3. 点任务 → 右栏面板打开并定位到这一条
    await bar.locator('[data-row-id]').first().click()
    // 展开态要留住：点一行只是「换到右栏看」，列表不该自己收起来
    await expect(bar.locator('[data-row-id]')).toHaveCount(1)
    const panel = win.frameLocator('iframe[src$="ui/index.html"]')
    await expect(panel.locator('body')).toContainText('托盘演示', { timeout: 20_000 })
    await expect(panel.locator('.row.open')).toHaveCount(1, { timeout: 20_000 })

    // 4. 任务自然结束后，摘要由推送更新（没有轮询也有新状态）
    await expect(bar).toContainText('已结束', { timeout: 30_000 })
  } finally {
    await agent.close()
  }
})
