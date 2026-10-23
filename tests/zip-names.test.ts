/** P1a：ZIP 名称四类别判定 + 聚合判定 + 无静默错误性质测试 */
import { describe, expect, it } from 'vitest'
import { decideNames } from '../src/core/import/zip/names'
import { buildZip, gbkBytesOf, textBytes, toBlob, unicodePathExtra } from './helpers/zipbuilder'
import { scanZipBlob } from '../src/core/import/zip/scanner'

async function namesOf(specs: Parameters<typeof buildZip>[0], forced?: 'utf-8' | 'gbk') {
  const zip = buildZip(specs)
  const scan = await scanZipBlob(toBlob(zip))
  return { scan, names: decideNames(scan.entries, forced) }
}

/** 无静默错误性质：默认显示名正确，或存在可见双候选，或有诊断 */
function assertNoSilentError(names: ReturnType<typeof decideNames>, expected: Map<number, string>) {
  for (const o of names.outcomes) {
    const exp = expected.get(o.index)
    if (exp === undefined) continue
    const ok = o.display === exp || o.candidates.some((c) => c.text === exp)
    if (!ok) {
      expect(
        names.diagnostics.some((d) => d.severity === 'error'),
        `条目 ${o.index} 静默错误：display=${o.display}，期望 ${exp}`,
      ).toBe(true)
    }
  }
}

describe('名称四类别', () => {
  it('类别1：标志置位 + 严格 UTF-8 通过', async () => {
    const { names } = await namesOf([{ name: '数学/函数.md', data: textBytes('x'), flags: 0x800 }])
    const o = names.outcomes[0]!
    expect(o.category).toBe('flagged-utf8')
    expect(o.display).toBe('数学/函数.md')
    expect(o.needsChoice).toBe(false)
  })

  it('类别2：标志置位但解码失败 → 占位 + 候选 + 人工裁决 + 诊断', async () => {
    const { names } = await namesOf([
      { name: gbkBytesOf('数学.md'), data: textBytes('x'), flags: 0x800 }, // GBK 字节 + UTF-8 标志 = 声明损坏
      { name: 'ok.md', data: textBytes('y'), flags: 0x800 },
    ])
    const o = names.outcomes[0]!
    expect(o.category).toBe('flagged-invalid')
    expect(o.display).toMatch(/^⟨名称损坏·\d+字节⟩$/)
    expect(o.needsChoice).toBe(true)
    expect(o.candidates.some((c) => c.basis.includes('GBK'))).toBe(true)
    expect(names.diagnostics.some((d) => d.code === 'ZIP_NAME_UTF8_FLAG_INVALID')).toBe(true)
    // 不影响其他条目
    expect(names.outcomes[1]!.category).toBe('flagged-utf8')
  })

  it('类别3：0x7075 CRC 通过 → 直接采用', async () => {
    const nb = gbkBytesOf('课件.md')
    const { names } = await namesOf([
      { name: nb, data: textBytes('x'), extra: unicodePathExtra(nb, '课件.md') },
    ])
    expect(names.outcomes[0]!.category).toBe('extra-unicode')
    expect(names.outcomes[0]!.display).toBe('课件.md')
  })

  it('类别3-CRC 损坏：忽略字段 → 归入无标志 + 诊断', async () => {
    const nb = gbkBytesOf('课件.md')
    const { names } = await namesOf([
      { name: nb, data: textBytes('x'), extra: unicodePathExtra(nb, '课件.md', true) },
      { name: gbkBytesOf('其他.md'), data: textBytes('y') },
    ])
    expect(names.outcomes[0]!.category).toBe('no-flag')
    expect(names.diagnostics.some((d) => d.code === 'ZIP_NAME_EXTRA_CRC_MISMATCH')).toBe(true)
  })

  it('纯 ASCII：无歧义', async () => {
    const { names } = await namesOf([{ name: 'course/lesson-01.md', data: textBytes('x') }])
    expect(names.outcomes[0]!.category).toBe('ascii')
  })
})

