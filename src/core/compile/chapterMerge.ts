/**
 * 按章整合提示词（纯函数）：把一章内各课时的提示词材料（编译稿或 AI 建议稿）
 * 按课时顺序合并为一份可整段粘贴到豆包爱学的整章提示词。
 *
 * 纪律（沿用基线护栏）：
 * - 整合是「聚合」不是「重写」——各课时材料逐字入稿，不丢失、不改写、不编造；
 * - 未生成提示词的课时保留占位说明（要求老师自行安排，禁止模型虚构该节内容）；
 * - 整合稿是派生数据：缓存走 ui 层（localStorage，同 AI 建议稿缓存纪律），不进 IndexedDB 主数据链。
 */

export type ChapterMergeKind = 'ai' | 'compiled'
export type ChapterMergePartKind = ChapterMergeKind | 'missing'

export interface ChapterMergePart {
  lessonId: string
  title: string
  kind: ChapterMergePartKind
  /** 采用材料的全文（missing 为空串） */
  text: string
}

export const PART_KIND_LABEL: Record<ChapterMergePartKind, string> = {
  ai: 'AI 稿',
  compiled: '编译稿',
  missing: '未生成',
}

/** 空白材料视为不存在（AI 缓存损坏/空串时兜底到编译稿） */
function hasText(s: string | null | undefined): boolean {
  return typeof s === 'string' && s.trim().length > 0
}

/**
 * 每课时取材：prefer='auto' 时 AI 稿优先、编译稿兜底；指定单一来源时只用该来源。
 * 两份材料都没有 → null（该课时记为 missing，整合稿中给占位说明）。
 */
export function pickLessonMaterial(
  prefer: 'auto' | ChapterMergeKind,
  compiled: string | null,
  ai: string | null,
): { kind: ChapterMergeKind; text: string } | null {
  if (prefer === 'auto') {
    if (hasText(ai)) return { kind: 'ai', text: ai! }
    if (hasText(compiled)) return { kind: 'compiled', text: compiled! }
    return null
  }
  const text = prefer === 'ai' ? ai : compiled
  return hasText(text) ? { kind: prefer, text: text! } : null
}

/** 整合快照：判断缓存的整合稿是否仍然有效只需比较各课时采用的材料 */
export interface ChapterMergeSnapshot {
  parts: ChapterMergePart[]
}

/** 缓存是否已过期：课时集合、顺序、取材来源或材料文本任一变化 */
export function chapterMergeStale(a: ChapterMergeSnapshot, b: ChapterMergeSnapshot): boolean {
  if (a.parts.length !== b.parts.length) return true
  for (let i = 0; i < a.parts.length; i++) {
    const x = a.parts[i]!
    const y = b.parts[i]!
    if (x.lessonId !== y.lessonId || x.kind !== y.kind || x.text !== y.text) return true
  }
  return false
}

export interface ChapterMergeOptions {
  chapter: string
  subject: string
  level: string
}

const MISSING_STUB =
  '（该课时提示词尚未生成。请老师按教材自行安排本节内容，不要虚构本节知识点；在应用中生成该课时提示词后可重新整合。）'

/** 把课时材料按序合并为一份整章提示词：外层协调说明 + 各课时原稿分块 */
export function buildChapterPrompt(parts: ChapterMergePart[], opts: ChapterMergeOptions): string {
  const ready = parts.filter((p) => p.kind !== 'missing')
  const lines: string[] = []
  lines.push(
    `【角色】你是一位${opts.level}${opts.subject}老师，正在用一次对话连续讲授一章的多节内容。请从第 1 课时开始按顺序授课：每个课时内严格遵循该课时自带的课堂流程推进，完成一个课时后再进入下一个，课时切换时用一两句话承上启下；不要引入提示词之外的新知识点。`,
  )
  lines.push(
    ready.length === parts.length
      ? `【本章】${opts.chapter}（共 ${parts.length} 个课时）`
      : `【本章】${opts.chapter}（共 ${parts.length} 个课时，其中 ${parts.length - ready.length} 个课时的提示词未生成，见对应占位说明）`,
  )
  lines.push('【课时清单】')
  parts.forEach((p, i) => {
    lines.push(`${i + 1}. ${p.title}（${PART_KIND_LABEL[p.kind]}）`)
  })
  lines.push(
    '【使用说明】下方每个「═══」分块是一个课时的完整课堂提示词，按清单顺序执行；各课时内凡标注「提问」处必须等待学生回答后再继续；公式按原文 LaTeX 输出；不得编造原文没有的结论、答案或练习。',
  )
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!
    lines.push('')
    lines.push(`═══ 第 ${i + 1} 课时：${p.title} ═══`)
    lines.push('')
    lines.push(p.kind === 'missing' ? MISSING_STUB : p.text)
  }
  return lines.join('\n')
}
