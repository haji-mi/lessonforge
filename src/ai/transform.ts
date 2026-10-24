/**
 * AI 提示词转化（ai 边界层编排）：纯函数构建消息 + 调用回退 + 每课时本地缓存。
 * 约束（对应基线 §3 U1/§8 护栏）：AI 输出永远是「建议稿」，仅在用户显式审阅/复制时使用，
 * 绝不自动写入 PromptDraft / overlay；缓存只存 localStorage，不进 IndexedDB 主数据链。
 */
import type { ChatMessage } from './openrouter'
import { chatWithFallback, type AttemptLog } from './openrouter'
import { activeProvider, loadAiSettings } from './settings'

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
  /** 课时长度（分钟），默认标准一节课 40 */
  durationMinutes?: number
}

/** 输入保护上限：超长截断（省额度；正常编译稿预算 ≤2000 字，远达不到上限） */
export const MAX_INPUT_CHARS = 12_000

export function capInput(text: string): string {
  if (text.length <= MAX_INPUT_CHARS) return text
  return `${text.slice(0, MAX_INPUT_CHARS)}\n…（材料过长，已截断至 ${MAX_INPUT_CHARS} 字）`
}

/** 纯函数：构建 system/user 消息（单测锁定措辞中的硬约束） */
export function buildTransformMessages(input: TransformInput): ChatMessage[] {
  const minutes = input.durationMinutes ?? 40
  const roleLine =
    input.mode === 'polish'
      ? '材料是一份结构化的课堂提示词编译稿。保留其环节顺序与全部知识点，把各环节整理为上述「课程信息 + 环节设计」格式；重点优化口头讲解的自然度与互动性：把陈述句改写为面向学生的引导与设问。'
      : '材料是教师的原始课堂笔记。请把笔记内容自行组织为上述「课程信息 + 环节设计」格式（导入→讲解→师生问答→小测→小结），知识点全部保留、顺序可按教学逻辑重排。'
  const system = [
    `你是一位资深${input.level}${input.subject}教师兼提示词工程师，任务是产出一份可直接粘贴给「豆包爱学」的互动课堂提示词。`,
    '这份提示词会被 AI 课程引擎解析成「课程信息 + 一系列教学场景」，请严格按以下两部分结构产出，便于引擎逐字段提取：',
    '',
    '第一部分·课程信息（逐字段列出）：',
    '- 课程标题：把课题蒸馏为名词短语，≤30字；不要句子、不要「课程/学习」等字样、不要引号或序号；',
    '- 学段学科、课型、课时：按输入字段原样写入；',
    '- 受众基础：从材料提炼「已掌握…」「未学…」各一条；材料未体现则写「以教材默认起点为准」。',
    '',
    `第二部分·环节设计（按教学顺序列出 4~8 个环节，各环节时长之和≈${minutes}分钟）：`,
    '每个环节的格式：',
    '环节N｜类型｜约X分钟',
    '- 教学目的：1~2句；',
    '- 上屏要点：3~5条，每条≤30字的短语或要点（这是投影给学生看的，不写口语长句）；',
    '- 口头讲解：面向学生的引导与设问，推进节奏自然；每次设问后注明「等待学生回答」；',
    '环节类型限「导入/讲解/师生问答/小测/小结」：',
    '- 小测环节全课 1~2 次，安排在主要知识点之后，且必须写明配置：题量与题型（如「2道单选+1道简答」）、难度（易/中/难）、覆盖的知识点；',
    '- 若某知识点明显适合交互演示（如运动过程、函数图像、几何变换），该环节加一行「- 互动建议：…（可调参数…）」；全课最多 2 处，没有合适内容就不写。',
    '',
    '硬性约束：',
    '1. 只能使用材料中出现过的知识——不得编造新结论、新例题、新练习、新数据；',
    '2. 公式、数值、代码保持原文逐字（LaTeX 记号不改写）；',
    '3. 材料中的每个知识点都必须出现在产出中，不得遗漏；',
    `4. 全文 ${input.typeLabel}定位，总长约 ${input.level === '高中' ? '1500~2500' : '800~1500'} 字；`,
    '5. 只输出提示词正文本身：不要解释、不要 Markdown 代码围栏。',
    roleLine,
  ].join('\n')
  const user = [
    `【课题】${input.lessonTitle}`,
    `【课型】${input.typeLabel}`,
    `【学段学科】${input.level}${input.subject}`,
    `【课时】约${minutes}分钟（标准一节课）`,
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

/**
 * 供应商感知的模型序列（纯函数）：
 * - openrouter 且 model='auto'（或空）→ 'builtin'（chatWithFallback 内置 FREE_MODELS 回退）
 * - 指定了 model → 单模型；否则 modelList 顺序回退（nvidia 预设 / 自定义拉取）
 */
export function resolveModels(
  provider: string,
  cfg: { model: string; modelList: string[] },
): string[] | 'builtin' {
  if (provider === 'openrouter' && (!cfg.model || cfg.model === 'auto')) return 'builtin'
  if (cfg.model) return [cfg.model]
  return cfg.modelList
}

/** 编排入口：读设置 → 按模式构建消息 → 多模型回退调用 */
export async function aiTransformLesson(
  input: TransformInput,
  extra?: { fetchImpl?: typeof fetch },
): Promise<TransformResult> {
  const settings = loadAiSettings()
  const cfg = activeProvider(settings)
  if (!cfg.apiKey) {
    throw new Error('当前供应商未配置 API Key——请点击顶部「AI 设置」填写')
  }
  const resolved = resolveModels(settings.provider, cfg)
  let models: string[] | undefined
  if (resolved === 'builtin') models = undefined
  else if (resolved.length === 0) {
    throw new Error('未选择模型——请到「AI 设置」选择模型或拉取模型列表')
  } else models = resolved
  const r = await chatWithFallback({
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
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
