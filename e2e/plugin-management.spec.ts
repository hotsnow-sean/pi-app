import path from 'node:path'
import { test, expect } from '@playwright/test'
import { launchAgentApp, listen, startScriptedModel } from './helpers/scripted-agent'

/**
 * 设置 → 插件：目录、启停、声明式设置项。
 *
 * 覆盖：
 *  1. 内置插件出现在列表并标「内置」（不可卸载）；
 *  2. 详情页按 manifest.settings[] 渲染表单，改完落盘、离开再回来值还在；
 *  3. 停用后侧栏「应用」入口消失，重新启用后回来；
 *  4. 设置值会推给插件 iframe（scheduler 新建表单的默认工作目录被预填）。
 */

async function openPluginsSettings(win: Awaited<ReturnType<typeof launchAgentApp>>['win']) {
  await win.getByRole('button', { name: '设置', exact: true }).first().click()
  await win.getByRole('button', { name: '插件', exact: true }).first().click()
  await expect(win.locator('[data-plugin-row="scheduler"]')).toBeVisible({ timeout: 20_000 })
}

test('plugin settings page lists plugins, persists declared settings, and toggles enablement', async () => {
  test.setTimeout(180_000)
  process.env.PI_PLUGINS_DIR = path.resolve('plugins')
  const model = startScriptedModel(() => ({ text: 'ok' }), [])
  const port = await listen(model)
  const agent = await launchAgentApp(port, { language: 'zh' })
  const { win } = agent
  try {
    await openPluginsSettings(win)

    // 列表：内置标记 + 设置项数量
    const row = win.locator('[data-plugin-row="scheduler"]')
    await expect(row).toContainText('内置')
    await expect(row).toContainText('3 项设置')

    // 详情：声明式表单
    await win.locator('[data-plugin-open="scheduler"]').click()
    const detail = win.locator('[data-plugin-detail="scheduler"]')
    await expect(detail).toBeVisible()
    await expect(detail).toContainText('任务开始时通知')
    await expect(detail).toContainText('每个任务保留的运行记录')
    // 内置插件不可卸载
    await expect(detail.getByRole('button', { name: '卸载' })).toBeDisabled()

    // 改设置 → 自动保存（注意：详情顶部还有一个"启用插件"开关，按字段锚点取更准）
    const notifySwitch = detail.locator('[data-plugin-setting="notifyOnStart"]').getByRole('switch')
    await expect(notifySwitch).toHaveAttribute('aria-checked', 'true')
    await notifySwitch.click()
    await expect(detail).toContainText('已保存', { timeout: 10_000 })

    const cwdInput = detail.locator('[data-plugin-setting="defaultCwd"]').locator('input')
    await cwdInput.fill('C:\\tmp\\pi-demo-cwd')
    await expect(detail).toContainText('已保存', { timeout: 10_000 })

    // 回列表再进详情：值从磁盘读回，不依赖前端状态
    await detail.getByRole('button', { name: '全部插件' }).click()
    await win.locator('[data-plugin-open="scheduler"]').click()
    const detailAgain = win.locator('[data-plugin-detail="scheduler"]')
    await expect(detailAgain.locator('[data-plugin-setting="defaultCwd"]').locator('input')).toHaveValue(
      'C:\\tmp\\pi-demo-cwd',
      { timeout: 10_000 },
    )
    await expect(detailAgain.locator('[data-plugin-setting="notifyOnStart"]').getByRole('switch')).toHaveAttribute(
      'aria-checked',
      'false',
    )

    // 停用：列表出现「已停用」，侧栏应用入口消失
    await detailAgain.getByRole('button', { name: '全部插件' }).click()
    await row.getByRole('switch').click()
    await expect(row).toContainText('已停用', { timeout: 10_000 })
    await win.getByRole('button', { name: '返回' }).first().click()
    await expect(win.locator('[data-plugin-view="scheduler:main"]')).toHaveCount(0, { timeout: 10_000 })

    // 重新启用后入口回来
    await openPluginsSettings(win)
    await win.locator('[data-plugin-row="scheduler"]').getByRole('switch').click()
    await win.getByRole('button', { name: '返回' }).first().click()
    await expect(win.locator('[data-plugin-view="scheduler:main"]')).toBeVisible({ timeout: 15_000 })
  } finally {
    await agent.app.close()
  }
})

test('declared settings are pushed to the plugin UI', async () => {
  test.setTimeout(180_000)
  process.env.PI_PLUGINS_DIR = path.resolve('plugins')
  const model = startScriptedModel(() => ({ text: 'ok' }), [])
  const port = await listen(model)
  const agent = await launchAgentApp(port, { language: 'zh' })
  const { win } = agent
  try {
    await openPluginsSettings(win)
    await win.locator('[data-plugin-open="scheduler"]').click()
    const cwdInput = win
      .locator('[data-plugin-detail="scheduler"] [data-plugin-setting="defaultCwd"]')
      .locator('input')
    await cwdInput.fill('C:\\tmp\\pi-push-cwd')
    await expect(win.locator('[data-plugin-detail="scheduler"]')).toContainText('已保存', { timeout: 10_000 })

    // 回主界面，打开插件中央视图，新建任务：工作目录应被设置预填
    await win.getByRole('button', { name: '返回' }).first().click()
    await win.locator('[data-plugin-view="scheduler:main"]').click()
    const frame = win.frameLocator('iframe[src^="pi-plugin://scheduler"]')
    await frame.locator('#btn-new').click({ timeout: 20_000 })
    await expect(frame.locator('#f-cwd')).toHaveValue('C:\\tmp\\pi-push-cwd', { timeout: 10_000 })
  } finally {
    await agent.app.close()
  }
})
