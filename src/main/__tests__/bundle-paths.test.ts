import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getAppPath: vi.fn(() => process.cwd()) } }))

import {
  resolveAppRoot,
  resolveMainOutDir,
  resolvePreloadFile,
  resolveRendererHtml,
} from '../bundle-paths'

const ROOT = process.cwd()

describe('resolveAppRoot', () => {
  it('keeps the repository root in development', () => {
    expect(resolveAppRoot(ROOT)).toBe(ROOT)
  })

  it('keeps the asar root when packaged', () => {
    const asarRoot = join('C:', 'app', 'resources', 'app.asar')
    expect(resolveAppRoot(asarRoot)).toBe(asarRoot)
    expect(resolveMainOutDir(asarRoot)).toBe(join(asarRoot, 'out', 'main'))
  })

  it('climbs back out when electron already returns out/main', () => {
    const builtMain = join(ROOT, 'out', 'main')
    expect(resolveAppRoot(builtMain)).toBe(ROOT)
    expect(resolveMainOutDir(builtMain)).toBe(builtMain)
    expect(resolvePreloadFile('index.cjs', builtMain)).toBe(join(ROOT, 'out', 'preload', 'index.cjs'))
  })
})

describe('resolvePreloadFile', () => {
  it('never resolves into out/main when the caller was bundled into out/main/chunks', () => {
    for (const file of ['index.cjs', 'notification.cjs'] as const) {
      const resolved = resolvePreloadFile(file, ROOT)
      expect(resolved).toBe(join(ROOT, 'out', 'preload', file))
      expect(resolved).not.toContain(join('out', 'main'))
    }
  })
})

describe('built bundles', () => {
  it('should_keep_preload_and_renderer_entry_beside_the_built_main_entry', () => {
    expect(existsSync(resolvePreloadFile('index.cjs', ROOT))).toBe(true)
    expect(existsSync(resolvePreloadFile('notification.cjs', ROOT))).toBe(true)
    expect(existsSync(resolveRendererHtml(ROOT))).toBe(true)
    expect(existsSync(resolveMainOutDir(ROOT))).toBe(true)
  })
})

describe('no asset path may ride on __dirname', () => {
  // 主进程 chunk 化后 __dirname 指向 out/main/chunks，凡是用它拼相对路径都会少一层。
  // 这条守卫让下一个人不必再踩一次白屏。
  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        if (name === '__tests__') continue
        sourceFiles(full, out)
        continue
      }
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue
      out.push(full)
    }
    return out
  }

  it('should_not_join___dirname_with_a_relative_parent', () => {
    const offenders = sourceFiles(join(ROOT, 'src', 'main'))
      .filter((file) => {
        const code = readFileSync(file, 'utf-8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '')
        return /__dirname\s*,\s*['"]\.\.?\//.test(code)
      })
      .map((file) => file.slice(ROOT.length + 1))

    expect(offenders).toEqual([])
  })
})
