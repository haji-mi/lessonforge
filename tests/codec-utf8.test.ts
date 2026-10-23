/**
 * P2a/B2 不变量测试：UTF-8 分段映射对拍平台解码器。
 * 覆盖：原文合法 U+FFFD / 单非法序列 / 连续非法字节 / 混合 / EOF 截断 / overlong /
 * UTF-8 编码代理 / 4 字节 / 越界 + 随机字节模糊测试（种子化）。
 */
import { describe, expect, it } from 'vitest'
import { segmentUtf8 } from '../src/core/codec/utf8'

function fatalThrows(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return false
  } catch {
    return true
  }
}

/** 分段结构合法性：字节/字符区间各自连续无缝铺满 */
function assertTiling(bytes: Uint8Array, seg: ReturnType<typeof segmentUtf8>) {
  let pos = 0
  let charPos = 0
  for (const s of seg.segments) {
    expect(s.byteStart).toBe(pos)
    expect(s.charStart).toBe(charPos)
    pos = s.byteEnd
    charPos = s.charEnd
  }
  expect(pos).toBe(bytes.length)
  expect(charPos).toBe(seg.text.length)
}

describe('B2 分段映射：边界案例', () => {
  it('原文合法 U+FFFD（EF BF BD）', () => {
    const b = new Uint8Array([0x61, 0xef, 0xbf, 0xbd, 0x62])
    const r = segmentUtf8(b)
    expect(r.text).toBe('a\uFFFDb')
    expect(r.lossy).toBe(false)
    expect(fatalThrows(b)).toBe(false)
    const invalid = r.segments.filter((s) => !s.valid)
    expect(invalid).toHaveLength(0)
    // 原文 U+FFFD 是有效分段
    const fffdSeg = r.segments.find((s) => s.byteStart === 1)!
    expect(fffdSeg.valid).toBe(true)
    assertTiling(b, r)
  })

  it('单个非法序列（E2 82 截断三字节 = 一个 maximal subpart）', () => {
    const b = new Uint8Array([0x61, 0xe2, 0x82, 0x62])
    const r = segmentUtf8(b)
    expect(r.expected).toBe(r.text)
    expect(r.text).toBe('a\uFFFDb')
    expect(r.lossy).toBe(true)
    expect(fatalThrows(b)).toBe(true)
    expect(r.segments.filter((s) => !s.valid)).toHaveLength(1)
    expect(r.segments[1]!.byteEnd - r.segments[1]!.byteStart).toBe(2)
    assertTiling(b, r)
  })

  it('连续非法字节（C0 80 overlong → 2 个插入；D6 D0 → 2 个插入）', () => {
    const b = new Uint8Array([0xc0, 0x80, 0xd6, 0xd0])
    const r = segmentUtf8(b)
    expect(r.text).toBe('\uFFFD\uFFFD\uFFFD\uFFFD')
    expect(r.segments.filter((s) => !s.valid)).toHaveLength(4)
    expect(r.lossy).toBe(true)
    assertTiling(b, r)
  })

  it('合法与非法混合 + 原文 U+FFFD 共存（计数 = 原文 + 插入）', () => {
    const b = new Uint8Array([
      0x61, 0xe2, 0x82, 0x62, 0xef, 0xbf, 0xbd, 0xc0, 0x80, 0x63, 0xd6, 0xd0, 0x64, 0xe2,
    ])
    const r = segmentUtf8(b)
    expect(r.expected).toBe(r.text)
    const inserted = r.segments.filter((s) => !s.valid).length
    const original = r.segments.filter(
      (s) => s.valid && s.charEnd - s.charStart === 1 && r.text[s.charStart] === '\uFFFD',
    ).length
    const total = [...r.text].filter((c) => c === '\uFFFD').length
    expect(total).toBe(original + inserted)
    expect(inserted).toBe(6)
    expect(original).toBe(1)
    assertTiling(b, r)
  })

  it('EOF 截断：E2 / E0 A0 / F0 90 80', () => {
    for (const [bytes, subLen] of [
      [[0xe2], 1],
      [[0xe2, 0x82], 2],
      [[0xe0, 0xa0], 2],
      [[0xf0, 0x90, 0x80], 3],
    ] as const) {
      const b = new Uint8Array(bytes)
      const r = segmentUtf8(b)
      expect(r.lossy).toBe(true)
      expect(r.segments).toHaveLength(1)
      expect(r.segments[0]!.byteEnd - r.segments[0]!.byteStart).toBe(subLen)
      expect(r.text).toBe('\uFFFD')
      expect(fatalThrows(b)).toBe(true)
    }
  })

  it('overlong 编码（E0 80 80 / F0 80 80 80）按 WHATWG maximal subpart 拒绝', () => {
    const b = new Uint8Array([0xe0, 0x80, 0x80])
    const r = segmentUtf8(b)
    // E0 首续字节须 A0-BF：E0 单独成 subpart，80 孤立，80 孤立 → 3 个插入
    expect(r.text).toBe('\uFFFD\uFFFD\uFFFD')
    const b2 = new Uint8Array([0xf0, 0x80, 0x80, 0x80])
    const r2 = segmentUtf8(b2)
    expect(r2.text).toBe('\uFFFD\uFFFD\uFFFD\uFFFD')
  })

  it('UTF-8 编码的代理区（ED A0 80）非法', () => {
    const b = new Uint8Array([0xed, 0xa0, 0x80])
    const r = segmentUtf8(b)
    // ED 首续字节须 80-9F：A0 越界 → [ED] + [A0] + [80] 三个 subpart
    expect(r.text).toBe('\uFFFD\uFFFD\uFFFD')
    expect(fatalThrows(b)).toBe(true)
    // ED 9F 80 是合法代理下界之下的有效码位 U+D700? 不：ED 9F BF = U+D7FF 合法
    const ok = new Uint8Array([0xed, 0x9f, 0xbf])
    expect(segmentUtf8(ok).lossy).toBe(false)
  })

  it('4 字节序列：合法 😀 与越界 F4 90 80 80', () => {
    const ok = new Uint8Array([0xf0, 0x9f, 0x98, 0x80])
    const r = segmentUtf8(ok)
    expect(r.text).toBe('😀')
    expect(r.lossy).toBe(false)
    expect(r.segments[0]!.charEnd - r.segments[0]!.charStart).toBe(2) // 代理对 2 个 UTF-16 码元
    const bad = new Uint8Array([0xf4, 0x90, 0x80, 0x80])
    const r2 = segmentUtf8(bad)
    expect(r2.lossy).toBe(true)
  })

  it('F5+ 非法首字节', () => {
    const b = new Uint8Array([0xf5, 0x80, 0x80, 0x80, 0xff])
    const r = segmentUtf8(b)
    expect(r.segments.filter((s) => !s.valid)).toHaveLength(5)
  })

  it('空输入', () => {
    const r = segmentUtf8(new Uint8Array(0))
    expect(r.text).toBe('')
    expect(r.segments).toHaveLength(0)
  })
})

