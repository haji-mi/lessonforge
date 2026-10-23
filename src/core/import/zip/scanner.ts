/**
 * ZIP 中央目录扫描器（架构基线 §4.2）。
 *
 * - Blob 随机访问：只读尾部定位 EOCD、按偏移切读中央目录，不整档读入。
 * - 自研仅限元数据层（只读解析），绝不自实现 DEFLATE。
 * - zip64 / 多磁盘 → 明确"暂不支持"（宁拒不错）。
 */
import { crc32 } from './crc32'

export interface ZipUnicodePathExtra {
  crcOk: boolean
  name: string
}

export interface ZipEntryMeta {
  index: number
  nameBytes: Uint8Array
  flagUtf8: boolean
  flagEncrypted: boolean
  flagDataDescriptor: boolean
  method: number
  crc32: number
  compSize: number
  uncompSize: number
  /** 绝对本地头偏移（已做前置数据 shift 修正） */
  localHeaderOffset: number
  isDirectory: boolean
  unicodePath?: ZipUnicodePathExtra
}

export class ZipFormatError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export const ZIP_SCAN_LIMITS = {
  maxEntries: 10000,
  maxArchiveBytes: 500 * 1024 * 1024,
  maxCdSize: 32 * 1024 * 1024,
  maxNameBytes: 512,
}

const EOCD_SIG = 0x06054b50
const CDE_SIG = 0x02014b50
const LFH_SIG = 0x04034b50
const ZIP64_LOCATOR_SIG = 0x07064b50

async function readRange(blob: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer())
}

function u16(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8)
}
function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
}

export interface ZipScan {
  entries: ZipEntryMeta[]
  archiveSize: number
  /** 前置数据导致的偏移修正量 */
  shift: number
}

