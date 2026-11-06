import { describe, expect, it } from 'vitest'
import { join } from 'path'
import { appIconCandidates } from './app-icon'

describe('app icon paths', () => {
  it('prefers the packaged Windows ICO path shipped by electron-builder', () => {
    expect(appIconCandidates('win32', 'C:/app/resources', 'C:/app')[0]).toBe(
      join('C:/app/resources', 'build', 'icon.ico'),
    )
  })

  it('keeps the development Windows ICO path before PNG fallbacks', () => {
    expect(appIconCandidates('win32', 'C:/electron/resources', 'D:/pi')[1]).toBe(
      join('D:/pi', 'build', 'icon.ico'),
    )
  })

  it('does_not_look_inside_out_main_when_called_from_a_chunk', () => {
    // 主进程被拆成 out/main/chunks 后 __dirname 会指向 chunks，图标路径就少一层。
    const candidates = appIconCandidates('win32', 'C:/electron/resources', 'D:/pi')
    expect(candidates.some((path) => path.includes(join('out', 'main')))).toBe(false)
  })
})
