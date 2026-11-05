import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from '@playwright/test'
import { launchAgentApp, listen, startScriptedModel, type Seen } from './helpers/scripted-agent'

/**
 * 后台任务的核心价值：跑完自己回到对话里。
 *
 * 这里把回报策略预置成「每个任务都回报」，验证完整闭环：
 *   bg_start → 进程退出 → 合并窗口 → ctx.sessions.send → 模型下一轮读到回报 → 界面出现回报行。
 * 策略本身（默认只报长任务）由 doc/dev/background-tasks-design.md §6.6 定义。
 */
test('a finished background task reports its result back into the conversation', async () => {
  test.setTimeout(180_000)
  process.env.PI_PLUGINS_DIR = path.resolve('plugins')

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-e2e-bgreport-'))
  const dataDir = path.join(home, '.config', 'Electron', 'plugin-data', 'background-tasks')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(
    path.join(dataDir, 'settings.json'),
    JSON.stringify({ reportPolicy: 'all', reportThresholdMs: 1000, maxLogMb: 50 }),
  )

  const seen: Seen[] = []
  const model = startScriptedModel((_firstUser, toolTexts) => {
    if (toolTexts.length === 0) {
      return { tool: { name: 'bg_start', args: { command: 'echo report-me', label: '回报测试' } } }
    }
    return { text: '收到回报' }
  }, seen)
  const port = await listen(model)
  const agent = await launchAgentApp(port, { language: 'zh', home, keepHome: true })
  const { win } = agent
  try {
    await agent.send('跑一个任务，等它自己回报')

    // 任务完成后经合并窗口投递，宿主驱动新一轮：模型请求里出现回报正文
    await expect
      .poll(
        () => seen.some((s) => s.messages.some((m) => m.text.includes('【后台任务回报】'))),
        { timeout: 90_000 },
      )
      .toBe(true)

    const withReport = seen.find((s) => s.messages.some((m) => m.text.includes('【后台任务回报】')))
    const text = withReport?.messages.map((m) => m.text).join('\n') ?? ''
    expect(text).toContain('回报测试')
    expect(text).toContain('report-me')

    // 时间线上也能看到这条回报（custom message 占用户位，但带来源前缀）
    await expect(win.getByText('【后台任务回报】').first()).toBeVisible({ timeout: 30_000 })
  } finally {
    await agent.close()
  }
})
