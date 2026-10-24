/**
 * AI 设置对话框：OpenRouter API Key / 模型选择 / 连通性测试（单次极小请求）。
 * 密钥保存于本机 localStorage（覆盖 .env.local 预置值）；仅在用户点击测试/转化时外发。
 */
import { useState } from 'react'
import { FREE_MODELS, MODEL_LABEL, pingOpenRouter, type AttemptLog } from '../ai/openrouter'
import { loadAiSettings, saveAiSettings, type AiSettings } from '../ai/settings'

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
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testAttempts, setTestAttempts] = useState<AttemptLog[] | null>(null)

  async function test() {
    if (!draft.apiKey.trim()) {
      setTestResult('请先填写 API Key')
      return
    }
    setTesting(true)
    setTestResult(null)
    setTestAttempts(null)
    try {
      const r = await pingOpenRouter({
        apiKey: draft.apiKey.trim(),
        baseUrl: draft.baseUrl,
        models: draft.model === 'auto' ? undefined : [draft.model],
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

  function save() {
    saveAiSettings({ ...draft, apiKey: draft.apiKey.trim() })
    onToast('AI 设置已保存（存于本机浏览器）')
    onClose()
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog-box" onClick={(e) => e.stopPropagation()}>
        <h3>AI 设置（OpenRouter）</h3>
        <div className="ai-field">
          <label>API Key</label>
          <div className="row">
            <input
              type={showKey ? 'text' : 'password'}
              value={draft.apiKey}
              placeholder="sk-or-v1-…（留空=使用 .env.local 预置值）"
              onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
              style={{ flex: 1 }}
            />
            <button className="link" onClick={() => setShowKey(!showKey)}>
              {showKey ? '隐藏' : '显示'}
            </button>
          </div>
          <div className="muted">
            密钥仅保存在本机浏览器（localStorage），只发往
            openrouter.ai。免费模型有每日次数限额，慎用「测试连接」。
          </div>
        </div>
        <div className="ai-field">
          <label>模型</label>
          <select
            value={draft.model}
            onChange={(e) => setDraft({ ...draft, model: e.target.value })}
          >
            <option value="auto">{MODEL_LABEL['auto']}</option>
            {FREE_MODELS.map((m) => (
              <option key={m} value={m}>
                {MODEL_LABEL[m] ?? m}
              </option>
            ))}
          </select>
          <div className="muted">免费模型逐日可用性波动，建议保持「自动」按序回退。</div>
        </div>
        <div className="dialog-actions">
          <button onClick={test} disabled={testing}>
            {testing ? '测试中…' : '测试连接（1 次极小请求）'}
          </button>
          <button onClick={save} disabled={!draft.apiKey.trim()}>
            保存
          </button>
          <button className="link" onClick={onClose}>
            取消
          </button>
        </div>
        {testResult ? (
          <div className={testResult.startsWith('失败') ? 'error-banner' : 'ok-text'}>
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
