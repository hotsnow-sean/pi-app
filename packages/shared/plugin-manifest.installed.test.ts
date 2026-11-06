import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pluginManifestSchema } from './plugin-manifest'

/**
 * 内置插件的 manifest 必须能被宿主的 schema 解析。
 *
 * 这条测试守的是「插件在仓库里能跑测试、装到宿主里却加载失败」这类问题：
 * schema 校验发生在插件管理器里，报错只出现在运行时日志中，`plugin.json` 写错
 * 一个枚举值（比如工具卡模板名）不会有任何编译期提示。
 */
describe('内置插件 manifest', () => {
  const pluginsDir = join(process.cwd(), 'plugins')
  const ids = readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(pluginsDir, entry.name, 'plugin.json')))
    .map((entry) => entry.name)

  it('至少有一个内置插件', () => {
    expect(ids.length).toBeGreaterThan(0)
  })

  for (const id of ids) {
    it(`${id}/plugin.json 符合 schema`, () => {
      const raw = readFileSync(join(pluginsDir, id, 'plugin.json'), 'utf8')
      const parsed = pluginManifestSchema.safeParse(JSON.parse(raw))
      if (!parsed.success) {
        throw new Error(`${id}: ${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`)
      }
      expect(parsed.data.id).toBe(id)
    })
  }
})
