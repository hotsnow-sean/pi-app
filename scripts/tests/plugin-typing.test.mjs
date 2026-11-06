import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 插件契约的「可执行性」检查。
 *
 * 背景：插件 main.mjs 是无类型 ESM，ctx 的形状一度只存在于文档与对象字面量里。
 * 现在权威声明在 `packages/shared/plugin-context.ts`，插件通过
 * `plugins/plugin-sdk.d.ts` 转出去拿补全。这一组测试守三件人容易忘的事：
 *
 *   1. 新插件的入口忘了加 `// @ts-check` —— 检查会静默跳过它（最危险，因为没有报错）；
 *   2. 文档里的 ctx 表与类型漂移 —— 「文档承诺了、运行时没有」正是本仓库踩过的坑；
 *   3. SDK 入口被改成复制一份结构 —— 两份声明必然漂移。
 */

const root = process.cwd()
const pluginsDir = join(root, 'plugins')

function read(...segments) {
  return readFileSync(join(root, ...segments), 'utf8')
}

/** `plugins/<id>/main.mjs` 的 id 列表 */
function pluginIds() {
  return readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((id) => existsSync(join(pluginsDir, id, 'main.mjs')))
    .sort()
}

/** 从 plugin-context.ts 里取 PluginContext 的成员名（顶层，跳过注释与嵌套） */
function contextMembers() {
  const src = read('packages/shared/plugin-context.ts')
  const start = src.indexOf('export interface PluginContext {')
  assert.ok(start >= 0, 'plugin-context.ts 里找不到 export interface PluginContext')
  const body = src.slice(start)
  const end = body.indexOf('\n}')
  assert.ok(end > 0, 'PluginContext 接口没有闭合')
  const members = new Set()
  for (const line of body.slice(0, end).split('\n')) {
    const m = line.match(/^ {2}(?:readonly )?([A-Za-z_$][\w$]*)\s*[:(]/)
    if (m) members.add(m[1])
  }
  return members
}

/** 文档 §2「ctx」表格里提到的 ctx 成员 */
function documentedMembers() {
  const src = read('doc/dev/plugin-host-api.md')
  const start = src.indexOf('## 2. ctx')
  assert.ok(start >= 0, 'plugin-host-api.md 缺 §2 ctx')
  const after = src.slice(start + 1)
  const nextSection = after.indexOf('\n## ')
  const section = nextSection >= 0 ? after.slice(0, nextSection) : after
  const members = new Set()
  for (const m of section.matchAll(/ctx\.([A-Za-z_$][\w$]*)/g)) members.add(m[1])
  return members
}

function sorted(set) {
  return [...set].sort()
}

describe('插件类型契约', () => {
  it('每个插件入口都开了 // @ts-check', () => {
    const ids = pluginIds()
    assert.ok(ids.length > 0, '没有发现任何插件')
    const missing = ids.filter((id) => {
      // 行首 BOM 或 shebang 之后再找；只看前 5 行，避免正文里提到就误判
      const head = readFileSync(join(pluginsDir, id, 'main.mjs'), 'utf8')
        .replace(/^\uFEFF/, '')
        .split('\n')
        .slice(0, 5)
        .join('\n')
      return !head.includes('// @ts-check')
    })
    assert.deepEqual(
      missing,
      [],
      `这些入口没开类型检查（tsconfig 里 checkJs=false，不加 pragma 等于不检查）：${missing.join(', ')}`,
    )
  })

  it('插件 tsconfig 的 include 覆盖了所有入口', () => {
    const tsconfig = JSON.parse(read('plugins/tsconfig.json'))
    const include = tsconfig.include ?? []
    assert.ok(include.includes('*/main.mjs'), 'plugins/tsconfig.json 的 include 必须含 */main.mjs')
  })

  it('SDK 入口只做转出，不复制结构', () => {
    const sdk = read('plugins/plugin-sdk.d.ts')
    assert.match(
      sdk,
      /export \* from '\.\.\/packages\/shared\/plugin-context'/,
      'plugin-sdk.d.ts 必须从 plugin-context.ts 转出，不能自己声明一份',
    )
    // 声明了同名字符串常量 = 有人在 SDK 里手抄了一份结构
    assert.doesNotMatch(sdk, /export (interface|type) PluginContext\b/, 'SDK 里不要重新声明 PluginContext')
  })

  it('buildContext 的返回类型标成 PluginContext', () => {
    const host = read('src/main/plugins/plugin-host.ts')
    // 参数里有 `Array<() => void>`，括号套括号，不能用 `[^)]*`
    assert.match(
      host,
      /function buildContext\([\s\S]{0,200}?\): PluginContext \{/,
      'buildContext 必须标注返回类型：对象字面量的多余属性检查靠它兜底',
    )
  })

  it('文档 §2 的 ctx 表与 PluginContext 成员一致', () => {
    const typed = sorted(contextMembers())
    const documented = sorted(documentedMembers())
    assert.deepEqual(
      documented.filter((m) => !typed.includes(m)),
      [],
      '文档写了类型里没有的 ctx 成员（插件照文档写会拿到 undefined）',
    )
    assert.deepEqual(
      typed.filter((m) => !documented.includes(m)),
      [],
      '类型里有但文档没写的 ctx 成员（插件作者看不到）',
    )
  })

  it('工具结果类型带 details', () => {
    const manifest = read('packages/shared/plugin-manifest.ts')
    const start = manifest.indexOf('export type PluginToolResult = {')
    assert.ok(start >= 0, '找不到 PluginToolResult')
    const body = manifest.slice(start, manifest.indexOf('\n}', start))
    assert.match(body, /details\?:/, '文档承诺的 details 必须在类型里（否则插件拿不到结构化结果）')
  })

  it('会话运行阶段词表来自宿主的 RunEvent，不是插件自己抄的', () => {
    const context = read('packages/shared/plugin-context.ts')
    assert.match(
      context,
      /export type PluginSessionRunPhase = RunEvent\['phase'\]/,
      'PluginSessionRunPhase 必须是 RunEvent["phase"] 的别名',
    )
  })
})
