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

  it('缺省组件按 npm 语义：1.4 ≙ 1.4.x，1 ≙ 1.x（不是全匹配）', () => {
    expect(satisfiesHostRange('1.4.9', '1.4')).toBe(true)
    expect(satisfiesHostRange('1.5.0', '1.4')).toBe(false)
    expect(satisfiesHostRange('1.9.9', '1')).toBe(true)
    expect(satisfiesHostRange('2.0.0', '1')).toBe(false)
    expect(satisfiesHostRange('0.9.0', '1')).toBe(false)
    expect(satisfiesHostRange('1.5.0', '1.4.x')).toBe(false)
    expect(satisfiesHostRange('2.0.0', '1.x')).toBe(false)
  })

  it('比较符与版本号之间允许空格', () => {
    expect(satisfiesHostRange(host, '>= 1.4.0')).toBe(true)
    expect(satisfiesHostRange('1.5.0', '>= 1.4.0')).toBe(true)
    expect(satisfiesHostRange('1.3.0', '>= 1.4.0')).toBe(false)
    expect(satisfiesHostRange(host, '^ 1.0.0')).toBe(true)
    expect(satisfiesHostRange(host, '>=1.4.0 < 2.0.0')).toBe(true)
    expect(satisfiesHostRange(host, '>=1.5.0 < 2.0.0')).toBe(false)
  })

  it('比较符下的缺省/通配组件按 npm 部分区语义展开', () => {
    // <1.x ≙ <1.0.0；>1.x ≙ >=2.0.0；<=1.4.x ≙ <1.5.0
    expect(satisfiesHostRange(host, '<1.x')).toBe(false)
    expect(satisfiesHostRange('2.0.0', '>1.x')).toBe(true)
    expect(satisfiesHostRange('1.9.9', '<=1.4.x')).toBe(false)
    expect(satisfiesHostRange(host, '>=1.x')).toBe(true)
    // >1.4 ≙ >=1.5.0；<=1.4 ≙ <1.5.0；<1.4 ≙ <1.4.0
    expect(satisfiesHostRange('1.4.2', '<=1.4')).toBe(true)
    expect(satisfiesHostRange('1.4.5', '>1.4')).toBe(false)
    expect(satisfiesHostRange('1.5.0', '>1.4')).toBe(true)
    expect(satisfiesHostRange('1.4.2', '<1.4')).toBe(false)
    expect(satisfiesHostRange('1.3.9', '<1.4')).toBe(true)
  })

  it('^ 与 ~ 的缺省组件（~1 ≙ 1.x，^0 ≙ <1.0.0，^0.0.x 锁补丁位）', () => {
    expect(satisfiesHostRange('1.4.2', '~1')).toBe(true)
    expect(satisfiesHostRange('2.0.0', '~1')).toBe(false)
    expect(satisfiesHostRange('0.7.7', '^0')).toBe(true)
    expect(satisfiesHostRange('1.0.0', '^0')).toBe(false)
    expect(satisfiesHostRange('0.0.3', '^0.0.3')).toBe(true)
    expect(satisfiesHostRange('0.0.9', '^0.0.3')).toBe(false)
    expect(satisfiesHostRange('0.0.9', '^0.0')).toBe(true)
    expect(satisfiesHostRange('0.1.0', '^0.0')).toBe(false)
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
    // 不完整的 OR 语法同样 fail open
    expect(satisfiesHostRange(host, '||')).toBe(true)
    expect(satisfiesHostRange(host, '1.0.0 ||')).toBe(true)
    expect(satisfiesHostRange(host, '|| 1.0.0')).toBe(true)
    expect(satisfiesHostRange('dev', '>=1.0.0')).toBe(true)
    expect(satisfiesHostRange('dev', '>=99.0.0')).toBe(true)
  })

  it('连字符区间：1.4.0 - 2.0.0 ≙ >=1.4.0 <=2.0.0', () => {
    expect(satisfiesHostRange('1.4.2', '1.4.0 - 2.0.0')).toBe(true)
    expect(satisfiesHostRange('1.4.0', '1.4.0 - 2.0.0')).toBe(true)
    expect(satisfiesHostRange('2.0.0', '1.4.0 - 2.0.0')).toBe(true)
    expect(satisfiesHostRange('1.3.9', '1.4.0 - 2.0.0')).toBe(false)
    expect(satisfiesHostRange('2.0.1', '1.4.0 - 2.0.0')).toBe(false)
    // 与 AND / || 组合
    expect(satisfiesHostRange(host, '1.4.0 - 2.0.0 !=3.0.0')).toBe(true)
    expect(satisfiesHostRange(host, '2.4.0 - 3.0.0 || 1.4.0 - 1.5.0')).toBe(true)
    // 端点不是版本号 → 整组 fail open（宽松而非误拒）
    expect(satisfiesHostRange(host, '1.4.0 - latest')).toBe(true)
    expect(satisfiesHostRange(host, '>= 1.4.0 - 2.0.0')).toBe(true)
  })

  it('无空格的 1.4.0-2.0.0 在 npm 语义里是带 prerelease 的版本，不是区间', () => {
    expect(satisfiesHostRange('1.4.2', '1.4.0-2.0.0')).toBe(false)
    expect(satisfiesHostRange('1.4.0-2.0.0', '1.4.0-2.0.0')).toBe(true)
  })

  it('prerelease 按更小处理', () => {
    expect(satisfiesHostRange('1.4.2-beta.1', '>=1.4.2')).toBe(false)
    expect(satisfiesHostRange('1.4.2-beta.1', '>=1.4.1')).toBe(true)
  })
})
