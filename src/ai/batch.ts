/**
 * AI 批量转化编排（ai 边界层）：勾选多篇课时 → 逐篇顺序转化。
 * 纪律：顺序执行（OpenRouter 免费档 ~20 请求/分钟，篇间加间隔保险）；
 * 单篇失败不阻断批次（B4 隔离语义），结束时逐篇点名报告；结果按课时写入
 * localStorage 缓存（与单篇面板同一份，材料指纹标记）。
 */
import { DEFAULT_PROMPT_SETTINGS } from '../core/compile/compile'
import { aiTransformLesson, fingerprint, saveAiCache, type AiTransformMode } from './transform'

export interface BatchLessonInput {
  lessonId: string
  title: string
  typeLabel: string
  /** 已编译则润色编译稿；否则用原文重写 */
  promptText: string | null
  noteText: string | null
}

export interface BatchOutcome {
  lessonId: string
  title: string
  ok: boolean
  model?: string
  mode?: AiTransformMode
  detail: string
}

export interface BatchProgress {
  done: number
  total: number
  currentTitle: string | null
}

export interface BatchOptions {
  /** 测试注入；生产用 aiTransformLesson */
  transform?: typeof aiTransformLesson
  /** 篇间间隔毫秒（默认 2500，免费档限流保险；测试传 0） */
  gapMs?: number
  onProgress?: (p: BatchProgress) => void
  /** 返回 true 时在当前篇完成后停止批次（不中断进行中的单篇请求）；已完成的保留 */
  isCancelled?: () => boolean
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export function pickBatchMode(l: BatchLessonInput): AiTransformMode | null {
  if (l.promptText) return 'polish'
  if (l.noteText) return 'rewrite'
  return null
}

export async function runBatchTransform(
  lessons: BatchLessonInput[],
  opts: BatchOptions = {},
): Promise<{ outcomes: BatchOutcome[]; ok: number; failed: number; cancelled: boolean }> {
  const transform = opts.transform ?? aiTransformLesson
  const gapMs = opts.gapMs ?? 2500
  const outcomes: BatchOutcome[] = []
  let cancelled = false
  for (let i = 0; i < lessons.length; i++) {
    if (opts.isCancelled?.()) {
      cancelled = true
      break
    }
    const l = lessons[i]!
    opts.onProgress?.({ done: i, total: lessons.length, currentTitle: l.title })
    const mode = pickBatchMode(l)
    if (!mode) {
      outcomes.push({
        lessonId: l.lessonId,
        title: l.title,
        ok: false,
        detail: '无可用材料（未编译且无原文修订版）',
      })
      continue
    }
    const source = mode === 'polish' ? l.promptText! : l.noteText!
    const t0 = Date.now()
    try {
      const r = await transform({
        mode,
        lessonTitle: l.title,
        typeLabel: l.typeLabel,
        subject: DEFAULT_PROMPT_SETTINGS.subject,
        level: DEFAULT_PROMPT_SETTINGS.level,
        sourceText: source,
      })
      saveAiCache(l.lessonId, {
        text: r.text,
        model: r.model,
        mode,
        at: Date.now(),
        sourceFingerprint: fingerprint(source),
      })
      outcomes.push({
        lessonId: l.lessonId,
        title: l.title,
        ok: true,
        model: r.model,
        mode,
        detail: `成功（${r.text.length} 字，${Date.now() - t0}ms）`,
      })
    } catch (e) {
      outcomes.push({
        lessonId: l.lessonId,
        title: l.title,
        ok: false,
        detail: e instanceof Error ? e.message : String(e),
      })
    }
    if (i < lessons.length - 1 && gapMs > 0) await sleep(gapMs)
  }
  if (!cancelled)
    opts.onProgress?.({ done: lessons.length, total: lessons.length, currentTitle: null })
  return {
    outcomes,
    ok: outcomes.filter((o) => o.ok).length,
    failed: outcomes.filter((o) => !o.ok).length,
    cancelled,
  }
}
