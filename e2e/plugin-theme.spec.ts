import path from 'node:path'
import { test, expect } from '@playwright/test'
import { launchAgentApp, listen, startScriptedModel } from './helpers/scripted-agent'

/**
 * 插件面板主题跟随回归：宿主必须把主题 token 推进 iframe，插件 UI 落到自己的 :root 上。
 * 断言用真实的颜色值（浅色 #ffffff / 深色 #1f1f1f），而不是"变过就算"，避免空 token 蒙混过关。
 */
test('scheduler panel follows host theme', async () => {
  test.setTimeout(120_000)
  // 直接以 out/main/index.js 启动时 app.getAppPath() 指向 out/main，用覆盖指向仓库内置插件
  process.env.PI_PLUGINS_DIR = path.resolve('plugins')
  const model = startScriptedModel(() => ({ text: 'ok' }), [])
  const port = await listen(model)
  const agent = await launchAgentApp(port, { language: 'zh', config: { theme: 'light' }, keepHome: true })
  const { win } = agent
  try {
    await win.locator('[data-plugin-view="scheduler:main"]').click()
    const frame = win.frameLocator('iframe[src^="pi-plugin://scheduler"]')
    await expect(frame.locator('body')).toBeVisible({ timeout: 20_000 })

    const read = async () => ({
      bg: await frame.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor),
      fg: await frame.locator('body').evaluate((el) => getComputedStyle(el).color),
      piBg: await frame.locator('html').evaluate((el) => el.style.getPropertyValue('--pi-background').trim()),
      // 原生时间/日期选择器的图标与弹层只认这个属性
      scheme: await frame.locator('html').evaluate((el) => getComputedStyle(el).colorScheme),
    })

    const light = await read()
    expect(light.piBg).not.toBe('')
    expect(light.bg).toBe('rgb(255, 255, 255)')
    expect(light.scheme).toBe('light')

    // 与设置页同一机制：外观切换只改 documentElement 的 dark 类
    await win.evaluate(() => document.documentElement.classList.add('dark'))
    await expect.poll(async () => (await read()).bg, { timeout: 10_000 }).toBe('rgb(31, 31, 31)')
    const dark = await read()
    expect(dark.fg).toBe('rgb(204, 204, 204)')
    expect(dark.scheme).toBe('dark')

    await win.evaluate(() => document.documentElement.classList.remove('dark'))
    await expect.poll(async () => (await read()).bg, { timeout: 10_000 }).toBe('rgb(255, 255, 255)')
  } finally {
    await agent.app.close()
  }
})
