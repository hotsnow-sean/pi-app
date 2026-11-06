import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, sep } from 'node:path'

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

  it('插件自己的 lib/*.mjs 也都开了 // @ts-check 且被 tsconfig 覆盖', () => {
    const libFiles = []
    for (const id of pluginIds()) {
      const dir = join(pluginsDir, id, 'lib')
      if (!existsSync(dir)) continue
      for (const name of readdirSync(dir)) {
        if (name.endsWith('.mjs')) libFiles.push(`${id}/lib/${name}`)
      }
    }
    const tsconfig = JSON.parse(read('plugins/tsconfig.json'))
    const include = tsconfig.include ?? []
    for (const file of libFiles) {
      const head = readFileSync(join(pluginsDir, file), 'utf8').replace(/^\uFEFF/, '').split('\n').slice(0, 5).join('\n')
      assert.ok(
        head.includes('// @ts-check'),
        `${file} 没开类型检查（checkJs=false，不加 pragma 等于不检查）`,
      )
    }
    if (libFiles.length > 0) {
      assert.ok(
        include.includes('*/lib/*.mjs'),
        '有插件拆了 lib/，tsconfig 的 include 必须覆盖 */lib/*.mjs',
      )
    }
  })

  it('插件模块内部没有指向插件文件的静态 import（热重载要求全部走 imp()）', () => {
    // 静态 import 解析相对路径时会丢掉 ?v=：入口被 bust 重新执行，它引到的插件内
    // 文件却命中缓存——新旧两代模块同进程并存，是比完全旧更难查的错。所以插件内
    // 模块引用一律走带 ?v= 的动态导入（见 background-tasks/main.mjs 顶部注释）。
    // 按 `from '<相对路径>'` 扫而不是按行扫：prettier 会把长 import 排成多行，
    // 行首正则抓不到（复审 P2-14）；动态 import() 没有 from，天然不会误报。
    const files = []
    for (const id of pluginIds()) {
      files.push(`${id}/main.mjs`)
      const dir = join(pluginsDir, id, 'lib')
      if (existsSync(dir)) {
        for (const name of readdirSync(dir)) {
          if (name.endsWith('.mjs')) files.push(`${id}/lib/${name}`)
        }
      }
    }
    for (const rel of files) {
      const src = readFileSync(join(pluginsDir, rel), 'utf8').replace(/^\uFEFF/, '')
      const offenders = [
        ...src.matchAll(/\bfrom\s*['"](\.\.?\/[^'"]+)['"]/g),
        ...src.matchAll(/\bimport\s*['"](\.\.?\/[^'"]+)['"]/g),
      ]
        .map((m) => m[1])
        .filter((spec) => !spec.endsWith('.d.ts'))
      assert.deepEqual(
        offenders,
        [],
        `${rel} 里出现了插件内静态 import（${offenders.join(', ')}）。` +
          '插件内模块必须走 imp() 动态加载并透传 ?v=，否则热重载会拿到旧模块。',
      )
    }
  })

  it('动态 import 也不能直接写相对路径（必须经 imp() 透传 ?v=）', () => {
    // `await import('./lib/x.mjs')` 同样丢 query：复审 P2-15。imp() 是唯一合法入口，
    // 它用 import.meta.dirname 程序化拼 URL，正则抓不到字面量——写了字面量的都是漏网
    const files = []
    for (const id of pluginIds()) {
      files.push(`${id}/main.mjs`)
      const dir = join(pluginsDir, id, 'lib')
      if (existsSync(dir)) {
        for (const name of readdirSync(dir)) {
          if (name.endsWith('.mjs')) files.push(`${id}/lib/${name}`)
        }
      }
    }
    for (const rel of files) {
      const src = readFileSync(join(pluginsDir, rel), 'utf8')
      const pluginRoot = join(pluginsDir, rel.split('/')[0])
      const offenders = [...src.matchAll(/\bimport\s*\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g)]
        .map((m) => m[1])
        // 只盯插件自身目录内的模块（会被宿主编 ?v= 的那批）。`import('../plugin-sdk')`
        // 这类跨出插件目录的写法只出现在类型注释里，不是运行时加载
        .filter((spec) => join(pluginRoot, spec).startsWith(pluginRoot + sep))
      assert.deepEqual(
        offenders,
        [],
        `${rel} 里出现了直写相对路径的动态 import（${offenders.join(', ')}）。` +
          '一律走 imp()（模块内自带的动态加载帮助函数），由它透传本次激活的 ?v=。',
      )
    }
  })

  it('定义了 imp() 的模块必须真的透传 ?v=（Q 来自 import.meta.url）', () => {
    // imp() 少拼一个 `+ Q`，热重载就静默退化成「改了 lib 不生效」，10 条测试全绿（复审 P2-16）
    const files = []
    for (const id of pluginIds()) {
      files.push(`${id}/main.mjs`)
      const dir = join(pluginsDir, id, 'lib')
      if (existsSync(dir)) {
        for (const name of readdirSync(dir)) {
          if (name.endsWith('.mjs')) files.push(`${id}/lib/${name}`)
        }
      }
    }
    for (const rel of files) {
      const src = readFileSync(join(pluginsDir, rel), 'utf8')
      if (!/const imp = /.test(src)) continue
      assert.match(
        src,
        /\+\s*Q\b/,
        `${rel} 定义了 imp() 但没有把 Q 拼进 URL——热重载会拿到旧模块缓存`,
      )
      assert.match(
        src,
        /Q\s*=\s*import\.meta\.url/,
        `${rel} 的 Q 不是从 import.meta.url 派生——版本号透传链断了`,
      )
    }
  })

  it('插件 tsconfig 的 include 覆盖了所有入口', () => {
    const tsconfig = JSON.parse(read('plugins/tsconfig.json'))
    const include = tsconfig.include ?? []
    assert.ok(include.includes('*/main.mjs'), 'plugins/tsconfig.json 的 include 必须含 */main.mjs')
  })

  it('npm run typecheck 仍然带着插件检查', () => {
    // 光有 tsconfig 没用：`typecheck` 是 CI/提交前唯一会跑的命令，从里面
    // 挪掉 typecheck:plugins，插件的类型错误就再也没人看得见（且完全不报错）
    const pkg = JSON.parse(read('package.json'))
    assert.match(
      pkg.scripts?.typecheck ?? '',
      /typecheck:plugins/,
      'typecheck 必须串 typecheck:plugins，否则插件侧类型检查形同不存在',
    )
    assert.ok(pkg.scripts?.['typecheck:plugins'], '缺 typecheck:plugins 脚本')
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
