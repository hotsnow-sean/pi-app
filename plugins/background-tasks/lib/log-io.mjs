// @ts-check
/**
 * 日志文件 IO：增量读、尾部截取、行数统计。
 *
 * 只认 task 对象上记录的路径字段，不碰共享状态、不碰子进程——读日志的语义
 * （offset 省略 = 读尾部、传 0 = 从头读、64B 编码安全下限）全部收在这一层。
 */
import fsp from 'node:fs/promises'

export const READ_CHUNK_DEFAULT = 16 * 1024
export const READ_CHUNK_MAX = 256 * 1024
export const MIN_READ_BYTES = 64
/** bg_output 的协作式等待上限：只等「有新输出」，不等终态 */
export const MAX_OUTPUT_WAIT_MS = 30_000
/** bg_output / 回报不传 tailLines 时的默认尾部行数（tools 跨模块引用，必须导出） */
export const REPORT_TAIL_LINES = 20
const REPORT_MAX_CHARS = 8_000
const COUNT_LINES_MAX_BYTES = 20 * 1024 * 1024

/**
 * 解码一块字节，返回**实际消费了多少字节**。
 *
 * 多字节字符被截在 chunk 边界时会出替换符：退到最后一个换行，剩下的下次再读。
 * 关键：调用方的 nextOffset 必须按「实际消费」前进而不是「读了多少」——否则被
 * 退回去的那一段既不在本次文本里，也不会被下次读到，等于静默丢一整行。
 */
export function decode(buffer) {
  const text = buffer.toString('utf8')
  if (!text.includes('\uFFFD')) return { text, bytes: buffer.length }
  const cut = text.lastIndexOf('\n')
  if (cut > 0) {
    const kept = text.slice(0, cut + 1)
    return { text: kept, bytes: Buffer.byteLength(kept, 'utf8') }
  }
  // 整块就一行、且末尾字符被切断：摘掉尾部的替换符，让残缺字符下次重读。
  // 全块都是残字（极端）时只能全消费，否则调用方会卡在同一个 offset 上。
  const kept = text.replace(/\uFFFD+$/, '')
  const bytes = Buffer.byteLength(kept, 'utf8')
  return bytes > 0 ? { text: kept, bytes } : { text, bytes: buffer.length }
}

/** stdout 与 stderr 分别落盘：失败细节通常只在后者里，混在一起就得整份翻 */
export function logPathFor(task, stream) {
  return stream === 'err' ? task.errPath || '' : task.logPath
}

/**
 * 增量读日志。`offset` 省略 = 读尾部窗口（默认行为）；给了就从该字节位置往后读。
 *
 * 四个参数全部可选，但**含义不同**：省略 offset 是「读最后一段」，传 0 是「从头读」。
 * 这个区别靠 JSDoc 写清楚——以前没标注，TS 把四个都当成必填，`tailOf` 那种只传
 * 三个的调用在类型检查下直接报错（是真错：漏传不等于不传）。
 *
 * @param {any} task
 * @param {{ offset?: number | null, maxBytes?: number, tailLines?: number, stream?: 'out' | 'err' }} opts
 */
export async function readLog(task, { offset, maxBytes, tailLines, stream }) {
  const file = logPathFor(task, stream)
  if (!file) {
    return { id: task.id, status: task.status, running: task.status === 'running', exitCode: task.exitCode ?? null, chunk: '', chunkBytes: 0, nextOffset: 0, totalBytes: 0, hasMore: false, truncated: false, stream: stream === 'err' ? 'err' : 'out' }
  }
  const size = await fsp
    .stat(file)
    .then((s) => s.size)
    .catch(() => 0)
  // 64B 是编码安全的下限（够放一个多字节字符），不再有 1KB 的隐式抬升
  const requested = Number(maxBytes) || READ_CHUNK_DEFAULT
  const cap = Math.min(Math.max(requested, MIN_READ_BYTES), READ_CHUNK_MAX)
  const fromEnd = offset === undefined || offset === null
  const start = fromEnd ? Math.max(0, size - cap) : Math.min(Math.max(0, Number(offset) || 0), size)
  const end = fromEnd ? size : Math.min(size, start + cap)
  const out = {
    id: task.id,
    status: task.status,
    running: task.status === 'running',
    exitCode: task.exitCode ?? null,
    chunk: '',
    chunkBytes: 0,
    nextOffset: start,
    totalBytes: size,
    hasMore: false,
    truncated: false,
    stream: stream === 'err' ? 'err' : 'out',
    requestedMaxBytes: requested,
    /** 实际生效的切片大小：被上下限夹过时与请求值不同，调用方不该猜 */
    effectiveMaxBytes: cap,
  }
  if (end <= start) return out
  let handle = null
  try {
    handle = await fsp.open(file, 'r')
    const buf = Buffer.alloc(end - start)
    const { bytesRead } = await handle.read(buf, 0, buf.length, start)
    const decoded = decode(buf.subarray(0, bytesRead))
    out.chunk = decoded.text
    // 一律按「实际消费」的字节推进：decode 可能为了避开半个多字节字符而退回一段，
    // 此时用 bytesRead 当前进量，那段就既不在本次文本里也再读不到（静默丢行）
    out.chunkBytes = decoded.bytes
    out.nextOffset = start + decoded.bytes
    out.hasMore = out.nextOffset < size
    out.truncated = decoded.bytes < end - start
    const want = Number(tailLines)
    if (fromEnd && want > 0) {
      const lines = out.chunk.split('\n')
      // 日志每行都以 \n 结尾，split 后末尾多一个空串——不摘掉它，
      // tailLines 就永远少一行（传 1 直接拿到空串 =「没有输出」）
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
      const kept = lines.slice(Math.max(0, lines.length - Math.min(want, 500)))
      out.chunk = kept.join('\n')
      // tail 截取后 chunk 不再是整段切片：chunkBytes 必须跟着实际返回的字节数走，
      // 否则按它做进度/校验的程序会拿到整个日志的大小
      out.chunkBytes = Buffer.byteLength(out.chunk, 'utf8')
      out.truncated = true
    }
  } catch {
    /* 日志还没建出来（spawn 立刻失败）：返回空 chunk，状态字段仍然有用 */
  } finally {
    await handle?.close().catch(() => {})
  }
  return out
}

export async function tailOf(task, stream) {
  const res = await readLog(task, { tailLines: REPORT_TAIL_LINES, maxBytes: 32 * 1024, stream })
  const text = res.chunk.trim()
  return text.length > REPORT_MAX_CHARS ? `${text.slice(0, REPORT_MAX_CHARS)}\n…（已截断）` : text
}

export async function countLines(task, stream) {
  const file = logPathFor(task, stream)
  if (!file) return null
  try {
    const size = await fsp.stat(file).then((s) => s.size)
    if (size > COUNT_LINES_MAX_BYTES) return null
    const text = await fsp.readFile(file, 'utf8')
    if (!text) return 0
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
  } catch {
    return null
  }
}
