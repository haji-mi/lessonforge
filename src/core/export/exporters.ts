/**
 * 导出层（架构基线 §2 边界层）：剪贴板 / 单课时 Markdown / 批量 ZIP / 项目 JSON。
 * 文件名净化（Windows 非法字符 + 重名去重）；剪贴板降级 execCommand。
 */
import { strToU8, zipSync, type Zippable } from 'fflate'
import type { LessonPlan } from '../compile/compile'

const ILLEGAL = /[\\/:*?"<>|]/g
// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u001f\u007f]/g

export function sanitizeFileName(name: string): string {
  const cleaned = name.replace(ILLEGAL, '_').replace(CTRL, '').trim()
  return cleaned || '未命名'
}

export interface LessonExportMeta {
  title: string
  chapter: string
  orderKey: string
}

/** 提示词文本（编辑后合成文本）→ 课时 Markdown 文档 */
export function lessonToMarkdown(plan: LessonPlan, meta: LessonExportMeta): string {
  const header = [
    `<!-- LessonForge 导出 -->`,
    `<!-- 课时：${meta.title} | 章节：${meta.chapter} | 课型：${plan.type} -->`,
    `<!-- 编译器 v${plan.compilerVersion}，脚手架 v${plan.promptSchemaVersion}；A 段可溯源至原笔记 -->`,
    '',
    `# ${meta.title}`,
    '',
  ].join('\n')
  return header + plan.promptText + '\n'
}

export function lessonFileName(meta: LessonExportMeta): string {
  return `${sanitizeFileName(meta.orderKey)}-${sanitizeFileName(meta.title)}.md`
}

/** 批量导出：每课时一个 .md，打包为 ZIP（fflate zipSync） */
export function exportLessonsZip(lessons: { plan: LessonPlan; meta: LessonExportMeta }[]): Blob {
  const files: Zippable = {}
  const used = new Set<string>()
  for (const { plan, meta } of lessons) {
    let name = lessonFileName(meta)
    if (used.has(name)) {
      const dot = name.lastIndexOf('.')
      let n = 2
      while (used.has(`${name.slice(0, dot)} (${n})${name.slice(dot)}`)) n++
      name = `${name.slice(0, dot)} (${n})${name.slice(dot)}`
    }
    used.add(name)
    files[name] = strToU8(lessonToMarkdown(plan, meta))
  }
  return new Blob([zipSync(files) as unknown as BlobPart])
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = sanitizeFileName(fileName)
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // file:// 或权限受限时降级 execCommand
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}
