/** 测试用 ZIP 构造器：字节级手工构造，精确控制标志位/名称编码/尺寸声明/扩展字段 */
import { deflateSync } from 'fflate'
import { crc32 } from '../../src/core/import/zip/crc32'

export interface ZipEntrySpec {
  name: string | Uint8Array
  data: Uint8Array
  method?: number
  /** 显式通用标志位（不传则为 0） */
  flags?: number
  crcOverride?: number
  uncompSizeOverride?: number
  compSizeOverride?: number
  extra?: Uint8Array
  /** 本地头尺寸字段覆盖（构造 data descriptor 场景：本地头写 0，中央目录写真值） */
  localSizeOverride?: boolean
}

class ByteWriter {
  private parts: number[] = []
  u16(v: number) {
    this.parts.push(v & 0xff, (v >>> 8) & 0xff)
    return this
  }
  u32(v: number) {
    this.parts.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff)
    return this
  }
  bytes(b: Uint8Array) {
    for (const x of b) this.parts.push(x)
    return this
  }
  build(): Uint8Array {
    return new Uint8Array(this.parts)
  }
}

const enc = new TextEncoder()

let gbkTable: Map<string, number> | null = null
function getGbkTable(): Map<string, number> {
  if (gbkTable) return gbkTable
  gbkTable = new Map()
  const dec = new TextDecoder('gbk')
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail === 0x7f) continue
      const ch = dec.decode(new Uint8Array([lead, trail]))
      if (ch && ch !== '\uFFFD' && ch.length === 1 && !gbkTable.has(ch))
        gbkTable.set(ch, (lead << 8) | trail)
    }
  }
  return gbkTable
}

/** 测试 fixture 用：中文 → GBK 字节（借道 GBK 双字节区逆向查表） */
export function gbkBytesOf(s: string): Uint8Array {
  const table = getGbkTable()
  const out: number[] = []
  for (const ch of s) {
    const g = table.get(ch)
    if (g !== undefined) {
      out.push((g >> 8) & 0xff, g & 0xff)
      continue
    }
    const c = ch.codePointAt(0)!
    if (c < 0x80) out.push(c)
    else throw new Error(`GBK fixture 无法编码字符: ${ch}`)
  }
  return new Uint8Array(out)
}

export function unicodePathExtra(
  nameBytes: Uint8Array,
  unicodeName: string,
  corrupt = false,
): Uint8Array {
  const uni = enc.encode(unicodeName)
  const w = new ByteWriter()
  w.u16(0x7075)
  w.u16(1 + 4 + uni.length)
  w.bytes(new Uint8Array([1]))
  w.u32(crc32(nameBytes) ^ (corrupt ? 0xdeadbeef : 0))
  w.bytes(uni)
  return w.build()
}

export function buildZip(specs: ZipEntrySpec[]): Uint8Array {
  const locals: Uint8Array[] = []
  const central = new ByteWriter()
  let offset = 0
  for (const spec of specs) {
    const nameBytes = typeof spec.name === 'string' ? enc.encode(spec.name) : spec.name
    const method = spec.method ?? 8
    const comp = method === 8 ? deflateSync(spec.data) : spec.data
    const crc = spec.crcOverride ?? crc32(spec.data)
    const uncomp = spec.uncompSizeOverride ?? spec.data.length
    const compLen = spec.compSizeOverride ?? comp.length
    const flags = spec.flags ?? 0
    const extra = spec.extra ?? new Uint8Array(0)

    const l = new ByteWriter()
    l.u32(0x04034b50)
      .u16(20)
      .u16(flags)
      .u16(method)
      .u16(0)
      .u16(0)
      .u32(spec.localSizeOverride ? 0 : crc)
      .u32(spec.localSizeOverride ? 0 : compLen)
      .u32(spec.localSizeOverride ? 0 : uncomp)
      .u16(nameBytes.length)
      .u16(extra.length)
      .bytes(nameBytes)
      .bytes(extra)
      .bytes(comp)
    const lb = l.build()
    locals.push(lb)

    central
      .u32(0x02014b50)
      .u16(20)
      .u16(20)
      .u16(flags)
      .u16(method)
      .u16(0)
      .u16(0)
      .u32(crc)
      .u32(compLen)
      .u32(uncomp)
      .u16(nameBytes.length)
      .u16(extra.length)
      .u16(0)
      .u16(0)
      .u16(0)
      .u32(0)
      .u32(offset)
      .bytes(nameBytes)
      .bytes(extra)
    offset += lb.length
  }
  const cdBytes = central.build()
  const localTotal = locals.reduce((s, b) => s + b.length, 0)
  const out = new ByteWriter()
  for (const lb of locals) out.bytes(lb)
  out.bytes(cdBytes)
  out
    .u32(0x06054b50)
    .u16(0)
    .u16(0)
    .u16(specs.length)
    .u16(specs.length)
    .u32(cdBytes.length)
    .u32(localTotal)
    .u16(0) // commentLen
  return out.build()
}

/** 在 EOCD 前插入 zip64 locator（构造 zip64 探测场景） */
export function withZip64Locator(zip: Uint8Array): Uint8Array {
  const eocdPos = zip.length - 22
  const loc = new ByteWriter()
  loc.u32(0x07064b50).u32(0).u32(0).u32(0).u32(0).u32(1)
  const locBytes = loc.build()
  const out = new Uint8Array(zip.length + 20)
  out.set(zip.subarray(0, eocdPos), 0)
  out.set(locBytes, eocdPos)
  out.set(zip.subarray(eocdPos), eocdPos + 20)
  return out
}

/** 前置垃圾字节（自解压档案场景：测试偏移修正） */
export function prependJunk(zip: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(n + zip.length)
  for (let i = 0; i < n; i++) out[i] = 0x4d
  out.set(zip, n)
  return out
}

export function toBlob(bytes: Uint8Array): Blob {
  return new Blob([bytes as unknown as BlobPart])
}

export function textBytes(s: string): Uint8Array {
  return enc.encode(s)
}
