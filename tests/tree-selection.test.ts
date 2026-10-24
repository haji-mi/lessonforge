/**
 * 课时树多选纯函数单测：章节排序视觉顺序 / 区间（含反向与跨章）/ 章节勾选三态 / 批量置值。
 */
import { describe, expect, it } from 'vitest'
import {
  chapterCheckState,
  groupByChapter,
  orderedLessonIds,
  rangeBetween,
  setMany,
} from '../src/ui/tree-selection'

const L = (id: string, chapter: string) => ({ id, chapter })

describe('groupByChapter / orderedLessonIds', () => {
  it('章节按 localeCompare(zh-Hans-CN) 排序，乱序输入得到视觉顺序；未分章（空串）排最前', () => {
    const lessons = [L('a', 'B卷'), L('b', ''), L('c', 'A卷'), L('d', 'B卷'), L('e', 'B卷')]
    expect(groupByChapter(lessons).map(([ch]) => ch)).toEqual(['', 'A卷', 'B卷'])
    expect(orderedLessonIds(lessons)).toEqual(['b', 'c', 'a', 'd', 'e'])
  })

  it('中文章节名输出与 locale 排序一致、分组不丢失（不硬编码拼音序）', () => {
    const lessons = [L('a', '第二章'), L('b', '附录'), L('c', '第一章'), L('d', '第二章')]
    const chs = groupByChapter(lessons).map(([ch]) => ch)
    expect(new Set(chs)).toEqual(new Set(['第一章', '第二章', '附录']))
    expect(chs).toEqual([...chs].sort((x, y) => x.localeCompare(y, 'zh-Hans-CN')))
    expect(orderedLessonIds(lessons).sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('章内保持输入顺序；单章节恒等', () => {
    const lessons = [L('x', 'ch'), L('y', 'ch'), L('z', 'ch')]
    expect(orderedLessonIds(lessons)).toEqual(['x', 'y', 'z'])
  })
})

describe('rangeBetween', () => {
  const ordered = ['b', 'c', 'a', 'd', 'e'] // 视觉顺序：b < c < a < d < e

  it('正向区间含两端', () => {
    expect(rangeBetween(ordered, 'b', 'a')).toEqual(['b', 'c', 'a'])
  })

  it('反向拖拽（从下往上）同样生效', () => {
    expect(rangeBetween(ordered, 'e', 'c')).toEqual(['c', 'a', 'd', 'e'])
  })

  it('同一点只含自身', () => {
    expect(rangeBetween(ordered, 'd', 'd')).toEqual(['d'])
  })

  it('任一端不在列表中返回空（如课时被删除）', () => {
    expect(rangeBetween(ordered, 'b', 'zzz')).toEqual([])
    expect(rangeBetween(ordered, 'zzz', 'b')).toEqual([])
    expect(rangeBetween([], 'b', 'b')).toEqual([])
  })

  it('跨章拖拽覆盖中间章节全部课时（连续区间语义）', () => {
    // c 属第一章，a/d/e 属第二章：c→e 覆盖整章二
    expect(rangeBetween(ordered, 'c', 'e')).toEqual(['c', 'a', 'd', 'e'])
  })
})

describe('chapterCheckState', () => {
  const checked = new Set(['a', 'b'])

  it('none / partial / all 三态', () => {
    expect(chapterCheckState(['x', 'y'], checked)).toBe('none')
    expect(chapterCheckState(['a', 'x'], checked)).toBe('partial')
    expect(chapterCheckState(['a', 'b'], checked)).toBe('all')
    expect(chapterCheckState(['a'], checked)).toBe('all')
  })

  it('空章节按 none 处理（渲染层不显示半选）', () => {
    expect(chapterCheckState([], checked)).toBe('none')
  })
})

describe('setMany', () => {
  it('批量勾上/取消；不改动原 Set（不可变更新）', () => {
    const prev = new Set(['a'])
    const next = setMany(prev, ['b', 'c'], true)
    expect([...next].sort()).toEqual(['a', 'b', 'c'])
    expect(prev.has('b')).toBe(false)
    const next2 = setMany(next, ['a', 'b'], false)
    expect([...next2]).toEqual(['c'])
    expect(next.has('a')).toBe(true)
  })

  it('空列表是 no-op', () => {
    const prev = new Set(['a'])
    expect(setMany(prev, [], true)).toEqual(prev)
  })
})
