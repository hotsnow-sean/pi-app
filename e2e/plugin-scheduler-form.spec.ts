import path from 'node:path'
import { test, expect } from '@playwright/test'
import { launchAgentApp, listen, startScriptedModel } from './helpers/scripted-agent'

/**
 * 定时任务表单行为回归：切换「重复」类型时表单字段要联动（once/interval 无时间字段，
 * weekly 有星期、monthly 有几号），并且 interval 任务要能端到端保存并在列表正确显示。
 */
test('scheduler form adapts to schedule kind and saves interval tasks', async () => {
  test.setTimeout(120_000)
  process.env.PI_PLUGINS_DIR = path.resolve('plugins')
  const model = startScriptedModel(() => ({ text: 'ok' }), [])
  const port = await listen(model)
  const agent = await launchAgentApp(port, { language: 'zh', config: { theme: 'light' }, keepHome: true })
  const { win } = agent
  try {
    // 插件只有中央视图（无右栏面板）：从侧栏「应用」进入
    await win.locator('[data-plugin-view="scheduler:main"]').click()
    const frame = win.frameLocator('iframe[src^="pi-plugin://scheduler"]')
    await expect(frame.locator('body')).toBeVisible({ timeout: 20_000 })

    await frame.locator('#btn-new').click()
    // 默认每天：时间字段可见
    await expect(frame.locator('#f-time-field')).toBeVisible()
    await expect(frame.locator('#f-weekday-row')).toBeHidden()

    // 仅一次：时间消失，出现执行时刻且预填了未来时间
    await frame.locator('#f-kind').selectOption('once')
    await expect(frame.locator('#f-time-field')).toBeHidden()
    await expect(frame.locator('#f-once-row')).toBeVisible()
    const at = await frame.locator('#f-at').inputValue()
    expect(new Date(at).getTime()).toBeGreaterThan(Date.now())

    // 间隔：时间消失，出现每隔数值 + 单位
    await frame.locator('#f-kind').selectOption('interval')
    await expect(frame.locator('#f-time-field')).toBeHidden()
    await expect(frame.locator('#f-interval-row')).toBeVisible()

    // 每周：时间回来 + 星期
    await frame.locator('#f-kind').selectOption('weekly')
    await expect(frame.locator('#f-time-field')).toBeVisible()
    await expect(frame.locator('#f-weekday-row')).toBeVisible()

    // 端到端保存一个 30 分钟间隔任务，列表应显示「每隔 30 分钟」
    await frame.locator('#f-kind').selectOption('interval')
    await frame.locator('#f-name').fill('e2e 间隔任务')
    await frame.locator('#f-prompt').fill('什么都不做，回复 ok')
    await frame.locator('#f-interval-value').fill('30')
    await frame.locator('#f-interval-unit').selectOption('m')
    await frame.locator('#btn-save').click()
    await expect(frame.locator('.card').filter({ hasText: 'e2e 间隔任务' })).toBeVisible({ timeout: 10_000 })
    await expect(frame.locator('.card').filter({ hasText: '每隔 30 分钟' })).toBeVisible()

    // 立即运行 → 运行记录页出现记录 → 展开看到 agent 的回复文本（真实 SDK 会话，模型为 scripted mock）
    const card = frame.locator('.card').filter({ hasText: 'e2e 间隔任务' })
    await card.locator('.act-run').click()
    await frame.locator('#nav-runs').click()
    const row = frame.locator('.run-row').first()
    await expect(row).toBeVisible({ timeout: 60_000 })
    await expect(row.locator('.run-status.ok')).toBeVisible({ timeout: 60_000 })
    await row.locator('.run-line').click()
    await expect(frame.locator('.run-result')).toContainText('ok', { timeout: 10_000 })

    // 卡片上的上次运行状态与记录入口
    await frame.locator('#nav-tasks').click()
    await expect(card.locator('.last-run.ok')).toBeVisible()
    await card.locator('.act-history').click()
    await expect(frame.locator('.run')).toBeVisible()
  } finally {
    await agent.app.close()
  }
})
