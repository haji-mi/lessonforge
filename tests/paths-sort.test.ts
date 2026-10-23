/** P1d：路径规范化、安全检查、自然排序（中文/数字/中文数字） */
import { describe, expect, it } from 'vitest'
import {
  buildFileTree,
  chineseNumeralToNumber,
  compareEntries,
  normalizeRelPath,
  safeEntryPath,
  sortKeyHint,
} from '../src/core/import/paths'

describe('路径规范化', () => {
  it('反斜杠/点段/重复斜杠/前导斜杠', () => {
    expect(normalizeRelPath('数学\\第1章\\函数.md')).toBe('数学/第1章/函数.md')
    expect(normalizeRelPath('./数学/函数.md')).toBe('数学/函数.md')
    expect(normalizeRelPath('数学//第1章///函数.md')).toBe('数学/第1章/函数.md')
    expect(normalizeRelPath('/根/文件.md')).toBe('根/文件.md')
    expect(normalizeRelPath('a/./b/../c.md')).toBe('a/b/../c.md') // .. 不在此处理
  })

  it('安全检查通过', () => {
    expect(safeEntryPath('数学/第1章/函数.md')).toEqual({ ok: true, path: '数学/第1章/函数.md' })
    expect(safeEntryPath('a\\b\\c.md')).toEqual({ ok: true, path: 'a/b/c.md' })
  })

  it('安全检查拒绝：遍历/绝对/盘符/UNC/控制字符/超长/保留设备名', () => {
    expect(safeEntryPath('../evil.md')).toMatchObject({ ok: false, reason: 'TRAVERSAL' })
    expect(safeEntryPath('..\\evil.md')).toMatchObject({ ok: false, reason: 'TRAVERSAL' })
    expect(safeEntryPath('a/../../b.md')).toMatchObject({ ok: false, reason: 'TRAVERSAL' })
    expect(safeEntryPath('/abs/path.md')).toMatchObject({ ok: false, reason: 'ABSOLUTE' })
    expect(safeEntryPath('C:\\temp\\x.md')).toMatchObject({ ok: false, reason: 'DRIVE_LETTER' })
    expect(safeEntryPath('\\\\server\\share\\x.md')).toMatchObject({ ok: false, reason: 'UNC' })
    expect(safeEntryPath('bad\u0000name.md')).toMatchObject({ ok: false, reason: 'CONTROL_CHARS' })
    expect(safeEntryPath('x'.repeat(600))).toMatchObject({ ok: false, reason: 'NAME_TOO_LONG' })
    expect(safeEntryPath('CON.md')).toMatchObject({ ok: false, reason: 'RESERVED_DEVICE' })
    expect(safeEntryPath('目录/com1.txt')).toMatchObject({ ok: false, reason: 'RESERVED_DEVICE' })
  })
})

describe('中文数字与排序', () => {
  it('中文数字转换', () => {
    expect(chineseNumeralToNumber('一')).toBe(1)
    expect(chineseNumeralToNumber('十')).toBe(10)
    expect(chineseNumeralToNumber('十二')).toBe(12)
    expect(chineseNumeralToNumber('二十三')).toBe(23)
    expect(chineseNumeralToNumber('一百零五')).toBe(105)
    expect(chineseNumeralToNumber('三百')).toBe(300)
    expect(chineseNumeralToNumber('两千零一')).toBe(2001)
    expect(chineseNumeralToNumber('abc')).toBeNull()
  })

  it('排序键提示：第X章 中文数字 → 零填充', () => {
    expect(sortKeyHint('第二章.md', true)).toBe('第0002章.md')
    expect(sortKeyHint('第二十三章.md', true)).toBe('第0023章.md')
    expect(sortKeyHint('第10章.md', true)).toBe('第0010章.md')
    expect(sortKeyHint('第二章.md', false)).toBe('第二章.md')
  })

  it('自然排序：数字感知', () => {
    const names = ['第10章.md', '第2章.md', '第1章.md']
    const sorted = names.sort((a, b) =>
      compareEntries({ name: a, kind: 'file' }, { name: b, kind: 'file' }),
    )
    expect(sorted).toEqual(['第1章.md', '第2章.md', '第10章.md'])
    const versions = ['1.10.md', '1.2.md']
    expect(
      versions.sort((a, b) => compareEntries({ name: a, kind: 'file' }, { name: b, kind: 'file' })),
    ).toEqual(['1.2.md', '1.10.md'])
  })

  it('自然排序：中文数字映射开启后 第2章 < 第十章', () => {
    const cmp = (a: string, b: string) =>
      compareEntries({ name: a, kind: 'file' }, { name: b, kind: 'file' }, true)
    expect(cmp('第二章.md', '第十章.md')).toBeLessThan(0)
    expect(cmp('第十章.md', '第二章.md')).toBeGreaterThan(0)
    // 关闭映射时按默认 collator（"十" 与 "二" 的拼音序）
    const cmpOff = (a: string, b: string) =>
      compareEntries({ name: a, kind: 'file' }, { name: b, kind: 'file' }, false)
    expect(typeof cmpOff('第二章.md', '第十章.md')).toBe('number')
  })

  it('中文拼音排序', () => {
    const names = ['语文.md', '数学.md', '英语.md']
    const sorted = names.sort((a, b) =>
      compareEntries({ name: a, kind: 'file' }, { name: b, kind: 'file' }),
    )
    expect(sorted).toEqual(['数学.md', '英语.md', '语文.md'])
  })

  it('文件树：嵌套目录 + 不同目录同名文件 + 排序', () => {
    const tree = buildFileTree([
      { normPath: '课程/第10章/a.md', byteSize: 1 },
      { normPath: '课程/第2章/a.md', byteSize: 2 },
      { normPath: '课程/第2章/b.md', byteSize: 3 },
      { normPath: '课程/封面.md', byteSize: 4 },
    ])
    const course = tree.children.find((c) => c.name === '课程')!
    expect(course.children.map((c) => c.name)).toEqual(['第2章', '第10章', '封面.md'])
    const ch2 = course.children[0]!
    expect(ch2.children.map((c) => c.name)).toEqual(['a.md', 'b.md'])
    // 同名文件在不同目录下互不冲突
    expect(tree.children.length).toBe(1)
  })
})