export async function scanZipBlob(blob: Blob): Promise<ZipScan> {
  const size = blob.size
  if (size > ZIP_SCAN_LIMITS.maxArchiveBytes) {
    throw new ZipFormatError('ARCHIVE_TOO_LARGE', `档案 ${size} 字节超过策略上限（500MB）`)
  }
  if (size < 22) throw new ZipFormatError('NOT_A_ZIP', '文件过小，不是 ZIP')

  // 1) 读尾部定位 EOCD（注释最长 64KB + 22 字节固定部分 + 冗余）
  const tailLen = Math.min(size, 66 * 1024)
  const tail = await readRange(blob, size - tailLen, size)
  const tailStart = size - tailLen
  let eocdRel = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) === EOCD_SIG) {
      eocdRel = i
      break
    }
  }
  if (eocdRel < 0) throw new ZipFormatError('NO_EOCD', '未找到 ZIP 结束记录（EOCD）')
  const eocdPos = tailStart + eocdRel

  // zip64 探测：locator 紧邻 EOCD 之前
  if (eocdPos >= 20) {
    const loc = await readRange(blob, eocdPos - 20, eocdPos)
    if (u32(loc, 0) === ZIP64_LOCATOR_SIG) {
      throw new ZipFormatError('ZIP64_UNSUPPORTED', '暂不支持 zip64 格式档案')
    }
  }

  const diskNum = u16(tail, eocdRel + 4)
  const cdDisk = u16(tail, eocdRel + 6)
  const entriesTotal = u16(tail, eocdRel + 10)
  const cdSize = u32(tail, eocdRel + 12)
  const cdOffset = u32(tail, eocdRel + 16)
  if (diskNum !== 0 || cdDisk !== 0) throw new ZipFormatError('MULTI_DISK', '暂不支持多磁盘档案')
  if (entriesTotal === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipFormatError('ZIP64_UNSUPPORTED', '暂不支持 zip64 格式档案')
  }
  if (entriesTotal > ZIP_SCAN_LIMITS.maxEntries) {
    throw new ZipFormatError('TOO_MANY_ENTRIES', `条目数 ${entriesTotal} 超过上限 10000`)
  }
  if (cdSize > ZIP_SCAN_LIMITS.maxCdSize) {
    throw new ZipFormatError('CD_TOO_LARGE', `中央目录 ${cdSize} 字节超过上限`)
  }

  // 2) 切读中央目录；cdStart 由 EOCD 位置回推（自动兼容前置数据）
  const cdStart = eocdPos - cdSize
  if (cdStart < 0) throw new ZipFormatError('CORRUPT', '中央目录尺寸与 EOCD 位置矛盾')
  const shift = cdStart - cdOffset
  const cd = await readRange(blob, cdStart, eocdPos)

  // 3) 解析条目
  const entries: ZipEntryMeta[] = []
  let pos = 0
  while (pos < cd.length) {
    if (pos + 46 > cd.length || u32(cd, pos) !== CDE_SIG) {
      throw new ZipFormatError('CORRUPT_CENTRAL_DIR', '中央目录条目签名损坏')
    }
    const flags = u16(cd, pos + 8)
    const method = u16(cd, pos + 10)
    const crc = u32(cd, pos + 16)
    const compSize = u32(cd, pos + 20)
    const uncompSize = u32(cd, pos + 24)
    const nameLen = u16(cd, pos + 28)
    const extraLen = u16(cd, pos + 30)
    const commentLen = u16(cd, pos + 32)
    const localOffset = u32(cd, pos + 42)
    const nameStart = pos + 46
    const extraStart = nameStart + nameLen
    const entryEnd = extraStart + extraLen + commentLen
    if (entryEnd > cd.length) throw new ZipFormatError('CORRUPT_CENTRAL_DIR', '中央目录条目越界')
    if (nameLen > ZIP_SCAN_LIMITS.maxNameBytes) {
      throw new ZipFormatError('NAME_TOO_LONG', `条目名 ${nameLen} 字节超过 512 上限`)
    }
    const nameBytes = cd.slice(nameStart, extraStart)
    const extraBytes = cd.slice(extraStart, extraStart + extraLen)

    let unicodePath: ZipUnicodePathExtra | undefined
    let zip64 = false
    let ep = 0
    while (ep + 4 <= extraBytes.length) {
      const id = u16(extraBytes, ep)
      const sz = u16(extraBytes, ep + 2)
      if (ep + 4 + sz > extraBytes.length) break
      if (id === 0x0001) zip64 = true
      if (id === 0x7075 && sz >= 5) {
        const body = extraBytes.subarray(ep + 4, ep + 4 + sz)
        const nameCrc = u32(body, 1)
        const uniName = new TextDecoder('utf-8').decode(body.subarray(5))
        unicodePath = { crcOk: crc32(nameBytes) === nameCrc, name: uniName }
      }
      ep += 4 + sz
    }
    if (zip64) throw new ZipFormatError('ZIP64_UNSUPPORTED', '暂不支持 zip64 条目')

    const nameStr = new TextDecoder('utf-8').decode(nameBytes)
    entries.push({
      index: entries.length,
      nameBytes,
      flagUtf8: (flags & 0x800) !== 0,
      flagEncrypted: (flags & 0x1) !== 0,
      flagDataDescriptor: (flags & 0x8) !== 0,
      method,
      crc32: crc,
      compSize,
      uncompSize,
      localHeaderOffset: localOffset + shift,
      isDirectory: nameStr.endsWith('/') || (nameLen > 0 && nameBytes[nameLen - 1] === 0x2f),
      unicodePath,
    })
    pos = entryEnd
  }
  if (entries.length !== entriesTotal) {
    throw new ZipFormatError(
      'CORRUPT_ENTRY_COUNT',
      `中央目录条目数 ${entries.length} 与 EOCD 声明 ${entriesTotal} 不一致`,
    )
  }
  return { entries, archiveSize: size, shift }
}

/** 读取本地头并返回压缩数据起始偏移（数据起点取本地头自身的名称/额外字段长度） */
export async function locateEntryData(
  blob: Blob,
  entry: ZipEntryMeta,
): Promise<{ dataStart: number } | { error: string }> {
  const head = await readRange(blob, entry.localHeaderOffset, entry.localHeaderOffset + 30)
  if (head.length < 30 || u32(head, 0) !== LFH_SIG) {
    return { error: 'LOCAL_HEADER_CORRUPT' }
  }
  const nameLen = u16(head, 26)
  const extraLen = u16(head, 28)
  return { dataStart: entry.localHeaderOffset + 30 + nameLen + extraLen }
}
