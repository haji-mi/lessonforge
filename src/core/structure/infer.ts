/**
 * 课程结构推断（架构基线 §7）：信号 = 路径分段、名称模式（可配置默认）、frontmatter、标题。
 * 程序不含任何具体课程结构硬编码；每条推断附证据；人工调整持久化由上层（P4）处理。
 */
import { compareEntries } from '../import/paths'

export interface StructureLesson {
  path: string
  title: string
  titleBasis: string
}
export interface StructureChapter {
  name: string
  path: string
  evidence: string[]
  lessons: StructureLesson[]
  subChapters: StructureChapter[]
}
export interface StructureCourse {
  name: string
  evidence: string[]
  chapters: StructureChapter[]
  rootLessons: StructureLesson[]
}

export interface FileSignal {
  normPath: string
  headings: { depth: number; text: string }[]
  frontmatter?: Record<string, any> | null
}

/** 可配置的章节名称启发式（默认值，非硬编码结构） */
export const DEFAULT_CHAPTER_PATTERNS: RegExp[] = [
  /^第.{1,10}章/,
  /^第.{1,10}讲/,
  /^第.{1,10}课/,
  /^Chapter\s+\d+/i,
  /^Part\s+\d+/i,
  /^[上中下]\s*篇/,
  /^单元\s*\d*/,
  /^模块\s*\d*/,
]

const LESSON_NUM = /^(?:\d+[-_.、\s]+|L\d+[-_.\s]+|第.{1,6}课时[-_.\s]*)/

function chapterEvidence(name: string, mdCount: number, patterns: RegExp[]): string[] {
  const ev: string[] = []
  for (const p of patterns) {
    if (p.test(name)) {
      ev.push(`目录名匹配章节模式 ${p}`)
      break
    }
  }
  if (mdCount >= 2) ev.push(`目录直接包含 ${mdCount} 个 md 文件（≥2 → 分组为章节）`)
  return ev
}

function lessonTitle(file: FileSignal, fileName: string): { title: string; basis: string } {
  const fmTitle = file.frontmatter?.title ?? file.frontmatter?.课程名
  if (typeof fmTitle === 'string' && fmTitle) return { title: fmTitle, basis: 'frontmatter title' }
  const h1 = file.headings.find((h) => h.depth === 1)
  if (h1) return { title: h1.text.replace(/^#+\s*/, ''), basis: '首个 H1 标题' }
  const h2 = file.headings.find((h) => h.depth === 2)
  if (h2) return { title: h2.text.replace(/^#+\s*/, ''), basis: '首个 H2 标题（无 H1）' }
  const stem = fileName.replace(/\.md$/i, '')
  const numMatch = LESSON_NUM.exec(stem)
  return {
    title: numMatch ? stem.slice(numMatch[0].length) || stem : stem,
    basis: numMatch ? '文件名（去课时编号前缀）' : '文件名',
  }
}

export function inferStructure(
  files: FileSignal[],
  rootName: string,
  patterns: RegExp[] = DEFAULT_CHAPTER_PATTERNS,
): StructureCourse {
  // 单一根目录包裹全部文件 → 该目录为课程
  let courseName = rootName
  let courseEvidence = ['导入根目录名']
  const topSegs = new Set(files.map((f) => f.normPath.split('/')[0]!))
  const allSingleDir = [...topSegs].length === 1 && files.every((f) => f.normPath.includes('/'))
  let working = files
  if (allSingleDir && files.length >= 3) {
    const only = topSegs.values().next().value as string
    courseName = only
    courseEvidence = [`根下唯一子目录「${only}」含 ${files.length} 个 md → 该目录为课程`]
    working = files.map((f) => ({ ...f, normPath: f.normPath.slice(only.length + 1) }))
  }

  // 目录树
  interface DirNode {
    name: string
    path: string
    dirs: Map<string, DirNode>
    files: FileSignal[]
  }
  const root: DirNode = { name: '', path: '', dirs: new Map(), files: [] }
  for (const f of working) {
    const segs = f.normPath.split('/')
    let cur = root
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i]!
      let next = cur.dirs.get(seg)
      if (!next) {
        next = {
          name: seg,
          path: cur.path ? `${cur.path}/${seg}` : seg,
          dirs: new Map(),
          files: [],
        }
        cur.dirs.set(seg, next)
      }
      cur = next
    }
    cur.files.push({ ...f, normPath: segs.join('/') })
  }

  const buildChapter = (dir: DirNode): StructureChapter => {
    const lessons: StructureLesson[] = dir.files.map((f) => {
      const fileName = f.normPath.split('/').pop()!
      const t = lessonTitle(f, fileName)
      return { path: f.normPath, title: t.title, titleBasis: t.basis }
    })
    lessons.sort((a, b) =>
      compareEntries({ name: a.path, kind: 'file' }, { name: b.path, kind: 'file' }),
    )
    const evidence = chapterEvidence(dir.name, dir.files.length, patterns)
    const subChapters: StructureChapter[] = []
    for (const sub of dir.dirs.values()) {
      if (countMd(sub) > 0) subChapters.push(buildChapter(sub))
    }
    subChapters.sort((a, b) =>
      compareEntries({ name: a.name, kind: 'dir' }, { name: b.name, kind: 'dir' }),
    )
    return { name: dir.name, path: dir.path, evidence, lessons, subChapters }
  }

  const countMd = (d: { dirs: Map<string, any>; files: unknown[] }): number =>
    d.files.length + [...d.dirs.values()].reduce((s, x) => s + countMd(x), 0)

  const chapters: StructureChapter[] = []
  for (const dir of root.dirs.values()) {
    if (countMd(dir) > 0) chapters.push(buildChapter(dir))
  }
  chapters.sort((a, b) =>
    compareEntries({ name: a.name, kind: 'dir' }, { name: b.name, kind: 'dir' }),
  )

  const rootLessons = root.files.map((f) => {
    const fileName = f.normPath.split('/').pop()!
    const t = lessonTitle(f, fileName)
    return { path: f.normPath, title: t.title, titleBasis: t.basis }
  })
  rootLessons.sort((a, b) =>
    compareEntries({ name: a.path, kind: 'file' }, { name: b.path, kind: 'file' }),
  )
  if (rootLessons.length > 0 && chapters.length > 0) {
    courseEvidence.push(`根目录散落 ${rootLessons.length} 个 md（未分章节）`)
  }

  return { name: courseName, evidence: courseEvidence, chapters, rootLessons }
}
