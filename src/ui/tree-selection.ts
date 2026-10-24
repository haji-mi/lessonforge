/**
 * 课时树多选的纯函数：章节分组排序 / 视觉顺序 / 区间选取 / 章节勾选状态 / 批量置值。
 * 从组件抽出以便 vitest 直接覆盖（跨章区间、反向拖拽、indeterminate 判定）。
 */

/** 按章节分组并按 zh-Hans-CN 排序章节名；章内保持 lessons 原顺序 */
export function groupByChapter<T extends { id: string; chapter: string }>(
  lessons: T[],
): [string, T[]][] {
  const m = new Map<string, T[]>()
  for (const l of lessons) {
    if (!m.has(l.chapter)) m.set(l.chapter, [])
    m.get(l.chapter)!.push(l)
  }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-Hans-CN'))
}

/** 树的视觉顺序（章节排序后扁平化）——滑选/Shift 范围/键盘导航一律按此顺序 */
export function orderedLessonIds<T extends { id: string; chapter: string }>(
  lessons: T[],
): string[] {
  return groupByChapter(lessons).flatMap(([, items]) => items.map((l) => l.id))
}

/** [a, b] 闭区间（含两端，方向无关）；任一端不在列表中返回空 */
export function rangeBetween(ordered: readonly string[], a: string, b: string): string[] {
  const ia = ordered.indexOf(a)
  const ib = ordered.indexOf(b)
  if (ia < 0 || ib < 0) return []
  const [lo, hi] = ia <= ib ? [ia, ib] : [ib, ia]
  return ordered.slice(lo, hi + 1)
}

export type ChapterCheckState = 'none' | 'partial' | 'all'

/** 章节勾选状态（驱动章节 checkbox 的 indeterminate 半选态） */
export function chapterCheckState(
  ids: readonly string[],
  checked: ReadonlySet<string>,
): ChapterCheckState {
  if (ids.length === 0) return 'none'
  let n = 0
  for (const id of ids) if (checked.has(id)) n++
  return n === 0 ? 'none' : n === ids.length ? 'all' : 'partial'
}

/** 批量置值：返回新 Set（不可变更新，不改动入参） */
export function setMany(
  prev: ReadonlySet<string>,
  ids: readonly string[],
  value: boolean,
): Set<string> {
  const next = new Set(prev)
  for (const id of ids) {
    if (value) next.add(id)
    else next.delete(id)
  }
  return next
}
