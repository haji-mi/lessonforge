/** P1 端到端：ZIP 导入（扫描 → 名称 → 确认选项 → 守卫解压 → ImportedFile） */
import { describe, expect, it } from 'vitest'
import { importZipEntries, scanZip } from '../src/core/import/zip/importZip'
import {
  buildZip,
  gbkBytesOf,
  textBytes,
  toBlob,
  unicodePathExtra,
  type ZipEntrySpec,
} from './helpers/zipbuilder'

async function run(specs: ZipEntrySpec[], opts: Parameters<typeof importZipEntries>[2] = {}) {
  const blob = toBlob(buildZip(specs))
  const scan = await scanZip(blob)
  return { scan, result: await importZipEntries(blob, scan, opts) }
}

describe('ZIP 端到端导入', () => {
  it('正常导入：md + 图片入库，其他类型记录清单', async () => {
    const { result } = await run([
      { name: '数学/第1章/函数.md', data: textBytes('# 函数\n\n内容') },
      { name: '数学/第1章/图.png', data: new Uint8Array([1, 2, 3]), method: 0 },
      { name: '数学/notes.txt', data: textBytes('忽略') },
      { name: '数学/', data: new Uint8Array(0), method: 0 },
    ])
    expect(result.files.map((f) => f.normPath)).toEqual(['数学/第1章/函数.md', '数学/第1章/图.png'])
    expect(result.files[0]!.kind).toBe('md')
    expect(result.files[1]!.kind).toBe('image')
    expect(result.otherFiles).toEqual([{ path: '数学/notes.txt', size: 6 }])
  })

  it('GBK 名称组正确解码并导入', async () => {
    const { result } = await run([
      { name: gbkBytesOf('数学/第1章/函数.md'), data: textBytes('# 函数') },
      { name: gbkBytesOf('数学/第1章/集合.md'), data: textBytes('# 集合') },
    ])
    expect(result.files.map((f) => f.normPath).sort()).toEqual([
      '数学/第1章/函数.md',
      '数学/第1章/集合.md',
    ])
  })

  it('ZIP Slip：../ 与绝对路径与盘符全部拒绝，其余照常', async () => {
    const { result } = await run([
      { name: '../evil.md', data: textBytes('evil'), method: 0 },
      { name: '..\\windows\\evil2.md', data: textBytes('evil'), method: 0 },
      { name: '/abs.md', data: textBytes('x'), method: 0 },
      { name: 'C:\\sys.md', data: textBytes('x'), method: 0 },
      { name: 'safe.md', data: textBytes('ok'), method: 0 },
    ])
    expect(result.files.map((f) => f.normPath)).toEqual(['safe.md'])
    expect(result.diagnostics.filter((d) => d.code === 'ZIP_PATH_UNSAFE')).toHaveLength(4)
  })

  it('名称损坏条目：用户选择后导入', async () => {
    const blob = toBlob(
      buildZip([
        { name: gbkBytesOf('数学.md'), data: textBytes('x'), flags: 0x800 }, // 声明 UTF-8 但内容 GBK
        { name: 'ok.md', data: textBytes('y') },
      ]),
    )
    const scan = await scanZip(blob)
    expect(scan.names.outcomes[0]!.needsChoice).toBe(true)
    const result = await importZipEntries(blob, scan, {
      nameChoices: new Map([[0, '数学（人工确认）.md']]),
    })
    expect(result.files.map((f) => f.normPath)).toContain('数学（人工确认）.md')
  })

  it('0x7075：CRC 通过直接采用', async () => {
    const nb = gbkBytesOf('课件.md')
    const { result } = await run([
      { name: nb, data: textBytes('x'), extra: unicodePathExtra(nb, '课件.md') },
    ])
    expect(result.files[0]!.normPath).toBe('课件.md')
  })

  it('加密条目跳过 + 诊断', async () => {
    const { result } = await run([{ name: 'secret.md', data: textBytes('x'), flags: 0x1 }])
    expect(result.files).toHaveLength(0)
    expect(result.diagnostics.some((d) => d.code === 'ZIP_ENCRYPTED')).toBe(true)
  })

  it('不支持的方法跳过 + 诊断', async () => {
    const { result } = await run([{ name: 'x.md', data: textBytes('x'), method: 12 }])
    expect(result.files).toHaveLength(0)
    expect(result.diagnostics.some((d) => d.code === 'ZIP_METHOD_UNSUPPORTED')).toBe(true)
  })

  it('规范化重名 → 后缀去重 + 诊断', async () => {
    const { result } = await run([
      { name: 'a/notes.md', data: textBytes('1'), method: 0 },
      { name: 'a\\notes.md', data: textBytes('2'), method: 0 }, // 反斜杠规范化后同名
    ])
    expect(result.files.map((f) => f.normPath).sort()).toEqual(['a/notes (2).md', 'a/notes.md'])
    expect(result.diagnostics.some((d) => d.code === 'ZIP_NAME_COLLISION')).toBe(true)
  })

  it('CRC 损坏条目拒收，其余照常（故障隔离 B4）', async () => {
    const good = textBytes('# 好\n')
    const { result } = await run([
      { name: 'a.md', data: good, method: 0 },
      { name: 'b.md', data: textBytes('内容'), method: 0, crcOverride: 0x12345678 },
      { name: 'c.md', data: good, method: 0 },
    ])
    expect(result.files.map((f) => f.normPath)).toEqual(['a.md', 'c.md'])
    expect(result.diagnostics.some((d) => d.code === 'ZIP_CRC_MISMATCH')).toBe(true)
  })

  it('整档预算耗尽 → 截断标记 + 诊断', async () => {
    const data = textBytes('x'.repeat(600 * 1024))
    const { result } = await run(
      [
        { name: 'a.md', data, method: 0 },
        { name: 'b.md', data, method: 0 },
        { name: 'c.md', data, method: 0 },
      ],
      { limits: { totalBudget: 1024 * 1024 } },
    )
    expect(result.truncatedByTotalBudget).toBe(true)
    expect(result.files).toHaveLength(1)
    expect(result.diagnostics.some((d) => d.code === 'ZIP_TOTAL_BUDGET_EXCEEDED')).toBe(true)
  })

  it('单条目声明超预算 → 快速失败拒收', async () => {
    const { result } = await run([
      { name: 'big.md', data: new Uint8Array(0), method: 0, uncompSizeOverride: 999 * 1024 * 1024 },
    ])
    expect(result.files).toHaveLength(0)
    expect(result.diagnostics.some((d) => d.code === 'ZIP_BUDGET_EXCEEDED')).toBe(true)
  })

  it('强制模式重扫：UTF-8 强制后组模式与显示名变化', async () => {
    const blob = toBlob(buildZip([{ name: gbkBytesOf('数学.md'), data: textBytes('x') }]))
    const auto = await scanZip(blob)
    expect(auto.names.groupMode).toBe('gbk')
    const forced = await scanZip(blob, 'utf-8')
    expect(forced.names.groupMode).toBe('utf-8')
    expect(forced.names.groupBasis).toContain('用户指定')
  })
})
