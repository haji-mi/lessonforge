/**
 * 守卫式 ZIP 条目解压（架构基线 §4.2）。
 *
 * - 输入分片（默认 64KB）从 Blob 逐片读取喂入 fflate 同步 Inflate。
 * - 预算检查在 ondata 回调内（实际产出计数），超限即停止喂入并丢弃引用。
 * - 解压完成后 CRC-32 / 实际尺寸 对拍中央目录声明值。
 * - 内存模型（spike 证明前不构成安全保证）：
 *   输入侧 O(分片)；单次 push 瞬态 ≈ 分片 × DEFLATE 理论最大压缩比(~1032:1)；
 *   保留输出 ≤ 单条目预算。
 */
import { Inflate } from 'fflate'
import { crc32 } from './crc32'

export interface ZipLimits {
  /** 单条目实际输出预算（字节） */
  entryBudget: number
  /** 整档累计实际输出预算（字节） */
  totalBudget: number
  /** 每次喂入的压缩数据分片（字节） */
  inputChunk: number
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  entryBudget: 50 * 1024 * 1024,
  totalBudget: 300 * 1024 * 1024,
  /**
   * P1b spike 实测（docs/spike-p1.md，node --expose-gc 精确测量）：
   * - fflate 同步 Inflate 每次 push() 发射该次产生的全部输出：maxChunk ≈ 分片 × 膨胀比（≤1032:1）
   * - 峰值（heap+external）≈ 5 × maxChunk（内部缓冲倍增 + 发射拷贝）
   * - 峰值与炸弹总膨胀量无关，只随分片大小缩放：4KB 分片 ⇒ 峰值恒 ≈20MB
   */
  inputChunk: 4 * 1024,
}

export type InflateErrorCode =
  'BUDGET_EXCEEDED' | 'CRC_MISMATCH' | 'SIZE_MISMATCH' | 'TRUNCATED_OR_CORRUPT'

export interface InflateStats {
  maxChunkSeen: number
  chunkCount: number
  actualSize: number
  pushCount: number
  /** 预算超限判定到函数返回的耗时（ms），仅中止时有意义 */
  abortDelayMs: number | undefined
  /** ondata 回调期间采样到的堆增量峰值（spike 用） */
  peakHeapDelta: number | undefined
}

export interface InflateOutcome {
  ok: boolean
  data?: Uint8Array
  code?: InflateErrorCode
  /** 预算超限的作用域：entry=单条目超限（跳过该条目继续）；total=整档累计超限（终止后续条目） */
  budgetScope?: 'entry' | 'total'
  stats: InflateStats
}

export interface InflateBudget {
  total: number
}

async function readRange(blob: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer())
}

function measureHeap(): number {
  // Node：heapUsed 不含 ArrayBuffer 外部内存，必须加 external（浏览器中无 process → 返回 0，不采样）
  const m = (globalThis as any).process?.memoryUsage?.()
  return m ? m.heapUsed + m.external : 0
}

export async function inflateEntryFromBlob(
  blob: Blob,
  dataStart: number,
  compSize: number,
  expected: { crc32: number; uncompSize: number },
  limits: ZipLimits,
  budget: InflateBudget,
): Promise<InflateOutcome> {
  const inf = new Inflate()
  const parts: Uint8Array[] = []
  let total = 0
  let maxChunk = 0
  let chunkCount = 0
  let pushCount = 0
  let aborted = false
  let abortScope: 'entry' | 'total' = 'entry'
  let corrupt = false
  let abortAt = 0
  const heapBase = measureHeap()
  let peakHeap = 0

  inf.ondata = (chunk: Uint8Array) => {
    chunkCount++
    if (chunk.length > maxChunk) maxChunk = chunk.length
    if (!aborted) {
      parts.push(chunk)
      total += chunk.length
      const h = measureHeap()
      if (h > 0 && heapBase > 0) peakHeap = Math.max(peakHeap, h - heapBase)
    }
    if (!aborted && total > limits.entryBudget) {
      aborted = true
      abortScope = 'entry'
      abortAt = performance.now()
      parts.length = 0
      total = 0
    } else if (!aborted && budget.total + total > limits.totalBudget) {
      aborted = true
      abortScope = 'total'
      abortAt = performance.now()
      parts.length = 0
      total = 0
    }
  }

  try {
    for (let off = 0; off < compSize && !aborted; off += limits.inputChunk) {
      pushCount++
      const end = Math.min(off + limits.inputChunk, compSize)
      const buf = await readRange(blob, dataStart + off, dataStart + end)
      inf.push(buf, end >= compSize)
    }
  } catch {
    corrupt = true
    parts.length = 0
  }

  const stats: InflateStats = {
    maxChunkSeen: maxChunk,
    chunkCount,
    actualSize: aborted ? 0 : total,
    pushCount,
    abortDelayMs: aborted ? performance.now() - abortAt : undefined,
    peakHeapDelta: heapBase > 0 ? peakHeap : undefined,
  }

  if (aborted) return { ok: false, code: 'BUDGET_EXCEEDED', budgetScope: abortScope, stats }
  if (corrupt) return { ok: false, code: 'TRUNCATED_OR_CORRUPT', stats }
  if (total === 0 && compSize > 0 && expected.uncompSize > 0 && parts.length === 0) {
    return { ok: false, code: 'TRUNCATED_OR_CORRUPT', stats }
  }
  const data = new Uint8Array(total)
  let p = 0
  for (const part of parts) {
    data.set(part, p)
    p += part.length
  }
  if (data.length !== expected.uncompSize) return { ok: false, code: 'SIZE_MISMATCH', stats }
  if (crc32(data) !== expected.crc32) return { ok: false, code: 'CRC_MISMATCH', stats }
  budget.total += data.length
  return { ok: true, data, stats }
}

/** Stored（方法 0）条目：零膨胀，天然有界 */
export async function readStoredEntry(
  blob: Blob,
  dataStart: number,
  compSize: number,
  expected: { crc32: number; uncompSize: number },
  limits: ZipLimits,
  budget: InflateBudget,
): Promise<InflateOutcome> {
  const stats: InflateStats = {
    maxChunkSeen: 0,
    chunkCount: 0,
    actualSize: compSize,
    pushCount: 0,
    abortDelayMs: undefined,
    peakHeapDelta: undefined,
  }
  if (compSize !== expected.uncompSize) return { ok: false, code: 'SIZE_MISMATCH', stats }
  if (compSize > limits.entryBudget) {
    return { ok: false, code: 'BUDGET_EXCEEDED', budgetScope: 'entry', stats }
  }
  if (budget.total + compSize > limits.totalBudget) {
    return { ok: false, code: 'BUDGET_EXCEEDED', budgetScope: 'total', stats }
  }
  const data = await readRange(blob, dataStart, dataStart + compSize)
  stats.maxChunkSeen = compSize
  stats.chunkCount = 1
  if (crc32(data) !== expected.crc32) return { ok: false, code: 'CRC_MISMATCH', stats }
  budget.total += compSize
  return { ok: true, data, stats }
}
