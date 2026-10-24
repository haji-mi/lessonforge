/**
 * AI 设置对话框：供应商（OpenRouter / 英伟达 NIM / 自定义 OpenAI 兼容）+ Key + 模型 +
 * 连通性测试（单次极小请求）+ 拉取模型列表。
 * 密钥按供应商独立保存于本机 localStorage（覆盖 .env.local 预置值）；仅在用户点击
 * 测试/转化时外发。
 *
 * 英伟达 NIM 走同源代理 '/nim'（vite server/preview proxy，浏览器直连被 CORS 拦截）。
 * OpenCode 说明：本机 OpenCode 仅存 GitHub Copilot OAuth（非静态 Key）且其 serve
 * 当前无法启动，暂不能直接借用其额度——如实告知，不提供假通路。
 */
import { useEffect, useState } from 'react'
import {
  FREE_MODELS,
  MODEL_LABEL,
  listModels,
  pingOpenRouter,
  type AttemptLog,
} from '../ai/openrouter'
import {
  NVIDIA_BASE_URL,
  loadAiSettings,
  saveAiSettings,
  type AiProviderKind,
  type AiSettings,
  type ProviderConfig,
} from '../ai/settings'

const PROVIDER_LABEL: Record<AiProviderKind, string> = {
  openrouter: 'OpenRouter（免费模型池）',
  nvidia: '英伟达 NIM（免费档）',
  custom: '自定义（OpenAI 兼容端点）',
}