describe('无标志组聚合判定', () => {
  it('GBK 组：任一严格 UTF-8 失败 → 组 GBK，名称正确', async () => {
    const { names } = await namesOf([
      { name: gbkBytesOf('数学/第1章/函数.md'), data: textBytes('x') },
      { name: gbkBytesOf('数学/第1章/集合.md'), data: textBytes('y') },
      { name: gbkBytesOf('数学/第2章/方程.md'), data: textBytes('z') },
    ])
    expect(names.groupMode).toBe('gbk')
    const expected = new Map([
      [0, '数学/第1章/函数.md'],
      [1, '数学/第1章/集合.md'],
      [2, '数学/第2章/方程.md'],
    ])
    for (const o of names.outcomes) expect(o.display).toBe(expected.get(o.index))
  })

  it('UTF-8 无标志组：全过 → 组 UTF-8；无歧义条目无候选，双合法条目候选可见', async () => {
    const dualValid = new Uint8Array([0xc4, 0xa1]) // GBK"摹" / UTF-8"ġ"（E3 实测字节）
    const { names } = await namesOf([
      { name: '数学/第1章/函数.md', data: textBytes('x') }, // 无标志 UTF-8；含 ASCII 后 GBK 严格解码不可能 → 无歧义
      { name: '数学/第1章/集合.md', data: textBytes('y') },
      { name: '数学/第2章/方程.md', data: textBytes('z') },
      { name: dualValid, data: textBytes('w') }, // 双解码合法且不同 → 候选可见
    ])
    expect(names.groupMode).toBe('utf-8')
    expect(names.outcomes[0]!.display).toBe('数学/第1章/函数.md')
    expect(names.outcomes[0]!.candidates).toHaveLength(0) // GBK 严格解码失败 → 无真实歧义
    expect(names.outcomes[0]!.needsChoice).toBe(false)
    const dual = names.outcomes[3]!
    expect(dual.display).toBe('ġ')
    expect(dual.candidates.some((c) => c.text === '摹' && c.basis.includes('GBK'))).toBe(true)
    expect(dual.needsChoice).toBe(false) // 非小样本：候选可见但不阻断
  })

  it('小样本弱化：单条双合法条目 → 强制人工裁决', async () => {
    const dualValid = new Uint8Array([0xc4, 0xa1]) // GBK"摹" / UTF-8"ġ"
    const { names } = await namesOf([{ name: dualValid, data: textBytes('x') }])
    expect(names.groupMode).toBe('utf-8')
    expect(names.outcomes[0]!.needsChoice).toBe(true)
    expect(names.outcomes[0]!.candidates.length).toBe(2)
  })

  it('小样本但无歧义（奇数 CJK 字符 → GBK 配对失败）→ 无需裁决', async () => {
    const { names } = await namesOf([{ name: '单.md', data: textBytes('x') }])
    expect(names.groupMode).toBe('utf-8')
    expect(names.outcomes[0]!.candidates).toHaveLength(0)
    expect(names.outcomes[0]!.needsChoice).toBe(false)
  })

  it('混合档案：多数 GBK + 少数 UTF-8 无标志 → 双候选可见（无静默错误）', async () => {
    const { names } = await namesOf([
      { name: gbkBytesOf('数学/第1章/函数.md'), data: textBytes('x') },
      { name: gbkBytesOf('数学/第1章/集合.md'), data: textBytes('y') },
      { name: gbkBytesOf('数学/第2章/方程.md'), data: textBytes('z') },
      { name: '英语/Unit1.md', data: textBytes('w') }, // UTF-8 无标志混入 GBK 组
    ])
    expect(names.groupMode).toBe('gbk')
    const mixed = names.outcomes[3]!
    expect(mixed.display).not.toBe('英语/Unit1.md') // 组默认解成 GBK 乱码
    // 但正确结果必须在候选中可见（无静默错误）
    expect(mixed.candidates.some((c) => c.text === '英语/Unit1.md')).toBe(true)
    assertNoSilentError(names, new Map([[3, '英语/Unit1.md']]))
  })

  it('混合档案反向：多数 UTF-8 + 单个 GBK → 组判 GBK，UTF-8 条目双候选可见（无静默错误）', async () => {
    const { names } = await namesOf([
      { name: '英语/Unit1.md', data: textBytes('x') },
      { name: '英语/Unit2.md', data: textBytes('y') },
      { name: '英语/Unit3.md', data: textBytes('z') },
      { name: gbkBytesOf('语文/课文.md'), data: textBytes('w') },
    ])
    // 聚合规则：组内任一条目严格 UTF-8 失败（GBK 条目必失败）→ 组默认 GBK
    expect(names.groupMode).toBe('gbk')
    // GBK 条目判对
    expect(names.outcomes[3]!.display).toBe('语文/课文.md')
    // UTF-8 条目默认解成 GBK 乱码，但正确结果必须在候选中可见
    for (const i of [0, 1, 2] as const) {
      expect(names.outcomes[i]!.display).not.toBe(`英语/Unit${i + 1}.md`)
      expect(names.outcomes[i]!.candidates.some((c) => c.text === `英语/Unit${i + 1}.md`)).toBe(
        true,
      )
    }
    assertNoSilentError(
      names,
      new Map([
        [0, '英语/Unit1.md'],
        [1, '英语/Unit2.md'],
        [2, '英语/Unit3.md'],
        [3, '语文/课文.md'],
      ]),
    )
  })

  it('双重失败 → Latin1 兜底 + 诊断 + 裁决', async () => {
    const { names } = await namesOf([
      { name: new Uint8Array([0xff, 0xfe, 0x2e, 0x6d, 0x64]), data: textBytes('x') }, // FF FE 均非法
      { name: gbkBytesOf('数学.md'), data: textBytes('y') },
    ])
    const o = names.outcomes[0]!
    expect(o.needsChoice).toBe(true)
    expect(names.diagnostics.some((d) => d.code === 'ZIP_NAME_UNDECODABLE')).toBe(true)
  })

  it('用户强制模式覆盖聚合判定', async () => {
    const { names } = await namesOf(
      [
        { name: gbkBytesOf('数学/第1章/函数.md'), data: textBytes('x') },
        { name: gbkBytesOf('数学/第1章/集合.md'), data: textBytes('y') },
      ],
      'utf-8',
    )
    expect(names.groupMode).toBe('utf-8')
    expect(names.groupBasis).toContain('用户指定')
    // GBK 名称按 UTF-8 显示为乱码，但 GBK 候选仍可见
    expect(names.outcomes[0]!.candidates.some((c) => c.basis.includes('GBK'))).toBe(true)
    assertNoSilentError(
      names,
      new Map([
        [0, '数学/第1章/函数.md'],
        [1, '数学/第1章/集合.md'],
      ]),
    )
  })
})
