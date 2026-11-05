import path from 'node:path'
import { test, expect } from '@playwright/test'
import { launchAgentApp, listen, startScriptedModel, type Seen } from './helpers/scripted-agent'

/**
 * 会话条：贴在对话区顶部的一条「这个会话后台在干什么」。
 *
 * 覆盖三件事——
 *   1. 宿主按 manifest 挂出 iframe，且插件按当前会话过滤后能显示出来；
 *   2. 折叠行点开能看到任务；
 *   3. 点某条任务 → 右栏面板被打开并定位到那一条。
 *
 * 会话归属是这里最容易漂的一环：工具的 sessionFile 来自 worker，会话条拿到的是
 * renderer 的 historySessionFile，两边格式不一定逐字相同。所以这条 e2e 真跑一次。
 */
test('session bar lists this session tasks and opens the right panel on click', async () => {
  test.setTimeout(180_000)
  process.env.PI_PLUGINS_DIR = path.resolve('plugins')
  const seen: Seen[] = []
  const model = startScriptedModel((_firstUser, toolTexts) => {
    if (toolTexts.length === 0) {
      return {
        tool: {
          name: 'bg_start',
          args: { command: 'sleep 20', label: '会话条演示' },
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

    // 工具真的被调用，任务处于 running（会话条只对运行中/已完成的任务有意义）
    await expect.poll(() => seen[1]?.toolTexts?.[0] ?? '', { timeout: 60_000 }).toContain('bg-1')
    await expect(win.getByText('任务已经跑起来了')).toBeVisible({ timeout: 60_000 })

    // 1. 会话条 iframe 出现在对话区（宿主按 manifest.sessionBars 挂载）
    const frameEl = win.locator('iframe[src$="ui/session-bar.html"]')
    const bar = win.frameLocator('iframe[src$="ui/session-bar.html"]')
    await expect(bar.locator('body')).toContainText('个任务在跑', { timeout: 30_000 })

    // 高度由插件上报：折叠时只是一行摘要的高度
    const wrapperHeight = async () => {
      const style = (await frameEl.locator('xpath=..').getAttribute('style')) ?? ''
      return Number(style.match(/height:\s*([\d.]+)px/)?.[1] ?? 0)
    }
    const collapsedHeight = await wrapperHeight()
    expect(collapsedHeight).toBeGreaterThan(0)

    // 2. 折叠态只显示摘要；点开才列出任务（默认不占地方）
    await expect(bar.locator('.row[data-id]')).toHaveCount(0)
    await bar.locator('#summary').click()
    await expect(bar.locator('.row[data-id]')).toHaveCount(1, { timeout: 10_000 })
    await expect(bar.getByText('会话条演示')).toBeVisible()
    // 展开后容器被撑高——这条链路断了的话，任务会画在一条 34px 的缝里
    await expect.poll(wrapperHeight, { timeout: 10_000 }).toBeGreaterThan(collapsedHeight)

    // 3. 点任务 → 右栏面板打开并定位到这一条（.row.open 是「展开了」的状态）
    await bar.locator('.row[data-id]').first().click()
    const panelFrame = win.frameLocator('iframe[src$="ui/index.html"]')
    await expect(panelFrame.locator('body')).toContainText('会话条演示', { timeout: 20_000 })
    await expect(panelFrame.locator('.row.open')).toHaveCount(1, { timeout: 20_000 })
  } finally {
    await agent.close()
  }
})
