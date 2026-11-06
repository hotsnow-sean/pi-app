// @ts-check
/**
 * shell 选择与启动参数拼装。
 *
 * 关键约束：**默认 shell 必须与内置 bash 工具一致**（Git Bash）。模型是按 bash
 * 语法写命令的，cmd 会把 `$i`、`$(seq)` 当普通文本吃掉、退出码却是 0——这种
 * 假成功比报错危险得多，所以宁可拒绝（assertCmdCompatible）。
 *
 * 输出重定向一律交给 shell：Electron 主进程在 Windows 上不给子进程继承句柄，
 * 直接传文件 fd 会得到「进程在跑但日志永远为空」。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// 插件内模块一律走 imp() 动态加载并透传 ?v=（见 main.mjs 顶部）：静态 import 解析
// 相对路径时会丢掉 query，热重载会命中旧模块缓存。import.meta.url 自带本次激活的
// v，链条从入口自然向下传，每个模块都拿到同一代。
import { pathToFileURL } from 'node:url'
import { join as joinPath } from 'node:path'
// 版本参数从自己的 URL 上摘下来往下传；不用 new URL 做相对解析——
// jsdom 测试环境会给 URL 构造器打补丁，相对解析会落到 document.baseURI 上
const Q = import.meta.url.includes('?') ? `?${import.meta.url.split('?')[1]}` : ''
const imp = (name) => import(pathToFileURL(joinPath(import.meta.dirname, `${name}.mjs`)).href + Q)
const { rt } = await imp('runtime')

/** 声明过的 shell 取值：schema 里的 enum 必须与它一致（守门在 main.test.mjs） */
const SHELLS = ['auto', 'bash', 'cmd', 'powershell']

/** Windows 上 Git Bash 的常见落点：PATH 里通常只有 git.exe，bash.exe 得自己找 */
const WIN_BASH_CANDIDATES = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Programs\\Git\\bin\\bash.exe'),
]

let cachedBash

export function findBash() {
  if (cachedBash !== undefined) return cachedBash
  if (process.platform !== 'win32') {
    cachedBash = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh'
    return cachedBash
  }
  for (const candidate of WIN_BASH_CANDIDATES) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        cachedBash = candidate
        return cachedBash
      }
    } catch {
      /* 路径不可读当作不存在 */
    }
  }
  try {
    const res = spawnSync('where', ['bash.exe'], { windowsHide: true, encoding: 'utf8' })
    const first = String(res.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)[0]
    if (res.status === 0 && first && fs.existsSync(first)) {
      cachedBash = first
      return cachedBash
    }
  } catch {
    /* where 不可用就算了 */
  }
  cachedBash = null
  return cachedBash
}

/**
 * bash 语法哨兵。
 *
 * 这是对「假成功」的兜底：cmd 会把 `$i`、`$(seq 1 3)` 这类 bash 语法当普通文本吃掉，
 * 命令照跑、退出码 0，调用方会得出完全相反的结论。与其在 cmd 下静默变形，不如直接拒绝。
 */
