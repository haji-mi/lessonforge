/**
 * 按章整合单测：取材选择（auto/指定来源/空白兜底）、整合稿结构（外层协调头 +
 * 课时分块顺序 + 未生成占位）、缓存过期判定、localStorage 缓存读写（全 stub，零网络）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildChapterPrompt,
  chapterMergeStale,
  pickLessonMaterial,
  type ChapterMergePart,
} from '../src/core/compile/chapterMerge'
import {
  clearChapterMergeCache,
  loadChapterMergeCache,
  saveChapterMergeCache,
} from '../src/ui/chapter-merge'

function stubLs(): Map<string, string> {
  const m = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  })
  return m
}

function part(p: Partial<ChapterMergePart>): ChapterMergePart {
  return {
    lessonId: p.lessonId ?? 'L1',
    title: p.title ?? '1.1 课时',
    kind: p.kind ?? 'compiled',
    text: p.text ?? 'COMPILED',
  }
}

let store: Map<string, string>
beforeEach(() => {
  store = stubLs()
})

describe('pickLessonMaterial 取材选择', () => {
  it('auto：AI 稿优先，编译稿兜底', () => {
    expect(pickLessonMaterial('auto', 'C', 'A')).toEqual({ kind: 'ai', text: 'A' })
    expect(pickLessonMaterial('auto', 'C', null)).toEqual({ kind: 'compiled', text: 'C' })
  })

  it('auto：两份都没有 → null；空白串视为不存在', () => {
    expect(pickLessonMaterial('auto', null, null)).toBeNull()
    expect(pickLessonMaterial('auto', '  ', '')).toBeNull()
    // AI 稿为空白 → 兜底编译稿
    expect(pickLessonMaterial('auto', 'C', '  ')).toEqual({ kind: 'compiled', text: 'C' })
  })

  it('指定单一来源：只取该来源，另一份再好也不用', () => {
    expect(pickLessonMaterial('compiled', 'C', 'A')).toEqual({ kind: 'compiled', text: 'C' })
    expect(pickLessonMaterial('ai', 'C', 'A')).toEqual({ kind: 'ai', text: 'A' })
    expect(pickLessonMaterial('ai', 'C', null)).toBeNull()
    expect(pickLessonMaterial('compiled', null, 'A')).toBeNull()
  })
})

describe('buildChapterPrompt 整合结构', () => {
  it('外层协调头 + 课时清单 + 分块按序包含各课时原稿', () => {
    const t = buildChapterPrompt(
      [
        part({ lessonId: 'a', title: '1.1 概念', kind: 'compiled', text: 'COMPILED-A' }),
        part({ lessonId: 'b', title: '1.2 例题', kind: 'ai', text: 'AI-B' }),
      ],
      { chapter: '第一章 函数', subject: '数学', level: '高中' },
    )
    expect(t).toContain('【角色】你是一位高中数学老师')
    expect(t).toContain('【本章】第一章 函数（共 2 个课时）')
    expect(t).toContain('1. 1.1 概念（编译稿）')
    expect(t).toContain('2. 1.2 例题（AI 稿）')
    expect(t).toContain('═══ 第 1 课时：1.1 概念 ═══')
    expect(t).toContain('═══ 第 2 课时：1.2 例题 ═══')
    expect(t).toContain('COMPILED-A')
    expect(t).toContain('AI-B')
    // 分块顺序 = 传入顺序
    expect(t.indexOf('COMPILED-A')).toBeLessThan(t.indexOf('AI-B'))
  })

  it('未生成的课时给占位说明（禁止虚构），并在章头注明数量', () => {
    const t = buildChapterPrompt(
      [
        part({ lessonId: 'a', title: '1.1', kind: 'compiled', text: 'C-A' }),
        part({ lessonId: 'b', title: '1.2', kind: 'missing', text: '' }),
      ],
      { chapter: '第一章', subject: '数学', level: '高中' },
    )
    expect(t).toContain('其中 1 个课时的提示词未生成')
    expect(t).toContain('1. 1.1（编译稿）')
    expect(t).toContain('2. 1.2（未生成）')
    expect(t).toContain('不要虚构本节知识点')
  })
})

describe('chapterMergeStale 过期判定', () => {
  const base: ChapterMergePart[] = [
    part({ lessonId: 'a', kind: 'compiled', text: 'C-A' }),
    part({ lessonId: 'b', kind: 'ai', text: 'A-B' }),
  ]

  it('相同快照不过期', () => {
    expect(chapterMergeStale({ parts: base }, { parts: base.map((p) => ({ ...p })) })).toBe(false)
  })

  it('材料文本 / 取材来源 / 课时增删 / 顺序任一变化都过期', () => {
    expect(
      chapterMergeStale({ parts: base }, { parts: [base[0]!, { ...base[1]!, text: 'A-B2' }] }),
    ).toBe(true)
    expect(
      chapterMergeStale({ parts: base }, { parts: [base[0]!, { ...base[1]!, kind: 'compiled' }] }),
    ).toBe(true)
    expect(chapterMergeStale({ parts: base }, { parts: [base[0]!] })).toBe(true)
    expect(chapterMergeStale({ parts: base }, { parts: [...base].reverse() })).toBe(true)
  })
})

describe('整合稿缓存（localStorage）', () => {
  const cache = {
    at: 1_700_000_000_000,
    parts: [part({ lessonId: 'a' })],
    text: 'MERGED',
    edited: false,
  }

  it('保存后可读回；清除后为空', () => {
    saveChapterMergeCache('p1', '第一章', cache)
    expect(loadChapterMergeCache('p1', '第一章')).toEqual(cache)
    clearChapterMergeCache('p1', '第一章')
    expect(loadChapterMergeCache('p1', '第一章')).toBeNull()
  })

  it('按（项目, 章节）分键互不干扰', () => {
    saveChapterMergeCache('p1', '第一章', cache)
    saveChapterMergeCache('p1', '第二章', { ...cache, text: 'M2' })
    saveChapterMergeCache('p2', '第一章', { ...cache, text: 'M3' })
    expect(loadChapterMergeCache('p1', '第一章')!.text).toBe('MERGED')
    expect(loadChapterMergeCache('p1', '第二章')!.text).toBe('M2')
    expect(loadChapterMergeCache('p2', '第一章')!.text).toBe('M3')
  })

  it('损坏数据返回 null 而非抛错', () => {
    store.set('cc-chapter-merge:p1:ch', '{oops')
    expect(loadChapterMergeCache('p1', 'ch')).toBeNull()
    store.set('cc-chapter-merge:p1:ch', '{"text":""}')
    expect(loadChapterMergeCache('p1', 'ch')).toBeNull()
  })
})
