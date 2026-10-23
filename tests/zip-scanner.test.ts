/** P1a：ZIP 中央目录扫描器测试 */
import { describe, expect, it } from 'vitest'
import { scanZipBlob, ZipFormatError, type ZipEntryMeta } from '../src/core/import/zip/scanner'
import {
  buildZip,
  gbkBytesOf,
  prependJunk,
  textBytes,
  toBlob,
  unicodePathExtra,
  withZip64Locator,
} from './helpers/zipbuilder'

function nameOf(e: ZipEntryMeta): string {
  return new TextDecoder('utf-8').decode(e.nameBytes)
}

describe('ZIP 扫描器', () => {
  it('往返：UTF-8 与 GBK 名称、方法/尺寸/CRC/偏移', async () => {
    const gbkName = gbkBytesOf('数学/第1章/函数.md')
    const zip = buildZip([
      { name: '物理/力学/readme.md', data: textBytes('# 力学\n\n内容') },
      { name: gbkName, data: textBytes('# 函数\n') },
      { name: 'img.png', data: new Uint8Array([1, 2, 3, 4]), method: 0 },
    ])
    const scan = await scanZipBlob(toBlob(zip))
    expect(scan.entries).toHaveLength(3)
    expect(nameOf(scan.entries[0]!)).toBe('物理/力学/readme.md')
    expect(nameOf(scan.entries[1]!)).not.toBe('数学/第1章/函数.md') // GBK 字节按 UTF-8 显示为乱码
    expect(new TextDecoder('gbk').decode(scan.entries[1]!.nameBytes)).toBe('数学/第1章/函数.md')
    expect(scan.entries[2]!.method).toBe(0)
    expect(scan.entries[2]!.uncompSize).toBe(4)
    // dataStart 可定位且数据落在档案内（首个条目本地头偏移可为 0）
    for (const e of scan.entries) {
      expect(e.localHeaderOffset).toBeGreaterThanOrEqual(0)
      expect(e.localHeaderOffset).toBeLessThan(zip.length)
    }
  })

  it('前置垃圾字节（自解压档案）偏移修正', async () => {
    const zip = buildZip([{ name: 'a.md', data: textBytes('hello') }])
    const shifted = prependJunk(zip, 100)
    const scan = await scanZipBlob(toBlob(shifted))
    expect(scan.shift).toBe(100)
    expect(nameOf(scan.entries[0]!)).toBe('a.md')
    expect(scan.entries[0]!.localHeaderOffset).toBeGreaterThanOrEqual(100)
  })

  it('zip64 locator → 明确拒收', async () => {
    const zip = buildZip([{ name: 'a.md', data: textBytes('x') }])
    await expect(scanZipBlob(toBlob(withZip64Locator(zip)))).rejects.toMatchObject({
      code: 'ZIP64_UNSUPPORTED',
    })
  })

  it('EOCD 缺失 → 拒收', async () => {
    const zip = buildZip([{ name: 'a.md', data: textBytes('x') }])
    await expect(scanZipBlob(toBlob(zip.subarray(0, zip.length - 22)))).rejects.toBeInstanceOf(
      ZipFormatError,
    )
  })

  it('中央目录签名损坏 → 拒收', async () => {
    const zip = buildZip([{ name: 'a.md', data: textBytes('x') }])
    // 定位中央目录签名（PK\x01\x02，区别于本地头 PK\x03\x04）并破坏
    let cdSig = -1
    for (let i = 0; i < zip.length - 4; i++) {
      if (zip[i] === 0x50 && zip[i + 1] === 0x4b && zip[i + 2] === 0x01 && zip[i + 3] === 0x02) {
        cdSig = i
        break
      }
    }
    expect(cdSig).toBeGreaterThan(0)
    zip[cdSig] = 0xff
    await expect(scanZipBlob(toBlob(zip))).rejects.toBeInstanceOf(ZipFormatError)
  })

  it('条目数超过上限 → 拒收', async () => {
    const specs = Array.from({ length: 10001 }, (_, i) => ({
      name: `f${i}.md`,
      data: new Uint8Array([i & 0xff]),
      method: 0 as const,
    }))
    const zip = buildZip(specs)
    await expect(scanZipBlob(toBlob(zip))).rejects.toMatchObject({ code: 'TOO_MANY_ENTRIES' })
  }, 30000)

  it('0x7075 扩展字段：CRC 正确/损坏', async () => {
    const nameBytes = gbkBytesOf('课件.md')
    const good = unicodePathExtra(nameBytes, '课件.md')
    const bad = unicodePathExtra(nameBytes, '课件.md', true)
    const zip = buildZip([
      { name: nameBytes, data: textBytes('x'), extra: good },
      { name: gbkBytesOf('其他.md'), data: textBytes('y'), extra: bad },
    ])
    const scan = await scanZipBlob(toBlob(zip))
    expect(scan.entries[0]!.unicodePath?.crcOk).toBe(true)
    expect(scan.entries[0]!.unicodePath?.name).toBe('课件.md')
    expect(scan.entries[1]!.unicodePath?.crcOk).toBe(false)
  })

  it('data descriptor（本地头零尺寸）不影响中央目录读取', async () => {
    const zip = buildZip([
      {
        name: 'dd.md',
        data: textBytes('data descriptor 条目'),
        localSizeOverride: true,
        flags: 0x8,
      },
    ])
    const scan = await scanZipBlob(toBlob(zip))
    expect(scan.entries[0]!.flagDataDescriptor).toBe(true)
    expect(scan.entries[0]!.uncompSize).toBe(textBytes('data descriptor 条目').length)
  })

  it('目录条目识别', async () => {
    const zip = buildZip([
      { name: '目录/', data: new Uint8Array(0), method: 0 },
      { name: '目录/a.md', data: textBytes('x') },
    ])
    const scan = await scanZipBlob(toBlob(zip))
    expect(scan.entries[0]!.isDirectory).toBe(true)
    expect(scan.entries[1]!.isDirectory).toBe(false)
  })
})