export function AiSettingsDialog({
  onClose,
  onToast,
}: {
  onClose: () => void
  onToast: (msg: string) => void
}) {
  const [draft, setDraft] = useState<AiSettings>(() => loadAiSettings())
  const [showKey, setShowKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testAttempts, setTestAttempts] = useState<AttemptLog[] | null>(null)

  const cfg: ProviderConfig = draft.providers[draft.provider]

  // Esc 关闭（与点击遮罩一致），不打断正在进行的测试/拉取请求
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  function patchCfg(patch: Partial<ProviderConfig>) {
    setDraft((d) => ({
      ...d,
      providers: { ...d.providers, [d.provider]: { ...d.providers[d.provider], ...patch } },
    }))
  }

  async function test() {
    if (!cfg.apiKey.trim()) {
      setTestResult('请先填写 API Key')
      return
    }
    if (draft.provider !== 'openrouter' && !cfg.baseUrl.trim()) {
      setTestResult('请先填写 Base URL')
      return
    }
    setTesting(true)
    setTestResult(null)
    setTestAttempts(null)
    try {
      const models =
        draft.provider === 'openrouter' && cfg.model === 'auto'
          ? []
          : cfg.model
            ? [cfg.model]
            : cfg.modelList
      const r = await pingOpenRouter({
        apiKey: cfg.apiKey.trim(),
        baseUrl: cfg.baseUrl.trim(),
        models: models.length ? models : undefined,
      })
      setTestResult(`连通正常：${r.model} 回复「${r.content.slice(0, 40)}」`)
      setTestAttempts(r.attempts)
    } catch (e) {
      setTestResult(`失败：${e instanceof Error ? e.message : String(e)}`)
      setTestAttempts(
        typeof e === 'object' && e && 'attempts' in e
          ? (e as { attempts: AttemptLog[] }).attempts
          : null,
      )
    } finally {
      setTesting(false)
    }
  }

  async function fetchModels() {
    if (!cfg.apiKey.trim() || !cfg.baseUrl.trim()) {
      setTestResult('拉取模型列表需要先填写 Key 与 Base URL')
      return
    }
    setFetching(true)
    setTestResult(null)
    try {
      const ids = await listModels({ apiKey: cfg.apiKey.trim(), baseUrl: cfg.baseUrl.trim() })
      patchCfg({ modelList: ids, model: '' })
      setTestResult(`已拉取 ${ids.length} 个模型（默认按列表顺序回退，可下拉指定）`)
    } catch (e) {
      setTestResult(
        `拉取失败：${e instanceof Error ? e.message : String(e)}（若为网络/CORS 错误，说明该端点不允许浏览器直连）`,
      )
    } finally {
      setFetching(false)
    }
  }

  function save() {
    saveAiSettings(draft)
    onToast('AI 设置已保存（存于本机浏览器）')
    onClose()
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog-box" onClick={(e) => e.stopPropagation()}>
        <h3>AI 设置</h3>
        <div className="ai-field">
          <label>供应商</label>
          <select
            value={draft.provider}
            onChange={(e) => setDraft({ ...draft, provider: e.target.value as AiProviderKind })}
          >
            {(Object.keys(PROVIDER_LABEL) as AiProviderKind[]).map((k) => (
              <option key={k} value={k}>
                {PROVIDER_LABEL[k]}
              </option>
            ))}
          </select>
          <div className="muted">
            {draft.provider === 'openrouter'
              ? '免费模型按序回退，无需挑选；有每日次数限额。'
              : draft.provider === 'nvidia'
                ? '走本机代理 /nim 转发（直连被 CORS 拦截）；免费档限速约 40 次/分钟。'
                : '任何 OpenAI 兼容端点：api.openai.com/v1、api.deepseek.com、本地 Ollama(http://localhost:11434/v1) 等。'}
          </div>
        </div>
        <div className="ai-field">
          <label>API Key</label>
          <div className="row">
            <input
              type={showKey ? 'text' : 'password'}
              value={cfg.apiKey}
              placeholder="留空=使用 .env.local 预置值（OpenRouter/英伟达）"
              onChange={(e) => patchCfg({ apiKey: e.target.value })}
              style={{ flex: 1 }}
            />
            <button className="link" onClick={() => setShowKey(!showKey)}>
              {showKey ? '隐藏' : '显示'}
            </button>
          </div>
          <div className="muted">按供应商独立保存在本机（localStorage），只发往所选端点。</div>
        </div>
        <div className="ai-field">
          <label>Base URL</label>
          {draft.provider === 'nvidia' ? (
            <div className="muted">
              固定走同源代理 {NVIDIA_BASE_URL}（vite dev/preview 自动转发到
              integrate.api.nvidia.com）
            </div>
          ) : (
            <input
              value={cfg.baseUrl}
              placeholder={
                draft.provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'https://…/v1'
              }
              onChange={(e) => patchCfg({ baseUrl: e.target.value })}
            />
          )}
        </div>
        <div className="ai-field">
          <label>模型</label>
          {draft.provider === 'openrouter' ? (
            <select value={cfg.model} onChange={(e) => patchCfg({ model: e.target.value })}>
              <option value="auto">{MODEL_LABEL['auto']}</option>
              {FREE_MODELS.map((m) => (
                <option key={m} value={m}>
                  {MODEL_LABEL[m] ?? m}
                </option>
              ))}
            </select>
          ) : (
            <div className="row">
              <select
                value={cfg.model}
                onChange={(e) => patchCfg({ model: e.target.value })}
                style={{ flex: 1 }}
              >
                <option value="">按列表顺序自动回退（首个默认）</option>
                {cfg.modelList.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <button onClick={fetchModels} disabled={fetching}>
                {fetching ? '拉取中…' : '拉取模型列表'}
              </button>
            </div>
          )}
          {draft.provider !== 'openrouter' && cfg.modelList.length > 0 ? (
            <div className="muted">
              当前列表 {cfg.modelList.length} 个：{cfg.modelList.slice(0, 3).join('、')}
              {cfg.modelList.length > 3 ? '…' : ''}
            </div>
          ) : null}
        </div>
        <details className="ai-attempts">
          <summary className="muted">关于 OpenCode 额度（如实说明）</summary>
          <div className="muted">
            本机 OpenCode 只保存了 GitHub Copilot OAuth 凭据（非静态 API Key，无法直接填入），
            且其「opencode serve」当前因数据库版本冲突无法启动——暂不能借用其额度。若你有任何 OpenAI
            兼容端点（中转服务/本地模型），用上方「自定义」接入即可。
          </div>
        </details>
        <div className="dialog-actions">
          <button onClick={test} disabled={testing}>
            {testing ? '测试中…' : '测试连接（1 次极小请求）'}
          </button>
          <button onClick={save} disabled={!cfg.apiKey.trim()}>
            保存
          </button>
          <button className="link" onClick={onClose}>
            取消
          </button>
        </div>
        {testResult ? (
          <div
            className={
              testResult.startsWith('失败') || testResult.startsWith('拉取失败')
                ? 'error-banner'
                : 'ok-text'
            }
          >
            {testResult}
          </div>
        ) : null}
        {testAttempts ? (
          <details className="ai-attempts">
            <summary>尝试明细</summary>
            <ul>
              {testAttempts.map((a, i) => (
                <li key={i} className={a.ok ? '' : 'warn-text'}>
                  {a.ok ? '✓' : '✗'} {a.model}：{a.detail}（{a.ms}ms）
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </div>
  )
}
