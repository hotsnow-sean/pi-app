import path from 'node:path'
import { test, expect } from '@playwright/test'
import { launchAgentApp, listen, startScriptedModel, type Seen } from './helpers/scripted-agent'

/**
 * 插件工具（会话级能力）：内置 ask 插件声明的 `ask_user` 真的进了会话。
 *
 * 这条链路是"插件能不能伸进对话"的全部证据：
 *   manifest.tools → main 下发目录 → worker 注册成 pi 工具 → 模型调用
 *   → worker 转发回 main → 插件 main.mjs 调 ctx.ui.ask → 宿主问卷对话框
 *   → 用户作答 → 答案以工具结果回灌给模型。
 */
test('plugin tool asks the user in-session and feeds the answer back', async () => {
  test.setTimeout(180_000)
  process.env.PI_PLUGINS_DIR = path.resolve('plugins')
  const seen: Seen[] = []
  const model = startScriptedModel((_firstUser, toolTexts) => {
    if (toolTexts.length === 0) {
      return {
        tool: {
          name: 'ask_user',
          args: {
            questions: [
              {
                question: '这个项目用哪个数据库？',
                header: '数据库',
                options: [{ label: 'PostgreSQL' }, { label: 'SQLite' }],
              },
            ],
          },
        },
      }
    }
    return { text: '收到，按 PostgreSQL 继续' }
  }, seen)
  const port = await listen(model)
  const agent = await launchAgentApp(port, { language: 'zh' })
  const { win } = agent
  try {
    await agent.send('先问我要用哪种数据库')

    // 1. 插件工具真的进了模型可见的工具列表
    await expect.poll(() => seen[0]?.tools?.includes('ask_user') ?? false, { timeout: 40_000 }).toBe(true)

    // 2. 宿主弹出问卷（复用 extension-ui 的 QuestionnaireDialog）
    const dialog = win.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 40_000 })
    await expect(dialog).toContainText('这个项目用哪个数据库？')

    await win.getByRole('radio', { name: /PostgreSQL/ }).first().click()
    await win.getByRole('button', { name: '提交' }).click()

    // 4. 答案回灌：下一轮请求的 tool 消息里带上了用户的选择
    await expect
      .poll(() => seen.at(-1)?.toolTexts?.join('\n') ?? '', { timeout: 40_000 })
      .toContain('PostgreSQL')
    await expect
      .poll(() => seen.at(-1)?.toolTexts?.join('\n') ?? '')
      .toContain('用户已回答')

    // 5. agent 继续把这一轮说完
    await expect(win.getByText('收到，按 PostgreSQL 继续')).toBeVisible({ timeout: 40_000 })

    // 6. 时间线工具卡用插件声明的 kv 模板（展开分组 + 展开行后能看到问题与选项，不是裸文本）
    const group = win.getByRole('button', { name: /ask_user/ }).first()
    await group.click()
    const askRow = win.locator('[data-tool-name="ask_user"]').first()
    await expect(askRow).toBeVisible({ timeout: 10_000 })
    await askRow.locator('button').first().click()
    await expect(askRow).toContainText('这个项目用哪个数据库？', { timeout: 15_000 })
    await expect(askRow).toContainText('PostgreSQL')
  } finally {
    await agent.close()
  }
})
