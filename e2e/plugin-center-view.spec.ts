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

/**
 * 回归：应用视图占用中央区时，点当前会话必须回到对话。
 * 之前 switchSessionInPlace 对"就是当前会话"早退，且会话行与应用入口同时高亮，
 * 用户点了高亮会话毫无反应。revealConversation 保证"打开会话"是幂等意图。
 */
test('clicking the current session returns to chat while a plugin view is open', async () => {
  test.setTimeout(120_000)
  process.env.PI_PLUGINS_DIR = path.resolve('plugins')
  const model = startScriptedModel(() => ({ text: 'ok' }), [])
  const port = await listen(model)
  const agent = await launchAgentApp(port, { language: 'zh' })
  const { win } = agent
  try {
    // 造一个真实会话，让它出现在侧栏项目树里
    await agent.newSession()
    await agent.send('hello')
    const row = win.locator('[data-session-file]').first()
    await expect(row).toBeVisible({ timeout: 30_000 })

    // 基线：在对话视图里点已选中的会话行，留在对话
    await row.locator('button').first().click()
    await expect(win.locator('.composer-dock-host')).toHaveCount(1)

    // 打开应用视图后，点同一个（仍然高亮的）会话行 → 必须回到对话
    await win.click('[data-plugin-view="ask:main"]')
    await expect(win.locator('[data-plugin-center="ask"]')).toBeVisible({ timeout: 10_000 })
    await expect(win.locator('.composer-dock-host')).toHaveCount(0)
    await row.locator('button').first().click()
    await expect(win.locator('[data-plugin-center="ask"]')).toHaveCount(0)
    await expect(win.locator('.composer-dock-host')).toHaveCount(1)
  } finally {
    await agent.close()
  }
})
