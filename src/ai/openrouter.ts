/**
 * OpenAI 兼容端点客户端（ai 边界层，主用于 OpenRouter / 英伟达 NIM / 自定义端点）：
 * 免费模型按序回退。2026-10-24 实测：免费模型可用性逐日波动（429 限流/上游 404/
 * 空回复均出现），故内置「实测可用优先」的回退序列；仅 401（密钥无效）视为致命
 * 错误立即终止。
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 实测（2026-10-24，免费档）中文课堂提示词任务可用性排序 */
export const FREE_MODELS: string[] = [
  'nvidia/nemotron-3-ultra-550b-a55b:free', // 中文质量最好
  'dots-studio/dots-3-note-preview:free',
  'xingchen-agi/xing4.0-29b-a4b:free',
  'google/gemma-4-31b-it:free', // 实测日限流，作后备
  'google/gemma-4-26b-a4b-it:free',
]

export const MODEL_LABEL: Record<string, string> = {
  auto: '自动（免费模型按序回退）',
  'nvidia/nemotron-3-ultra-550b-a55b:free': 'Nemotron 3 Ultra 550B（推荐）',
  'dots-studio/dots-3-note-preview:free': 'Dots 3 Note（笔记优化）',
  'xingchen-agi/xing4.0-29b-a4b:free': 'Xing 4.0 29B',
  'google/gemma-4-31b-it:free': 'Gemma 4 31B',
  'google/gemma-4-26b-a4b-it:free': 'Gemma 4 26B',
}

export interface AttemptLog {
  model: string
  ok: boolean
  detail: string
  ms: number
}

export interface CallOptions {
  apiKey: string
  baseUrl?: string
  /** 覆盖回退序列；缺省用 FREE_MODELS */
  models?: string[]
  messages: ChatMessage[]
  maxTokens?: number
  temperature?: number
  /** 单模型尝试超时（默认 120s：免费大模型冷启动慢） */
  timeoutMs?: number
  /** 测试注入；生产用全局 fetch */
  fetchImpl?: typeof fetch
}

export interface CallResult {
  content: string
  model: string
  attempts: AttemptLog[]
}

export class AiError extends Error {
  /** false = 无需再试其他模型（如密钥无效） */
  retryable: boolean
  constructor(message: string, retryable: boolean) {
    super(message)
    this.name = 'AiError'
    this.retryable = retryable
  }
}

export class AiAllFailedError extends Error {
  attempts: AttemptLog[]
  constructor(attempts: AttemptLog[]) {
    super(
      `全部模型尝试失败（${attempts.length} 次）：` +
        attempts.map((a) => `${a.model}→${a.detail}`).join('；'),
    )
    this.name = 'AiAllFailedError'
    this.attempts = attempts
  }
}

/** 剥离推理型模型的 <think>…</think> 段与代码围栏包装 */
export function cleanContent(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/^```(?:markdown|text)?\s*\n?/, '')
    .replace(/\n?```\s*$/, '')
    .trim()
}

async function chatOnce(
  model: string,
  opts: CallOptions,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetchImpl(`${opts.baseUrl ?? 'https://openrouter.ai/api/v1'}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'Classroom Compiler',
      },
      body: JSON.stringify({
        model,
        messages: opts.messages,
        max_tokens: opts.maxTokens ?? 4096,
        temperature: opts.temperature ?? 0.3,
      }),
      signal: controller.signal,
    })
  } catch (e) {
    throw new AiError(
      e instanceof Error && e.name === 'AbortError'
        ? `超时（>${Math.round(timeoutMs / 1000)}s）`
        : `网络错误：${String(e)}`,
      true,
    )
  } finally {
    clearTimeout(timer)
  }
  if (res.status === 401) {
    throw new AiError('API Key 无效（401）——请到「AI 设置」核对密钥', false)
  }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new AiError(`HTTP ${res.status}：响应不是 JSON`, true)
  }
  const j = body as {
    error?: { message?: string; code?: number }
    choices?: { message?: { content?: string | null } }[]
  }
  if (!res.ok || j.error) {
    throw new AiError(
      `HTTP ${res.status}${j.error?.code ? `/${j.error.code}` : ''}：${j.error?.message ?? '未知错误'}`,
      true,
    )
  }
  const content = cleanContent(j.choices?.[0]?.message?.content ?? '')
  if (!content) {
    // 实测存在：模型 HTTP 200 但内容为空（如 nemotron-3.5-lightning）→ 换下一个
    throw new AiError('模型返回空内容', true)
  }
  return content
}

/** 按序尝试模型列表，返回首个成功结果；全部失败抛 AiAllFailedError（含逐次明细） */
export async function chatWithFallback(opts: CallOptions): Promise<CallResult> {
  const models = opts.models && opts.models.length > 0 ? opts.models : FREE_MODELS
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? 120_000
  const attempts: AttemptLog[] = []
  for (const model of models) {
    const t0 = Date.now()
    try {
      const content = await chatOnce(model, opts, fetchImpl, timeoutMs)
      attempts.push({
        model,
        ok: true,
        detail: `成功（${content.length} 字符）`,
        ms: Date.now() - t0,
      })
      return { content, model, attempts }
    } catch (e) {
      const err = e instanceof AiError ? e : new AiError(String(e), true)
      attempts.push({ model, ok: false, detail: err.message, ms: Date.now() - t0 })
      if (!err.retryable) throw new AiAllFailedError(attempts)
    }
  }
  throw new AiAllFailedError(attempts)
}

/** 设置连通性测试：单次极小请求（max_tokens=8，省额度） */
export async function pingOpenRouter(opts: Omit<CallOptions, 'messages'>): Promise<CallResult> {
  return chatWithFallback({
    ...opts,
    messages: [{ role: 'user', content: '请只回复：OK' }],
    maxTokens: 8,
    temperature: 0,
    timeoutMs: opts.timeoutMs ?? 60_000,
  })
}

/** 拉取端点模型列表（OpenAI 兼容 GET /models；用于英伟达/自定义供应商） */
export async function listModels(opts: {
  apiKey: string
  baseUrl?: string
  fetchImpl?: typeof fetch
}): Promise<string[]> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const res = await fetchImpl(`${opts.baseUrl ?? 'https://openrouter.ai/api/v1'}/models`, {
    headers: { Authorization: `Bearer ${opts.apiKey}` },
  })
  if (!res.ok) throw new AiError(`HTTP ${res.status}：拉取模型列表失败`, true)
  const j = (await res.json()) as { data?: { id?: string }[] }
  const ids = (j.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string')
  if (ids.length === 0) throw new AiError('端点未返回任何模型', true)
  return ids
}
