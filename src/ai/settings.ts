/**
 * AI 设置（架构基线 §2 新增 ai 边界层）：多供应商（OpenRouter / 英伟达 NIM / 自定义
 * OpenAI 兼容端点），各供应商独立保存 Key/模型/baseUrl（localStorage，切换不丢配置）。
 * 密钥只在本机浏览器与所选端点之间传输；默认零上传约束不破——仅在用户显式触发
 * AI 转化/测试连接时才发起请求。
 *
 * 英伟达 NIM 说明：浏览器直连 integrate.api.nvidia.com 会被 CORS 拦截（实测无
 * Access-Control-Allow-Origin），故 baseUrl 用同源代理路径 /nim（vite dev/preview
 * server.proxy 转发，见 vite.config.ts）。
 */
import { FREE_MODELS } from './openrouter'

export type AiProviderKind = 'openrouter' | 'nvidia' | 'custom'

export interface ProviderConfig {
  apiKey: string
  /** openrouter 允许 'auto'（FREE_MODELS 回退）；nvidia/custom 为空=按 modelList 顺序回退 */
  model: string
  baseUrl: string
  /** 可用模型列表（nvidia/custom：预设或「拉取模型列表」写入） */
  modelList: string[]
}

export interface AiSettings {
  provider: AiProviderKind
  providers: Record<AiProviderKind, ProviderConfig>
}

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
/** 同源代理（vite server/preview proxy → https://integrate.api.nvidia.com/v1） */
export const NVIDIA_BASE_URL = '/nim'
/** 实测可用（2026-10-24，NIM 免费档；首位与 OpenRouter 首选同模型） */
export const NVIDIA_PRESET_MODELS = [
  'nvidia/nemotron-3-ultra-550b-a55b',
  'nvidia/nemotron-3-super-120b-a12b',
  'nvidia/llama-3.1-nemotron-70b-instruct',
]

/** 构建期注入（.env.local，gitignored）；未配置时为空串 */
export const ENV_API_KEY: string = import.meta.env.VITE_OPENROUTER_API_KEY ?? ''
export const ENV_NVIDIA_API_KEY: string = import.meta.env.VITE_NVIDIA_API_KEY ?? ''

const LS_KEY = 'cc-ai-settings'

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

function defaults(): AiSettings {
  return {
    provider: 'openrouter',
    providers: {
      openrouter: {
        apiKey: ENV_API_KEY,
        model: 'auto',
        baseUrl: OPENROUTER_BASE_URL,
        modelList: [...FREE_MODELS],
      },
      nvidia: {
        apiKey: ENV_NVIDIA_API_KEY,
        model: '',
        baseUrl: NVIDIA_BASE_URL,
        modelList: [...NVIDIA_PRESET_MODELS],
      },
      custom: { apiKey: '', model: '', baseUrl: '', modelList: [] },
    },
  }
}

function normProvider(v: unknown, fallback: ProviderConfig): ProviderConfig {
  if (typeof v !== 'object' || v === null) return { ...fallback }
  const o = v as Partial<ProviderConfig>
  return {
    apiKey: typeof o.apiKey === 'string' ? o.apiKey : fallback.apiKey,
    model: typeof o.model === 'string' ? o.model : fallback.model,
    baseUrl: typeof o.baseUrl === 'string' ? o.baseUrl : fallback.baseUrl,
    modelList:
      Array.isArray(o.modelList) && o.modelList.every((m) => typeof m === 'string')
        ? o.modelList
        : fallback.modelList,
  }
}

/** 读取 + v1（单供应商 {apiKey,model,baseUrl}）迁移；损坏/缺失回默认值 */
export function loadAiSettings(): AiSettings {
  const d = defaults()
  let saved: Record<string, unknown> | undefined
  try {
    saved = (JSON.parse(lsGet(LS_KEY) ?? 'null') as Record<string, unknown> | null) ?? undefined
  } catch {
    saved = undefined
  }
  if (typeof saved !== 'object' || saved === null) return d
  // v1 → v2 迁移：旧字段全部归入 openrouter 供应商
  if (typeof saved.apiKey === 'string' || typeof saved.model === 'string') {
    d.providers.openrouter = normProvider(saved, d.providers.openrouter)
    return d
  }
  const kind =
    saved.provider === 'nvidia' || saved.provider === 'custom' || saved.provider === 'openrouter'
      ? saved.provider
      : 'openrouter'
  d.provider = kind
  if (typeof saved.providers === 'object' && saved.providers !== null) {
    const p = saved.providers as Record<string, unknown>
    d.providers.openrouter = normProvider(p.openrouter, d.providers.openrouter)
    d.providers.nvidia = normProvider(p.nvidia, d.providers.nvidia)
    d.providers.custom = normProvider(p.custom, d.providers.custom)
  }
  return d
}

export function saveAiSettings(s: AiSettings): void {
  lsSet(LS_KEY, JSON.stringify(s))
}

export function activeProvider(s: AiSettings): ProviderConfig {
  return s.providers[s.provider]
}

export function isAiConfigured(s: AiSettings): boolean {
  return activeProvider(s).apiKey.length > 0
}
