/**
 * AI 提示词转化（ai 边界层编排）：纯函数构建消息 + 调用回退 + 每课时本地缓存。
 * 约束（对应基线 §3 U1/§8 护栏）：AI 输出永远是「建议稿」，仅在用户显式审阅/复制时使用，
 * 绝不自动写入 PromptDraft / overlay；缓存只存 localStorage，不进 IndexedDB 主数据链。
 */
import type { ChatMessage } from './openrouter'
import { chatWithFallback, type AttemptLog } from './openrouter'
import { loadAiSettings } from './settings'

export type AiTransformMode = 'polish' | 'rewrite'

export interface TransformInput {
  mode: AiTransformMode
  lessonTitle: string
  /** 课型中文标签（概念理解/公式推导/例题讲解/通用讲解） */
  typeLabel: string
  subject: string
  level: string
  /** polish=编译稿全文；rewrite=原始笔记文本 */
  sourceText: string
}

/** 输入保护上限：超长截断（省额度；正常编译稿预算 ≤2000 字，远达不到上限） */
export const MAX_INPUT_CHARS = 12_000

export function capInput(text: string): string {
  if (text.length <= MAX_INPUT_CHARS) return text
  return `${text.slice(0, MAX_INPUT_CHARS)}\n…（材料过长，已截断至 ${MAX_INPUT_CHARS} 字）`
}

/** 纯函数：构建 system/user 消息（单测锁定措辞中的硬约束） */
export function buildTransformMessages(input: TransformInput): ChatMessage[] {
  const roleLine =
    input.mode === 'polish'
      ? '材料是一份结构化的课堂提示词编译稿。保留其环节顺序与全部知识点，优化语言的自然度与互动性：把陈述句改写为面向学生的引导与设问，让节奏更适合对话式授课。'
      : '材料是教师的原始课堂笔记。请自行组织为互动课堂环节（引入→讲解→设问检测→小结），知识点全部保留、顺序可按教学逻辑重排。'
  const system = [
    `你是一位资深${input.level}${input.subject}教师兼提示词工程师，任务是产出一份可直接粘贴给「豆包爱学」的互动课堂提示词。`,
    '硬性约束：',
    '1. 只能使用材料中出现过的知识——不得编造新结论、新例题、新练习、新数据；',
    '2. 公式、数值、代码保持原文逐字（LaTeX 记号不改写）；',
    '3. 材料中的每个知识点都必须出现在产出中，不得遗漏；',
    '4. 面向学生设问推进，每次设问后注明「等待学生回答」；',
    `5. 全文 ${input.typeLabel}定位，总长约 ${input.level === '高中' ? '1500~2500' : '800~1500'} 字；`,
    '6. 只输出提示词正文本身：不要解释、不要标题外的元信息、不要 Markdown 代码围栏。',
    roleLine,
  ].join('\n')
  const user = [
    `【课题】${input.lessonTitle}`,
    `【课型】${input.typeLabel}`,
    `【学段学科】${input.level}${input.subject}`,
    '【材料开始】',
    capInput(input.sourceText),
    '【材料结束】',
    '请输出转化后的完整互动课堂提示词。',
  ].join('\n')
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

export interface TransformResult {
  text: string
  model: string
  attempts: AttemptLog[]
  mode: AiTransformMode
  at: number
}

/** 编排入口：读设置 → 按模式构建消息 → 多模型回退调用 */
export async function aiTransformLesson(
  input: TransformInput,
  extra?: { fetchImpl?: typeof fetch },
): Promise<TransformResult> {
  const settings = loadAiSettings()
  if (!settings.apiKey) {
    throw new Error('未配置 API Key——请点击顶部「AI 设置」填入 OpenRouter 密钥')
  }
  const models = settings.model === 'auto' ? undefined : [settings.model]
  const r = await chatWithFallback({
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    models,
    messages: buildTransformMessages(input),
    maxTokens: 4096,
    fetchImpl: extra?.fetchImpl,
  })
  return { text: r.content, model: r.model, attempts: r.attempts, mode: input.mode, at: Date.now() }
}

// ── 每课时本地缓存（审阅中断后可恢复；重编译不清理，用户可手动重新生成覆盖） ──

export interface AiCacheEntry {
  text: string
  model: string
  mode: AiTransformMode
  at: number
  /** 发送材料的内容指纹（编译稿或笔记变化后提示「基于旧材料」） */
  sourceFingerprint: string
}

const cacheKey = (lessonId: string) => `cc-ai-transform:${lessonId}`

export function fingerprint(s: string): string {
  // 轻量非加密指纹：长度 + 简单散列（仅用于「材料是否变过」提示）
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return `${s.length}:${(h >>> 0).toString(36)}`
}

export function loadAiCache(lessonId: string): AiCacheEntry | null {
  try {
    const raw =
      typeof localStorage === 'undefined' ? null : localStorage.getItem(cacheKey(lessonId))
    if (!raw) return null
    const e = JSON.parse(raw) as AiCacheEntry
    if (typeof e.text !== 'string' || !e.text) return null
    return e
  } catch {
    return null
  }
}

export function saveAiCache(lessonId: string, entry: AiCacheEntry): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(cacheKey(lessonId), JSON.stringify(entry))
    }
  } catch {
    // 存储不可用：跳过缓存，功能仍可用
  }
}
