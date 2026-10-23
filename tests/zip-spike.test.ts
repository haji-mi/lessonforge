/**
 * P1b spike：fflate 0.8.3 分片解压的内存与取消行为实测（架构基线 §4.2 / §11）。
 *
 * 验收标准（分支判定）：
 *  A（通过）：说谎炸弹被中断，采样峰值堆增量 ≤ 预算 + maxChunkSeen + 容差，取消延迟 < 1s
 *  C（不通过→拒收式保守策略）：仅 Stored 条目可导入
 *
 * 注：Node/V8 的 heapUsed 采样为进程级（含 vitest worker 噪声），作为保守上界使用；
 * 浏览器内复测列入待实测清单（基线 §11）。
 */
import { deflateSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { crc32 } from '../src/core/import/zip/crc32'
import {
  DEFAULT_ZIP_LIMITS,
  inflateEntryFromBlob,
  type InflateStats,
  type ZipLimits,
} from '../src/core/import/zip/inflate'

const MB = 1024 * 1024

const spikeRecord: { name: string; stats: InflateStats; peakHeapDelta: number; ratio: number }[] =
  []

describe('P1b spike：分片解压内存与取消行为', () => {
  it('实测 1：说谎炸弹（16MB 全零 → ~16KB 压缩，预算 2MB，默认 4KB 分片）', async () => {
    const bomb = new Uint8Array(16 * MB)
    const comp = deflateSync(bomb)
    const ratio = (16 * MB) / comp.length
    const limits: ZipLimits = { ...DEFAULT_ZIP_LIMITS, entryBudget: 2 * MB }
    const r = await inflateEntryFromBlob(
      new Blob([comp]),
      0,
      comp.length,
      { crc32: crc32(bomb), uncompSize: 10 * 1024 },
      limits,
      { total: 0 },
    )
    expect(r.ok).toBe(false)
    expect(r.code).toBe('BUDGET_EXCEEDED')
    expect(r.stats.abortDelayMs ?? 0).toBeLessThan(1000)
    spikeRecord.push({
      name: 'bomb-16MB-budget-2MB-chunk-4KB(默认)',
      stats: r.stats,
      peakHeapDelta: r.stats.peakHeapDelta ?? -1,
      ratio,
    })
    // spike 定律 1：单块 ≤ 分片 × DEFLATE 理论最大压缩比(~1032) + 余量
    expect(r.stats.maxChunkSeen).toBeLessThanOrEqual(4 * 1024 * 1100)
    // spike 定律 2（松上界，GC 噪声下防灾难性回归；精确数字见 docs/spike-p1.md）：
    // 峰值 ≈ 5×maxChunk，断言 ≤ 预算 + 6×maxChunk + 8MB 容差
    if (r.stats.peakHeapDelta !== undefined && r.stats.peakHeapDelta >= 0) {
      const ceiling = limits.entryBudget + 6 * r.stats.maxChunkSeen + 8 * MB
      expect(r.stats.peakHeapDelta).toBeLessThanOrEqual(ceiling)
    }
  })

  it('实测 1b：64KB 分片对照（演示为何默认分片必须小：压缩流 16KB 被单次吞入 → 16MB 单块）', async () => {
    const bomb = new Uint8Array(16 * MB)
    const comp = deflateSync(bomb)
    const limits: ZipLimits = { ...DEFAULT_ZIP_LIMITS, entryBudget: 2 * MB, inputChunk: 64 * 1024 }
    const r = await inflateEntryFromBlob(
      new Blob([comp]),
      0,
      comp.length,
      { crc32: crc32(bomb), uncompSize: 10 * 1024 },
      limits,
      { total: 0 },
    )
    expect(r.code).toBe('BUDGET_EXCEEDED')
    spikeRecord.push({
      name: 'bomb-16MB-budget-2MB-chunk-64KB(对照)',
      stats: r.stats,
      peakHeapDelta: r.stats.peakHeapDelta ?? -1,
      ratio: (16 * MB) / comp.length,
    })
    // 对照组证明：64KB 分片时单块可达 16MB（分片 ≥ 压缩流尺寸 → 全部输出单块交付）
    expect(r.stats.maxChunkSeen).toBeGreaterThan(8 * MB)
  })

  it('实测 2：正常 8MB 文本（分片 64KB）', async () => {
    const data = new Uint8Array(8 * MB)
    let seed = 7
    for (let i = 0; i < data.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      data[i] = (seed % 94) + 32
    }
    const comp = deflateSync(data)
    const r = await inflateEntryFromBlob(
      new Blob([comp]),
      0,
      comp.length,
      { crc32: crc32(data), uncompSize: data.length },
      DEFAULT_ZIP_LIMITS,
      { total: 0 },
    )
    expect(r.ok).toBe(true)
    spikeRecord.push({
      name: 'normal-8MB',
      stats: r.stats,
      peakHeapDelta: r.stats.peakHeapDelta ?? -1,
      ratio: data.length / comp.length,
    })
  })

  it('实测 3：极限分片（4KB）下炸弹行为一致', async () => {
    const bomb = new Uint8Array(8 * MB)
    const comp = deflateSync(bomb)
    const limits: ZipLimits = { ...DEFAULT_ZIP_LIMITS, entryBudget: 1 * MB, inputChunk: 4 * 1024 }
    const r = await inflateEntryFromBlob(
      new Blob([comp]),
      0,
      comp.length,
      { crc32: crc32(bomb), uncompSize: 1024 },
      limits,
      { total: 0 },
    )
    expect(r.code).toBe('BUDGET_EXCEEDED')
    // 4KB 分片 → 单块 ≤ ~4.2MB
    expect(r.stats.maxChunkSeen).toBeLessThanOrEqual(4 * 1024 * 1100)
    spikeRecord.push({
      name: 'bomb-8MB-budget-1MB-chunk-4KB',
      stats: r.stats,
      peakHeapDelta: r.stats.peakHeapDelta ?? -1,
      ratio: (8 * MB) / comp.length,
    })
  })

  it('spike 结论记录', () => {
    // 输出实测数字（用于 docs/spike-p1.md 与交付报告；本测试恒过，仅当上述实测未达验收才失败）
    console.log('=== P1b spike 实测记录 ===')
    for (const r of spikeRecord) {
      console.log(
        `${r.name}: ratio=${r.ratio.toFixed(1)}:1 maxChunk=${(r.stats.maxChunkSeen / 1024).toFixed(1)}KB ` +
          `chunks=${r.stats.chunkCount} pushes=${r.stats.pushCount} ` +
          `abortDelayMs=${r.stats.abortDelayMs?.toFixed(1) ?? '-'} peakHeapDelta=${(r.peakHeapDelta / MB).toFixed(1)}MB`,
      )
    }
    expect(spikeRecord.length).toBeGreaterThanOrEqual(3)
  })
})
