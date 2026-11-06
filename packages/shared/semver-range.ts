/**
 * 精简版 semver range 匹配 —— 只为插件 manifest 的 `engines['pi-desktop']` 服务。
 *
 * 不引入 semver 包：仓库没有直接依赖先例，而插件宿主需要的语法子集很小。
 * 支持（与 npm engines 字段的常见写法对齐）：
 *   - 精确版本：`1.2.3`
 *   - 比较符：`>=1.2.0`、`>1.0.0`、`<=2.0.0`、`<2.0.0`、`=1.2.3`；
 *     比较符与版本号之间允许空格（`>= 1.4.0`）
 *   - 脱字符/波浪号：`^1.2.3`（同主版本内）、`~1.2.3`（同主次版本内）、`~1`（≙ `1.x`）
 *   - 通配与缺省组件：`1.x`、`1.4.x`、`*`；`1.4` 作为 range ≙ `1.4.x`（npm 语义）；
 *     比较符下的缺省/通配组件按 npm 部分区语义展开
 *     （`>1.4` ≙ `>=1.5.0`、`<=1.4` ≙ `<1.5.0`、`<1.x` ≙ `<1.0.0`、`<=1.4.x` ≙ `<1.5.0`）
 *   - 连字符区间：`1.4.0 - 2.0.0` ≙ `>=1.4.0 <=2.0.0`（端点两侧必须带空格——
 *     无空格的 `1.4.0-2.0.0` 在 npm 语义里是「带 prerelease 的版本」，不是区间）
 *   - 组合：空格 = AND，`||` = OR
 *
 * prerelease：宿主版本带 prerelease 按更小处理（semver 语义）；range 目标带
 * prerelease 只在写全三位时参与比较。精细的 prerelease 排除规则不支持——
 * 插件 engines 用到这种写法的概率极低，出错方向是「宽松」而非「误拒」。
 */

type Triple = [number, number, number, string?]

function parseVersion(input: string): Triple | null {
  const s = input.trim().replace(/^[vV]/, '')
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/.exec(s)
  if (!m) return null
  return [Number(m[1] ?? 0), Number(m[2] ?? 0), Number(m[3] ?? 0), m[4]]
}

function compareTriple(a: Triple, b: Triple): number {
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  // 数值部分相等：有 prerelease 的版本更小（semver 语义）
  if (a[3] && b[3]) return a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : 0
  if (a[3]) return -1
  if (b[3]) return 1
  return 0
}

const BARE_OPS = ['>=', '<=', '>', '<', '=', '^', '~']

