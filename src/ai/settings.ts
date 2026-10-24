/**
 * AI 设置（架构基线 §2 新增 ai 边界层）：localStorage 存储 + 构建期 env 兜底。
 * 密钥只在本机浏览器与 OpenRouter 之间传输；默认零上传约束不破——仅在用户显式触发
 * AI 转化/测试连接时才发起对 openrouter.ai 的请求（CSP 也仅放行该域）。
 */
export interface AiSettings {
  apiKey: string
  /** 'auto' = 按 FREE_MODELS 顺序回退；否则为单个模型 id */
  model: string
  baseUrl: string
}

export const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'
const LS_KEY = 'cc-ai-settings'

/** 构建期注入（.env.local，gitignored）；未配置时为空串 */
export const ENV_API_KEY: string = import.meta.env.VITE_OPENROUTER_API_KEY ?? ''

function lsGet(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
  } catch {
    return null
  }
}

function lsSet(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value)
  } catch {
    // 存储不可用（隐私模式等）：设置仅存活于当前会话内存
  }
}

export function loadAiSettings(): AiSettings {
  let saved: Partial<AiSettings>
  try {
    saved = JSON.parse(lsGet(LS_KEY) ?? '{}') as Partial<AiSettings>
  } catch {
    saved = {}
  }
  // 显式保存过空串=用户主动清空（不再回退 env）；从未保存过=用 env 预置值
  const savedKey = typeof saved.apiKey === 'string' ? saved.apiKey : undefined
  return {
    apiKey: savedKey !== undefined ? savedKey.trim() : ENV_API_KEY,
    model: typeof saved.model === 'string' && saved.model ? saved.model : 'auto',
    baseUrl: typeof saved.baseUrl === 'string' && saved.baseUrl ? saved.baseUrl : DEFAULT_BASE_URL,
  }
}

export function saveAiSettings(s: AiSettings): void {
  lsSet(LS_KEY, JSON.stringify({ apiKey: s.apiKey, model: s.model, baseUrl: s.baseUrl }))
}

export function isAiConfigured(s: AiSettings): boolean {
  return s.apiKey.length > 0
}
