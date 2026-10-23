/** P1c：守卫式解压（预算/CRC/尺寸/截断/Stored） */
import { deflateSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { crc32 } from '../src/core/import/zip/crc32'
import {
  DEFAULT_ZIP_LIMITS,
  inflateEntryFromBlob,
  readStoredEntry,
  type ZipLimits,
} from '../src/core/import/zip/inflate'

const MB = 1024 * 1024

function semiRandomText(len: number): Uint8Array {
  const out = new Uint8Array(len)
  let seed = 42
  for (let i = 0; i < len; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    out[i] = (seed % 94) + 32
  }
  return out
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

describe('守卫式解压', () => {
  it('正常条目：数据/CRC/预算累计正确', async () => {
    const data = semiRandomText(4 * MB) // 约 4MB（LCG 周期性 → 实际压缩比 ~100:1，压缩流 ~41KB）
    const comp = deflateSync(data)
    const blob = new Blob([comp])
    const limits: ZipLimits = { ...DEFAULT_ZIP_LIMITS, inputChunk: 8 * 1024 }
    const budget = { total: 0 }
    const r = await inflateEntryFromBlob(
      blob,
      0,
      comp.length,
      { crc32: crc32(data), uncompSize: data.length },
      limits,
      budget,
    )
    expect(r.ok).toBe(true)
    expect(r.data!.length).toBe(data.length)
    expect(bytesEqual(r.data!, data)).toBe(true)
    expect(budget.total).toBe(data.length)
    expect(r.stats.pushCount).toBe(Math.ceil(comp.length / limits.inputChunk))
    // spike 定律：单块 ≈ 分片 × 膨胀比（8KB × ~100 < 2MB）
    expect(r.stats.maxChunkSeen).toBeLessThanOrEqual(2 * MB)
    expect(r.stats.maxChunkSeen).toBeGreaterThan(0)
  })

  it('说谎炸弹：声明 10KB 实际膨胀 → 预算中断', async () => {
    const bomb = new Uint8Array(16 * MB) // 全零，压缩后极小，膨胀比 ~1000:1
    const comp = deflateSync(bomb)
    expect(comp.length).toBeLessThan(64 * 1024) // 压缩比极高
    const blob = new Blob([comp])
    const limits: ZipLimits = { ...DEFAULT_ZIP_LIMITS, entryBudget: 2 * MB, inputChunk: 64 * 1024 }
    const t0 = performance.now()
    const r = await inflateEntryFromBlob(
      blob,
      0,
      comp.length,
      { crc32: crc32(bomb), uncompSize: 10 * 1024 }, // 声明说谎
      limits,
      { total: 0 },
    )
    const elapsed = performance.now() - t0
    expect(r.ok).toBe(false)
    expect(r.code).toBe('BUDGET_EXCEEDED')
    expect(elapsed).toBeLessThan(5000)
    // 未成功 → 预算不累计
    expect(r.stats.actualSize).toBe(0)
  })

  it('整档累计预算：第二条目被拒', async () => {
    const data = semiRandomText(3 * MB)
    const comp = deflateSync(data)
    const blob = new Blob([comp, comp])
    const limits: ZipLimits = { ...DEFAULT_ZIP_LIMITS, entryBudget: 5 * MB, totalBudget: 4 * MB }
    const budget = { total: 0 }
    const expected = { crc32: crc32(data), uncompSize: data.length }
    const r1 = await inflateEntryFromBlob(blob, 0, comp.length, expected, limits, budget)
    expect(r1.ok).toBe(true)
    const r2 = await inflateEntryFromBlob(blob, comp.length, comp.length, expected, limits, budget)
    expect(r2.ok).toBe(false)
    expect(r2.code).toBe('BUDGET_EXCEEDED')
  })

  it('CRC 不符 → 拒收', async () => {
    const data = textOf('hello world 中文内容')
    const comp = deflateSync(data)
    const r = await inflateEntryFromBlob(
      new Blob([comp]),
      0,
      comp.length,
      { crc32: crc32(data) ^ 1, uncompSize: data.length },
      DEFAULT_ZIP_LIMITS,
      { total: 0 },
    )
    expect(r.ok).toBe(false)
    expect(r.code).toBe('CRC_MISMATCH')
  })

  it('实际尺寸与声明不符 → 拒收', async () => {
    const data = textOf('hello world')
    const comp = deflateSync(data)
    const r = await inflateEntryFromBlob(
      new Blob([comp]),
      0,
      comp.length,
      { crc32: crc32(data), uncompSize: data.length + 5 },
      DEFAULT_ZIP_LIMITS,
      { total: 0 },
    )
    expect(r.ok).toBe(false)
    expect(r.code).toBe('SIZE_MISMATCH')
  })

  it('压缩数据截断 → 拒收', async () => {
    const data = semiRandomText(256 * 1024)
    const comp = deflateSync(data)
    const truncated = comp.subarray(0, comp.length - 10)
    const r = await inflateEntryFromBlob(
      new Blob([truncated]),
      0,
      truncated.length,
      { crc32: crc32(data), uncompSize: data.length },
      DEFAULT_ZIP_LIMITS,
      { total: 0 },
    )
    expect(r.ok).toBe(false)
    expect(r.code).toBe('TRUNCATED_OR_CORRUPT')
  })

  it('压缩数据损坏 → 拒收', async () => {
    const data = semiRandomText(256 * 1024)
    const comp = deflateSync(data)
    comp[5] ^= 0xff
    comp[20] ^= 0xff
    const r = await inflateEntryFromBlob(
      new Blob([comp]),
      0,
      comp.length,
      { crc32: crc32(data), uncompSize: data.length },
      DEFAULT_ZIP_LIMITS,
      { total: 0 },
    )
    expect(r.ok).toBe(false)
  })

  it('Stored：正常/尺寸不符/超预算', async () => {
    const data = textOf('stored content')
    const blob = new Blob([data as unknown as BlobPart])
    const ok = await readStoredEntry(
      blob,
      0,
      data.length,
      { crc32: crc32(data), uncompSize: data.length },
      DEFAULT_ZIP_LIMITS,
      { total: 0 },
    )
    expect(ok.ok).toBe(true)
    expect(ok.data).toEqual(data)

    const bad = await readStoredEntry(
      blob,
      0,
      data.length,
      { crc32: crc32(data), uncompSize: data.length + 1 },
      DEFAULT_ZIP_LIMITS,
      { total: 0 },
    )
    expect(bad.code).toBe('SIZE_MISMATCH')

    const over = await readStoredEntry(
      blob,
      0,
      data.length,
      { crc32: crc32(data), uncompSize: data.length },
      { ...DEFAULT_ZIP_LIMITS, entryBudget: 4 },
      { total: 0 },
    )
    expect(over.code).toBe('BUDGET_EXCEEDED')
  })
})

function textOf(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}
