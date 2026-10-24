/**
 * 按章整合稿的本地缓存（localStorage）：整合稿是派生数据，同 AI 建议稿缓存纪律，
 * 不进 IndexedDB 主数据链；按（项目, 章节）分键，刷新后仍可恢复——
 * 「先缓存整合，随取随用」。单元测用 localStorage stub（tests/chapter-merge.test.ts）。
 */
import type { ChapterMergePart } from '../core/compile/chapterMerge'

export interface ChapterMergeCache {
  /** 生成时间 */
  at: number
  /** 生成整合稿时各课时采用的材料（顺序 = 课时顺序；与当前材料比对判断过期） */
  parts: ChapterMergePart[]
  /** 整合稿全文（含用户手动编辑后的最新版） */
  text: string
  /** 用户是否手动编辑过（重新整合覆盖前提示） */
  edited: boolean
}

const cacheKey = (projectId: string, chapter: string) => `cc-chapter-merge:${projectId}:${chapter}`

export function loadChapterMergeCache(
  projectId: string,
  chapter: string,
): ChapterMergeCache | null {
  try {
    const raw =
      typeof localStorage === 'undefined'
        ? null
        : localStorage.getItem(cacheKey(projectId, chapter))
    if (!raw) return null
    const e = JSON.parse(raw) as ChapterMergeCache
    if (typeof e.text !== 'string' || !e.text || !Array.isArray(e.parts)) return null
    return e
  } catch {
    return null
  }
}

export function saveChapterMergeCache(
  projectId: string,
  chapter: string,
  cache: ChapterMergeCache,
): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(cacheKey(projectId, chapter), JSON.stringify(cache))
    }
  } catch {
    // 存储不可用（超限/隐私模式）：跳过缓存，功能仍可用
  }
}

export function clearChapterMergeCache(projectId: string, chapter: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(cacheKey(projectId, chapter))
  } catch {
    // 同上：存储不可用不影响主流程
  }
}
