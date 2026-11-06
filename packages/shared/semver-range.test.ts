import { describe, expect, it } from 'vitest'
import { satisfiesHostRange } from './semver-range'

describe('satisfiesHostRange', () => {
  const host = '1.4.2'

  it('精确版本与缺省组件', () => {
    expect(satisfiesHostRange(host, '1.4.2')).toBe(true)
    expect(satisfiesHostRange(host, '1.4.3')).toBe(false)
    expect(satisfiesHostRange(host, '1.4')).toBe(true)
    expect(satisfiesHostRange(host, 'v1.4.2')).toBe(true)
  })

  it('比较符', () => {
    expect(satisfiesHostRange(host, '>=1.4.0')).toBe(true)
    expect(satisfiesHostRange(host, '>=1.4.3')).toBe(false)
    expect(satisfiesHostRange(host, '>1.4.1')).toBe(true)
    expect(satisfiesHostRange(host, '<2.0.0')).toBe(true)
    expect(satisfiesHostRange(host, '<=1.4.2')).toBe(true)
    expect(satisfiesHostRange(host, '=1.4.2')).toBe(true)
  })

  it('^ 与 ~', () => {
    expect(satisfiesHostRange(host, '^1.0.0')).toBe(true)
    expect(satisfiesHostRange(host, '^1.4.2')).toBe(true)
    expect(satisfiesHostRange(host, '^1.5.0')).toBe(false)
    expect(satisfiesHostRange(host, '^2.0.0')).toBe(false)
    expect(satisfiesHostRange(host, '~1.4.0')).toBe(true)
    expect(satisfiesHostRange(host, '~1.5.0')).toBe(false)
    // 0.x：^0.2.3 收在 0.2.x 内（npm 语义）
    expect(satisfiesHostRange('0.2.9', '^0.2.3')).toBe(true)
    expect(satisfiesHostRange('0.3.0', '^0.2.3')).toBe(false)
  })

  it('通配', () => {
    expect(satisfiesHostRange(host, '*')).toBe(true)
    expect(satisfiesHostRange(host, '1.x')).toBe(true)
    expect(satisfiesHostRange(host, '1.4.x')).toBe(true)
    expect(satisfiesHostRange(host, '2.x')).toBe(false)
  })

  it('AND 组合与 ||', () => {
    expect(satisfiesHostRange(host, '>=1.0.0 <2.0.0')).toBe(true)
    expect(satisfiesHostRange(host, '>=1.0.0 <1.4.0')).toBe(false)
    expect(satisfiesHostRange(host, '<1.0.0 || >=1.4.0')).toBe(true)
    expect(satisfiesHostRange(host, '<1.0.0 || >=2.0.0')).toBe(false)
  })

  it('语法不合法时放行（fail open），host 版本解析失败也放行', () => {
    expect(satisfiesHostRange(host, 'latest!!!')).toBe(true)
    expect(satisfiesHostRange(host, '>=1.x-beta..')).toBe(true)
    expect(satisfiesHostRange(host, '')).toBe(true)
    expect(satisfiesHostRange('dev', '>=1.0.0')).toBe(true)
    expect(satisfiesHostRange('dev', '>=99.0.0')).toBe(true)
  })

  it('prerelease 按更小处理', () => {
    expect(satisfiesHostRange('1.4.2-beta.1', '>=1.4.2')).toBe(false)
    expect(satisfiesHostRange('1.4.2-beta.1', '>=1.4.1')).toBe(true)
  })
})