/** 解析单个比较子的版本主体（已去掉操作符），返回声明到的组件位数与各分量 */
function parseComparatorBody(raw: string):
  | { precision: 0 | 1 | 2 | 3; major: number; minor: number; patch: number; prerelease?: string }
  | null {
  const s = raw.trim().replace(/^[vV]/, '')
  const m = /^(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?$/.exec(s)
  // 语法不合法 → 调用方放行：engines 是作者的自我声明，解析失败不该把整个插件判死，
  // 明确的拒绝只留给「能解析且确实不满足」的路径
  if (!m) return null
  const isWildcard = (p: string | undefined) => p === undefined || p === '*' || p === 'x' || p === 'X'
  const num = (p: string | undefined): number | null => {
    if (p === undefined || isWildcard(p)) return 0
    const n = Number(p)
    return Number.isInteger(n) ? n : null
  }

  // precision = 声明到的组件位数（第一个通配/缺省位截断）。
  // `1.4` 与 `1.4.x` 同为 precision 2——npm 语义里两者等价
  let precision: 0 | 1 | 2 | 3 = 3
  if (isWildcard(m[1])) precision = 0
  else if (isWildcard(m[2])) precision = 1
  else if (isWildcard(m[3])) precision = 2

  const major = num(m[1])
  if (major === null) return null // 通配写法里混了垃圾 → fail open
  const minor = num(m[2])
  if (minor === null) return null
  const patch = num(m[3])
  if (patch === null) return null

  // prerelease 只在写全三位时参与比较（部分版本上的 prerelease 语义太含糊，直接忽略）
  const prerelease = precision === 3 ? m[4] : undefined
  return { precision, major, minor, patch, prerelease }
}

/** 单个比较子是否满足操作符约束 */
function matchComparator(version: Triple, op: string, raw: string): boolean {
  const body = parseComparatorBody(raw)
  if (!body) return true
  const { precision, major, minor, patch, prerelease } = body

  // 主版本通配：`*` 与 `>=*` / `<=*` 等价于「任何版本」；`>*` / `<*` 在 npm 里无匹配
  if (precision === 0) return !(op === '>' || op === '<')

  const base: Triple = [major, minor, patch, prerelease]
  /** 第 pos 位 +1、其后清零 —— npm 部分区语义的排他上界 */
  const nextAt = (pos: number): Triple => {
    if (pos <= 0) return [major + 1, 0, 0]
    if (pos === 1) return [major, minor + 1, 0]
    return [major, minor, patch + 1]
  }

  if (op === '' || op === '=') {
    // x-range / 缺省组件：`1.4` ≙ `1.4.x`，只比对声明到的位
    if (version[0] !== major) return false
    if (precision === 1) return true
    if (version[1] !== minor) return false
    if (precision === 2) return true
    return compareTriple(version, base) === 0
  }

  const cLow = compareTriple(version, base)
  switch (op) {
    case '>=':
      return cLow >= 0
    case '>':
      // `>1.4` ≙ `>=1.5.0`，`>1.4.2` 才是严格大于
      return precision === 3 ? cLow > 0 : compareTriple(version, nextAt(precision - 1)) >= 0
    case '<':
      return cLow < 0
    case '<=':
      // `<=1.4` ≙ `<1.5.0`，`<=1.4.2` 才是含端点
      return precision === 3 ? cLow <= 0 : compareTriple(version, nextAt(precision - 1)) < 0
    case '^': {
      if (cLow < 0) return false
      // 同主版本内；0.x 按 0.x.y 收窄；^0.0.x 锁补丁位（与 npm 语义一致）
      let upper: Triple
      if (precision === 1 || major > 0) upper = nextAt(0)
      else if (precision === 2 || minor > 0) upper = nextAt(1)
      else upper = nextAt(2)
      return compareTriple(version, upper) < 0
    }
    case '~': {
      if (cLow < 0) return false
      // ~1 ≙ 1.x；~1.2 / ~1.2.3 收在 1.2.x 内
      const upper = precision === 1 ? nextAt(0) : nextAt(1)
      return compareTriple(version, upper) < 0
    }
    default:
      // 未知操作符 → fail open
      return true
  }
}

/** npm 允许作为连字符区间端点的写法（全/部分版本，可带 prerelease） */
const HYPHEN_ENDPOINT = /^[vV]?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?$/

/** 解析一个 AND 组（空格分隔），全部满足才算满足 */
function matchAndGroup(version: Triple, group: string): boolean {
  const tokens = group.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return false
  const merged: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '-') {
      // 连字符区间 `1.4.0 - 2.0.0` ≙ `>=1.4.0 <=2.0.0`。npm 只认带空格的写法
      // （无空格是 prerelease 版本），这里同样只处理带空格的。任一侧不是
      // 版本号 → 整组 fail open：区间语法没解析成功不该判死插件
      const lo = merged.pop()
      const hi = i + 1 < tokens.length ? tokens[i + 1] : undefined
      if (!lo || !hi || !HYPHEN_ENDPOINT.test(lo) || !HYPHEN_ENDPOINT.test(hi)) return true
      merged.push(`>=${lo}`)
      merged.push(`<=${hi}`)
      i++
      continue
    }
    if ((BARE_OPS as string[]).includes(t) && i + 1 < tokens.length) {
      merged.push(t + tokens[i + 1])
      i++
    } else {
      merged.push(t)
    }
  }
  return merged.every((token) => {
    const m = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(token)
    if (!m) return false
    return matchComparator(version, m[1] ?? '', m[2])
  })
}

/**
 * host 版本是否满足 range。语法不合法时**放行**（fail open）：
 * engines 是作者的自我声明，解析失败不该把整个插件判死——
 * 拒绝激活留给明确的版本不满足路径。
 */
export function satisfiesHostRange(hostVersion: string, range: string): boolean {
  const version = parseVersion(hostVersion)
  if (!version) return true
  const trimmed = range.trim()
  if (!trimmed || trimmed === '*') return true
  const groups = trimmed.split('||')
  // `a ||` / `|| b` 这类不完整的 OR 语法 → fail open
  if (groups.some((g) => !g.trim())) return true
  return groups.some((group) => matchAndGroup(version, group))
}
