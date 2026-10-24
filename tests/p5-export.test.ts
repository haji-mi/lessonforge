/** P5：导出层（文件名净化/批量 ZIP 重名去重/剪贴板降级不可测部分仅测纯函数） */
import { describe, expect, it } from 'vitest'
import { unzipSync } from 'fflate'
import type { LessonPlan } from '../src/core/compile/compile'
import {
  exportLessonsZip,
  lessonFileName,
  lessonToMarkdown,
  sanitizeFileName,
} from '../src/core/export/exporters'

function fakePlan(title: string): LessonPlan {
  return {
    lessonId: 'l1',
    lessonTitle: title,
    lessonPath: `课程/${title}.md`,
    type: 'concept',
    typeEvidence: [],
    typeAmbiguous: false,
    compilerVersion: 1,
    promptSchemaVersion: 1,
    sections: [
      {
        sectionId: 's1',
        role: '核心定义',
        contentType: 'A',
        content: '定义原文',
        traces: [{ file: `课程/${title}.md`, start: 0, end: 4 }],
      },
    ],
    coverage: {
      coreTotal: 1,
      coreHandled: 1,
      uncovered: [],
      uncoveredRelated: [],
      excluded: [],
    },
    warnings: [],
    promptText: `【角色】你是一位高中数学老师…\n【课题】${title}`,
  }
}

describe('导出层', () => {
  it('文件名净化：Windows 非法字符与控制字符', () => {
    expect(sanitizeFileName('第1章: 函数*与?方程')).toBe('第1章_ 函数_与_方程')
    expect(sanitizeFileName('a/b\\c|d<"e">f')).toBe('a_b_c_d__e__f')
    expect(sanitizeFileName('')).toBe('未命名')
    expect(sanitizeFileName('正常名字.md')).toBe('正常名字.md')
  })

  it('课时 Markdown：含溯源注释头 + 提示词全文', () => {
    const md = lessonToMarkdown(fakePlan('函数'), {
      title: '函数',
      chapter: '第1章',
      orderKey: 'L01',
    })
    expect(md).toContain('LessonForge 导出')
    expect(md).toContain('课时：函数')
    expect(md).toContain('# 函数')
    expect(md).toContain('【课题】函数')
  })

  it('批量 ZIP：重名去重 + 可解压回读', () => {
    const blob = exportLessonsZip([
      { plan: fakePlan('函数'), meta: { title: '函数', chapter: '第1章', orderKey: 'L01' } },
      { plan: fakePlan('函数'), meta: { title: '函数', chapter: '第2章', orderKey: 'L01' } },
      { plan: fakePlan('方程'), meta: { title: '方程', chapter: '第1章', orderKey: 'L02' } },
    ])
    // Node 下读回 Blob
    return blob.arrayBuffer().then((buf) => {
      const unzipped = unzipSync(new Uint8Array(buf))
      const names = Object.keys(unzipped).sort()
      expect(names).toEqual(['L01-函数 (2).md', 'L01-函数.md', 'L02-方程.md'].sort())
      const text = new TextDecoder().decode(unzipped['L01-函数.md']!)
      expect(text).toContain('【课题】函数')
    })
  })

  it('lessonFileName 净化合入', () => {
    expect(lessonFileName({ title: 'a:b', chapter: 'c', orderKey: 'L01' })).toBe('L01-a_b.md')
  })
})
