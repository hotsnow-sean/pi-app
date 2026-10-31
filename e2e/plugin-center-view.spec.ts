import path from 'node:path'
import { test, expect } from '@playwright/test'
import { launchAgentApp, listen, startScriptedModel } from './helpers/scripted-agent'

/**
 * 插件中央视图（L1）：侧栏「应用」入口 → 中央内容区换装 → 再次点击回到对话。
 *
 * 覆盖三件事：
 *  1. manifest.views 在侧栏生成入口（固定区，未声明 views 的插件不出现）；
 *  2. 点击后中央列换成插件 iframe，对话的 Composer/Timeline 让位；
 *  3. 再次点击同一入口回到对话（入口是可切换的，不是单向跳转）。
 */
test('plugin view opens in the center column and toggles back', async () => {
  test.setTimeout(120_000)
  process.env.PI_PLUGINS_DIR = path.resolve('plugins')
  const model = startScriptedModel(() => ({ text: 'ok' }), [])
  const port = await listen(model)
  const agent = await launchAgentApp(port, { language: 'zh', keepHome: true })
  const { win } = agent
  try {
    // 侧栏入口（在滚动区之外的固定区）
    const entry = win.locator('[data-plugin-view="scheduler:main"]')
    await expect(entry).toBeVisible({ timeout: 20_000 })
    await expect(entry).toHaveAttribute('aria-pressed', 'false')

    await entry.click()
    const center = win.locator('[data-plugin-center="scheduler"]')
    await expect(center).toBeVisible({ timeout: 10_000 })
    await expect(entry).toHaveAttribute('aria-pressed', 'true')
    // 中央面板加载的是插件自己的文档
    const frame = win.frameLocator('iframe[src^="pi-plugin://scheduler"]')
    await expect(frame.locator('body')).toBeVisible({ timeout: 20_000 })
    // 对话被让位：主列不再渲染 Composer
    await expect(win.locator('.composer-dock-host')).toHaveCount(0)

    // 宽屏自适应：同一份 UI 在中央应摊成多列（右栏窄栏下是单列）
    const columns = await frame.locator('#task-list').evaluate((el) => getComputedStyle(el).gridTemplateColumns)
    expect(columns.split(' ').length).toBeGreaterThan(1)

    // 再点一次回到对话
    await entry.click()
    await expect(center).toHaveCount(0)
    await expect(entry).toHaveAttribute('aria-pressed', 'false')
    await expect(win.locator('.composer-dock-host')).toHaveCount(1)
  } finally {
    await agent.app.close()
  }
})
