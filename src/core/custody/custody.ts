/**
 * 原始文件保管（架构基线 B1/B2/B3）：字节不可变、解码分段映射、EOL/BOM 元数据。
 * 解码有损时明确声明，绝不宣称无损。
 */
import type { ImportedFile } from '../types'
import { fileKindOf } from '../types'
import { sha256Hex } from './hash'
import { segmentUtf8, type Utf8Segment } from '../codec/utf8'

export interface DecodeIssue {
  byteStart: number
  byteEnd: number
  kind: 'invalid-utf8' | 'gbk-invalid' | 'segmentation-mismatch'
}

export type FileEncoding = 'utf-8' | 'utf-16-unsupported' | 'binary-unsupported'

export interface FileDecoding {
  encoding: FileEncoding
  /** 权威解码文本（utf-16/binary 时为空串，不解析） */
  text: string
  bom: boolean
  lossy: boolean
  issues: DecodeIssue[]
  segments: Utf8Segment[]
  /** UTF-8 有损但 GBK 严格解码通过 → 可向用户提供 GBK 视图选项 */
  gbkViewOffered: boolean
}

export function decodeFileText(bytes: Uint8Array): FileDecoding {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return {
      encoding: 'utf-16-unsupported',
      text: '',
      bom: false,
      lossy: false,
      issues: [],
      segments: [],
      gbkViewOffered: false,
    }
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return {
      encoding: 'utf-16-unsupported',
      text: '',
      bom: false,
      lossy: false,
      issues: [],
      segments: [],
      gbkViewOffered: false,
    }
  }
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  const body = bom ? bytes.subarray(3) : bytes
  let seg: Utf8Segment[]
  let text: string
  let lossy: boolean
  let mismatch = false
  try {
    const r = segmentUtf8(body)
    seg = r.segments
    text = r.text
    lossy = r.lossy
  } catch {
    // 分段映射与平台不一致（理论不可达；防御路径）：以平台文本为准并显式声明
    mismatch = true
    seg = []
    text = new TextDecoder('utf-8').decode(body)
    lossy = text.includes('\uFFFD')
  }
  let gbkViewOffered = false
  if (lossy && !bom) {
    try {
      new TextDecoder('gbk', { fatal: true }).decode(body)
      gbkViewOffered = true
    } catch {
      // GBK 也不行
    }
  }
  const issues: DecodeIssue[] = seg
    .filter((s) => !s.valid)
    .map((s) => ({ byteStart: s.byteStart, byteEnd: s.byteEnd, kind: 'invalid-utf8' as const }))
  if (mismatch) issues.unshift({ byteStart: 0, byteEnd: 0, kind: 'segmentation-mismatch' })
  return { encoding: 'utf-8', text, bom, lossy, issues, segments: seg, gbkViewOffered }
}

/** GBK 视图（用户显式选择）：不做重编码承诺；有损点经二分定位逐条列明 */
export function gbkViewText(bytes: Uint8Array): {
  text: string
  lossy: boolean
  issues: DecodeIssue[]
} {
  const issues: DecodeIssue[] = []
  let text: string
  let lossy = false
  try {
    text = new TextDecoder('gbk', { fatal: true }).decode(bytes)
  } catch {
    lossy = true
    text = new TextDecoder('gbk').decode(bytes)
    // 二分定位每个非法序列的字节区间
    let pos = 0
    while (pos < bytes.length) {
      const fail = findFirstGbkError(bytes, pos)
      if (fail < 0) break
      // 非法序列长度 1 或 2 字节：尝试跳 1，仍错则跳 2
      let skip = 1
      if (fail + 1 < bytes.length && findFirstGbkError(bytes, fail + 1) === fail + 1) skip = 2
      issues.push({ byteStart: fail, byteEnd: fail + skip, kind: 'gbk-invalid' })
      pos = fail + skip
    }
  }
  return { text, lossy, issues }
}

function findFirstGbkError(bytes: Uint8Array, from: number): number {
  let lo = from
  let hi = bytes.length
  // 先确认剩余部分确实有错
  try {
    new TextDecoder('gbk', { fatal: true }).decode(bytes.subarray(from))
    return -1
  } catch {
    /* 有错，二分 */
  }
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1
    try {
      new TextDecoder('gbk', { fatal: true }).decode(bytes.subarray(from, mid))
      lo = mid
    } catch {
      hi = mid
    }
  }
  // lo 是最大可解码前缀长度（相对 from），错误字节在 from+lo
  return from + lo
}

export interface EolStats {
  crlf: number
  lf: number
  cr: number
  mixed: boolean
}

/**
 * EOL 统计在 B 空间字节扫描（安全前提：0x0D/0x0A 不会出现在 UTF-8 多字节序列的续字节
 * （续字节 ≥0x80）也不会出现在 GBK 尾字节（0x40–0xFE）中）。
 */
export function countEol(body: Uint8Array): EolStats {
  let crlf = 0
  let lf = 0
  let cr = 0
  for (let i = 0; i < body.length; i++) {
    const b = body[i]
    if (b === 0x0d) {
      if (body[i + 1] === 0x0a) {
        crlf++
        i++
      } else cr++
    } else if (b === 0x0a) lf++
  }
  const kinds = (crlf > 0 ? 1 : 0) + (lf > 0 ? 1 : 0) + (cr > 0 ? 1 : 0)
  return { crlf, lf, cr, mixed: kinds > 1 }
}

export interface SourceFileRevision {
  id: string
  projectId: string
  batchId: string
  normPath: string
  contentHash: string
  bytes: Uint8Array
  byteSize: number
  text: string
  encoding: FileEncoding
  bom: boolean
  eol: EolStats
  lossy: boolean
  issues: DecodeIssue[]
  gbkViewOffered: boolean
  importedAt: number
}

export async function buildRevision(
  projectId: string,
  batchId: string,
  file: ImportedFile,
  bytes: Uint8Array,
): Promise<SourceFileRevision> {
  const contentHash = await sha256Hex(bytes)
  const dec = decodeFileText(bytes)
  const bomLen = dec.bom ? 3 : 0
  const eol = countEol(bytes.subarray(bomLen))
  const id = `${projectId}:${file.normPath}:${contentHash.slice(0, 12)}`
  return {
    id,
    projectId,
    batchId,
    normPath: file.normPath,
    contentHash,
    bytes,
    byteSize: bytes.length,
    text: dec.text,
    encoding: dec.encoding,
    bom: dec.bom,
    eol,
    lossy: dec.lossy,
    issues: dec.issues,
    gbkViewOffered: dec.gbkViewOffered,
    importedAt: Date.now(),
  }
}

export { fileKindOf }