const BASH_ONLY_SYNTAX = [
  { re: /\$\(/, what: '$( ) 命令替换' },
  { re: /\$\{/, what: '${ } 变量展开' },
  { re: /(?:^|[\n;&|(])\s*for\s+\w+\s+in\s/, what: 'for … in 循环' },
  { re: /(?:^|[\n;&|(])\s*export\s+\w+=/, what: 'export 赋值' },
  { re: /\[\[\s/, what: '[[ ]] 条件判断' },
]

function assertCmdCompatible(command) {
  for (const { re, what } of BASH_ONLY_SYNTAX) {
    if (re.test(command)) {
      throw new Error(
        `命令里含 bash 语法（${what}），但当前 shell 是 cmd：cmd 会把它当普通文本吃掉，` +
          `命令看似成功其实没按预期执行。请传 shell:'bash' 重试，或改写成 cmd 语法。`,
      )
    }
  }
}

function bashQuote(p) {
  return `'${String(p).replace(/'/g, `'\\''`)}'`
}

/**
 * 命令 → 实际启动参数。
 *
 * stdout 与 stderr 分成两个文件：失败时只需读几百字节的 stderr，不必在几万行
 * 正常输出里翻错误。两者都用 >> 追加，文件预先建空，等价于覆盖。
 *
 * pidfile（只有 Windows 的 bash 分支写）：`echo $$` 落盘的 msys pid 同时就是
 * MSYS 的进程组 id，停止时要靠它 `kill -9 -<pgid>` 收整组——Windows 的
 * taskkill /T 在 MSYS 树上杀不到最内层（见 tasks.mjs stopTask 的注释）。
 */
export function buildSpawnSpec({ command, logPath, errPath, pidPath, requestedShell, id }) {
  const want = String(requestedShell || 'auto').toLowerCase()
  // shell 参数是模型给的：schema 只是建议，写个别的值进来不能让它在两个平台
  // 各自静默落到某个默认 shell 上——那正是 assertCmdCompatible 要防的假成功
  if (!SHELLS.includes(want)) {
    throw new Error(`不认识的 shell：${requestedShell}（可选 ${SHELLS.join(' / ')}）`)
  }

  if (process.platform !== 'win32') {
    // cmd / powershell 是 Windows 专属：在 POSIX 上悄悄跑 /bin/sh，「指定了 shell」
    // 这件事就成了假的——调用方会拿 sh 的结果当成 cmd 的结果
    if (want === 'cmd' || want === 'powershell') {
      throw new Error(`shell:'${want}' 只有 Windows 支持。当前是 ${process.platform}，用默认的 bash（shell:'auto'）即可。`)
    }
    const file = want === 'bash' ? findBash() : '/bin/sh'
    return {
      kind: want === 'bash' ? 'bash' : 'sh',
      file: file || '/bin/sh',
      args: ['-c', `(${command}) >> ${bashQuote(logPath)} 2>> ${bashQuote(errPath)}`],
      line: null,
      // POSIX 上必须 detached：非 detached 的子进程留在宿主的进程组里，
      // `kill(-pid)` 根本指不到它（pid ≠ pgid），收整组只能靠 setsid
      detached: true,
      pidFile: null,
    }
  }

  if (want === 'powershell') {
    // 脚本文件 + 由 cmd 重定向：PowerShell 自己 `*>` 到文件默认 UTF-16，日志会变乱码
    const scriptPath = path.join(rt.scriptDir, `${id}.ps1`)
    fs.writeFileSync(
      scriptPath,
      `$ErrorActionPreference = 'Continue'\n[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n& {\n${command}\n}\n`,
      'utf8',
    )
    return {
      kind: 'powershell',
      file: null,
      args: null,
      line: `chcp 65001>nul & powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}" >> "${logPath}" 2>> "${errPath}"`,
      // 原生 Windows 进程树的父链是完整的，taskkill /T 就够，不需要 pidfile
      detached: false,
      pidFile: null,
    }
  }

  if (want === 'cmd') {
    assertCmdCompatible(command)
    return {
      kind: 'cmd',
      file: null,
      args: null,
      line: `chcp 65001>nul & (${command}) >> "${logPath}" 2>> "${errPath}"`,
      detached: false,
      pidFile: null,
    }
  }

  const bash = findBash()
  if (want === 'bash' && !bash) {
    throw new Error("找不到 bash（Git Bash 未安装或不在常见路径）。改用 shell:'cmd'，或先装 Git for Windows。")
  }
  if (bash) {
    // `echo $$` 先落 pidfile 再跑命令：MSYS 上 $$ 就是进程组 id（实测 PGID == PID），
    // 停止时靠它整组收。用 `;` 而不是 `&&`——pidfile 写不成不该拖累任务本身。
    // 刻意不 detached：Electron 主进程里 detached 子进程会「起了但从不退出」，
    // Windows 这一侧只能走 MSYS 组杀（见 tasks.mjs stopTask）
    return {
      kind: 'bash',
      file: bash,
      args: [
        '-c',
        `${pidPath ? `echo $$ > ${bashQuote(pidPath)}; ` : ''}(${command}) >> ${bashQuote(logPath)} 2>> ${bashQuote(errPath)}`,
      ],
      line: null,
      detached: false,
      pidFile: pidPath || null,
    }
  }
  // 没有 bash 才回落 cmd：此时必须拦住 bash 语法，避免静默错执行
  assertCmdCompatible(command)
  return {
    kind: 'cmd',
    file: null,
    args: null,
    line: `chcp 65001>nul & (${command}) >> "${logPath}" 2>> "${errPath}"`,
    detached: false,
    pidFile: null,
  }
}