describe('B2 分段映射：随机字节模糊测试（500 轮，种子化）', () => {
  function mulberry32(seed: number) {
    return () => {
      seed |= 0
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  it('分段拼接 === 平台解码；lossy ⇔ fatal 抛错；区间连续', () => {
    const rand = mulberry32(20261024)
    for (let iter = 0; iter < 500; iter++) {
      const len = Math.floor(rand() * 200)
      const bytes = new Uint8Array(len)
      for (let i = 0; i < len; i++) {
        const roll = rand()
        if (roll < 0.35)
          bytes[i] = Math.floor(rand() * 0x80) // ASCII
        else if (roll < 0.55)
          bytes[i] = 0x80 + Math.floor(rand() * 0x80) // 续字节
        else if (roll < 0.75)
          bytes[i] = 0xc0 + Math.floor(rand() * 0x20) // 首字节区
        else if (roll < 0.9) bytes[i] = 0xe0 + Math.floor(rand() * 0x10)
        else bytes[i] = 0xf0 + Math.floor(rand() * 0x10)
      }
      // segmentUtf8 内部断言 expected === text（不一致即抛错）
      const r = segmentUtf8(bytes)
      const platform = new TextDecoder('utf-8').decode(bytes)
      expect(r.text).toBe(platform)
      expect(r.expected).toBe(platform)
      expect(r.lossy).toBe(fatalThrows(bytes))
      // 区间连续性
      let pos = 0
      for (const s of r.segments) {
        expect(s.byteStart).toBe(pos)
        pos = s.byteEnd
      }
      expect(pos).toBe(bytes.length)
    }
  })
})
