/**
 * UTF-8 分段映射解码器（架构基线 B2 不变量）。
 *
 * - 权威解码文本一律由平台非 fatal 解码器产生（WHATWG 语义）。
 * - 本模块按 WHATWG UTF-8 规则（含 maximal subpart 语义）把字节流切成互不重叠分段，
 *   每段记录字节/字符区间与有效性；无效分段（一个 maximal subpart）期望输出恰为一个 U+FFFD。
 * - 核心不变量：全部分段期望输出的拼接 === 平台解码文本。原文合法 EF BF BD 属有效分段，
 *   与解码器插入的 U+FFFD（无效分段）结构性区分。
 */
export interface Utf8Segment {
  byteStart: number
  byteEnd: number
  charStart: number
  charEnd: number
  valid: boolean
}

export interface Utf8Segmentation {
  segments: Utf8Segment[]
  /** 平台非 fatal 解码结果（权威文本） */
  text: string
  /** 分段期望输出拼接（不变量：=== text） */
  expected: string
  lossy: boolean
}

export class Utf8SegmentationMismatchError extends Error {
  constructor(public readonly detail: string) {
    super(`UTF-8 分段映射与平台解码器不一致：${detail}`)
  }
}

/** 首字节所需的后续续字节数；-1 表示非法首字节（孤立续字节 / overlong C0,C1 / F5+） */
function leadInfo(b: number): number {
  if (b < 0x80) return 0
  if (b <= 0xbf) return -1
  if (b <= 0xc1) return -1
  if (b <= 0xdf) return 1
  if (b <= 0xef) return 2
  if (b <= 0xf4) return 3
  return -1
}

/** 首续字节的合法下界（E0/F0 下界与 ED/F4 上界来自 WHATWG 表） */
function firstContMin(lead: number): number {
  if (lead === 0xe0) return 0xa0
  if (lead === 0xf0) return 0x90
  return 0x80
}

function firstContMax(lead: number): number {
  if (lead === 0xed) return 0x9f
  if (lead === 0xf4) return 0x8f
  return 0xbf
}

const utf8Decoder = new TextDecoder('utf-8')

export function segmentUtf8(bytes: Uint8Array): Utf8Segmentation {
  const segments: Utf8Segment[] = []
  const parts: string[] = []
  let i = 0
  let charPos = 0
  while (i < bytes.length) {
    const b = bytes[i]
    const need = leadInfo(b)
    if (need <= 0 && b < 0x80) {
      // ASCII
      segments.push({
        byteStart: i,
        byteEnd: i + 1,
        charStart: charPos,
        charEnd: charPos + 1,
        valid: true,
      })
      parts.push(String.fromCharCode(b))
      charPos += 1
      i += 1
      continue
    }
    if (need < 0) {
      segments.push({
        byteStart: i,
        byteEnd: i + 1,
        charStart: charPos,
        charEnd: charPos + 1,
        valid: false,
      })
      parts.push('\uFFFD')
      charPos += 1
      i += 1
      continue
    }
    // 多字节序列：按首续字节特殊区间 + 续字节 80-BF 逐个校验
    let j = 1
    let broken = false
    while (j <= need) {
      const c = bytes[i + j]
      if (c === undefined) {
        broken = true
        break
      }
      const lo = j === 1 ? firstContMin(b) : 0x80
      const hi = j === 1 ? firstContMax(b) : 0xbf
      if (c < lo || c > hi) {
        broken = true
        break
      }
      j++
    }
    if (!broken) {
      const decoded = utf8Decoder.decode(bytes.subarray(i, i + need + 1))
      segments.push({
        byteStart: i,
        byteEnd: i + need + 1,
        charStart: charPos,
        charEnd: charPos + decoded.length,
        valid: true,
      })
      parts.push(decoded)
      charPos += decoded.length
      i += need + 1
    } else {
      // maximal subpart：已消费的首字节 + (j-1) 个合法续字节；破坏字节留待下一轮
      const end = i + j
      segments.push({
        byteStart: i,
        byteEnd: end,
        charStart: charPos,
        charEnd: charPos + 1,
        valid: false,
      })
      parts.push('\uFFFD')
      charPos += 1
      i = end
    }
  }
  const expected = parts.join('')
  const text = utf8Decoder.decode(bytes)
  if (expected !== text) {
    throw new Utf8SegmentationMismatchError(
      `expected ${expected.length} chars, platform ${text.length} chars`,
    )
  }
  return { segments, text, expected, lossy: segments.some((s) => !s.valid) }
}

/** 严格 UTF-8 判定（无任何替换即返回解码结果，否则 null） */
export function strictUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/** 严格 GBK 判定 */
export function strictGbk(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('gbk', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

export function latin1(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i])
  return out
}
