/** P1d：custody 保管（B1/B2/B3 + EOL/BOM/有损声明/GBK 视图） */
import { describe, expect, it } from 'vitest'
import { buildRevision, countEol, decodeFileText, gbkViewText } from '../src/core/custody/custody'
import type { ImportedFile } from '../src/core/types'

function fakeFile(normPath: string, bytes: Uint8Array): ImportedFile {
  const fileName = normPath.split('/').pop()!
  const ext = fileName.includes('.') ? fileName.split('.').pop()! : ''
  return {
    normPath,
    fileName,
    ext,
    byteSize: bytes.length,
    kind: 'md',
    source: { type: 'bytes', bytes },
  }
}

describe('decodeFileText', () => {
  it('合法 UTF-8 无损', () => {
    const bytes = new TextEncoder().encode('# 标题\n\n正文 $x^2$')
    const d = decodeFileText(bytes)
    expect(d.encoding).toBe('utf-8')
    expect(d.lossy).toBe(false)
    expect(d.issues).toHaveLength(0)
    expect(d.text).toBe('# 标题\n\n正文 $x^2$')
    expect(d.bom).toBe(false)
  })

  it('BOM：显式检查并剥离', () => {
    const body = new TextEncoder().encode('# 标题')
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...body])
    const d = decodeFileText(withBom)
    expect(d.bom).toBe(true)
    expect(d.text).toBe('# 标题') // BOM 不出现在文本中
    expect(d.lossy).toBe(false)
  })

  it('有损 UTF-8：逐条列明 + GBK 视图选项（当 GBK 可解码）', () => {
    // 中 (D6D0) 的 GBK 字节是非法 UTF-8
    const gbkChinese = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0x0a])
    const d = decodeFileText(gbkChinese)
    expect(d.lossy).toBe(true)
    expect(d.issues.length).toBeGreaterThanOrEqual(2)
    expect(d.gbkViewOffered).toBe(true)
    expect(d.text.includes('\uFFFD')).toBe(true)
  })

  it('有损 UTF-8 但 GBK 也不行 → 不提供 GBK 视图', () => {
    const b = new Uint8Array([0x61, 0xff, 0xff, 0x62])
    const d = decodeFileText(b)
    expect(d.lossy).toBe(true)
    expect(d.gbkViewOffered).toBe(false)
  })

  it('UTF-16 BOM 检测：不解析只保管', () => {
    const le = new Uint8Array([0xff, 0xfe, 0x41, 0x00])
    const be = new Uint8Array([0xfe, 0xff, 0x00, 0x41])
    expect(decodeFileText(le).encoding).toBe('utf-16-unsupported')
    expect(decodeFileText(be).encoding).toBe('utf-16-unsupported')
  })

  it('原文合法 U+FFFD 不产生 issue', () => {
    const b = new TextEncoder().encode('a\uFFFD b')
    const d = decodeFileText(b)
    expect(d.lossy).toBe(false)
    expect(d.issues).toHaveLength(0)
  })
})

describe('GBK 视图', () => {
  it('GBK 内容解码正确', () => {
    const bytes = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]) // 中文
    const v = gbkViewText(bytes)
    expect(v.lossy).toBe(false)
    expect(v.text).toBe('中文')
  })

  it('GBK 视图有损时定位 issue', () => {
    const bytes = new Uint8Array([0xd6, 0xd0, 0xff, 0x2e]) // 中文 + 0xFF(非法) + '.'
    const v = gbkViewText(bytes)
    expect(v.lossy).toBe(true)
    expect(v.issues.length).toBeGreaterThanOrEqual(1)
    expect(v.issues[0]!.byteStart).toBeGreaterThanOrEqual(2)
  })
})

describe('EOL 统计', () => {
  it('CRLF/LF/CR/混合', () => {
    expect(countEol(new TextEncoder().encode('a\r\nb\r\nc'))).toEqual({
      crlf: 2,
      lf: 0,
      cr: 0,
      mixed: false,
    })
    expect(countEol(new TextEncoder().encode('a\nb\n'))).toEqual({
      crlf: 0,
      lf: 2,
      cr: 0,
      mixed: false,
    })
    expect(countEol(new TextEncoder().encode('a\rb\rc'))).toEqual({
      crlf: 0,
      lf: 0,
      cr: 2,
      mixed: false,
    })
    expect(countEol(new TextEncoder().encode('a\r\nb\nc'))).toMatchObject({
      crlf: 1,
      lf: 1,
      mixed: true,
    })
  })

  it('多字节字符中的字节不误报（0D/0A 不会出现在 UTF-8 续字节）', () => {
    // 中 = E4 B8 AD；文 = E6 96 87
    expect(countEol(new Uint8Array([0xe4, 0xb8, 0xad, 0xe6, 0x96, 0x87]))).toEqual({
      crlf: 0,
      lf: 0,
      cr: 0,
      mixed: false,
    })
  })
})

describe('buildRevision（B1/B3）', () => {
  it('字节/哈希/元数据齐备且稳定', async () => {
    const bytes = new TextEncoder().encode('# 函数\n\n定义：$f(x)=x^2$\r\n')
    const f = fakeFile('数学/函数.md', bytes)
    const r = await buildRevision('p1', 'b1', f, bytes)
    expect(r.contentHash).toHaveLength(64)
    expect(r.bytes).toEqual(bytes) // B1：字节原样
    expect(r.eol).toMatchObject({ crlf: 1 })
    const r2 = await buildRevision('p1', 'b2', f, bytes)
    expect(r2.contentHash).toBe(r.contentHash)
    // B3：处理后字节不变（同一引用，内容未被修改）
    expect(new TextDecoder().decode(r.bytes)).toBe(new TextDecoder().decode(bytes))
  })

  it('解码有损声明：issues 非空 ⇔ lossy', async () => {
    const gbk = new Uint8Array([0xd6, 0xd0])
    const r = await buildRevision('p1', 'b1', fakeFile('x.md', gbk), gbk)
    expect(r.lossy).toBe(true)
    expect(r.issues.length).toBeGreaterThan(0)
  })
})
