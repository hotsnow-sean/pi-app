/**
 * 精简版 semver range 匹配 —— 只为插件 manifest 的 `engines['pi-desktop']` 服务。
 *
 * 不引入 semver 包：仓库没有直接依赖先例，而插件宿主需要的语法子集很小。
 * 支持（与 npm engines 字段的常见写法对齐）：
 *   - 精确版本：`1.2.3`
 *   - 比较符：`>=1.2.0`、`>1.0.0`、`<=2.0.0`、`<2.0.0`、`=1.2.3`
 *   - 脱字符/波浪号：`^1.2.3`（同主版本内）、`~1.2.3`（同主次版本内）
 *   - 通配：`1.x`、`1.2.x`、`*`
 *   - 组合：空格 = AND，`||` = OR
 * 缺省组件按 0 处理（`1.2` ≙ `1.2.0`）。
 *
 * 不支持 prerelease/build 元数据的精细规则（`1.2.3-beta` 按字符串参与比较，
 * 但插件 engines 用到这种写法的概率极低，出错方向是「宽松」而非「误拒」）。
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

/** 单个比较子（已去掉操作符）是否满足操作符约束 */
function matchComparator(version: Triple, op: string, raw: string): boolean {
  const parts = raw.split('.')
  const isWildcard = (p: string | undefined) => p === '*' || p === 'x' || p === 'X'
  const exactLike = op === '' || op === '='

  // X-range：`*`、`1.x`、`1.4.x`，以及精确匹配下组件缺省的 `1` / `1.4`
  // （npm 语义里 `1.4` 作为 range 等价于 `1.4.x`，不是 `1.4.0` 的精确匹配）
  let precision = -1
  if (isWildcard(parts[0])) precision = 0
  else if (parts.length > 1 && isWildcard(parts[1])) precision = 1
  else if (parts.length > 2 && isWildcard(parts[2])) precision = 2
  else if (exactLike && parts.length < 3) precision = parts.length - 1

  if (precision === 0) return true
  if (precision === 1 || precision === 2) {
    const major = Number(parts[0])
    if (!Number.isInteger(major)) return true // 通配写法里混了垃圾 → fail open
    if (version[0] !== major) return false
    if (precision === 1) return true
    const minor = Number(parts[1])
    if (!Number.isInteger(minor)) return true
    return version[1] === minor
  }

  const target = parseVersion(raw)
  // 语法不合法 → 放行：engines 是作者的自我声明，解析失败不该把整个插件判死，
  // 明确的拒绝只留给「能解析且确实不满足」的路径
  if (!target) return true
  const c = compareTriple(version, target)
  switch (op) {
    case '>=':
      return c >= 0
    case '>':
      return c > 0
    case '<=':
      return c <= 0
    case '<':
      return c < 0
    case '=':
      return c === 0
    case '^': {
      // 同主版本内（0.x 按 0.x.y 同次版本内 —— 与 npm 语义一致）
      if (version[0] !== target[0]) return false
      if (target[0] > 0) return c >= 0
      if (version[1] !== target[1]) return false
      return c >= 0
    }
    case '~': {
      if (version[0] !== target[0]) return false
      if (version[1] !== target[1]) return false
      return c >= 0
    }
    default:
      // 无操作符 = 精确匹配
      return c === 0
  }
}

/** 解析一个 AND 组（空格分隔），全部满足才算满足 */
function matchAndGroup(version: Triple, group: string): boolean {
  const ops = group.trim().split(/\s+/).filter(Boolean)
  if (ops.length === 0) return false
  return ops.every((token) => {
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
  return trimmed.split('||').some((group) => matchAndGroup(version, group))
}
