/**
 * AI 转化面板：把当前课时的编译稿（或原始笔记）交给 OpenRouter 免费模型转化为互动课堂提示词。
 * 输出永远是「建议稿」——只在本面板审阅/编辑/复制，绝不自动写入编译稿（基线 U1）。
 */
import { useEffect, useState } from 'react'
import { copyText } from '../core/export/exporters'
import { DEFAULT_PROMPT_SETTINGS } from '../core/compile/compile'
import {
  aiTransformLesson,
  fingerprint,
  loadAiCache,
  saveAiCache,
  type AiTransformMode,
  type TransformResult,
} from '../ai/transform'
import { loadAiSettings, isAiConfigured } from '../ai/settings'

export interface AiPanelProps {
  lessonId: string
  lessonTitle: string
  typeLabel: string
  /** 当前生效编译稿全文（未编译为 null） */
  promptText: string | null
  /** 原始笔记全文（无修订版为 null） */
  noteText: string | null
  onToast: (msg: string) => void
  onMarkExported: () => void | Promise<void>
}

export function AiPanel(props: AiPanelProps) {
  const { lessonId, lessonTitle, typeLabel, promptText, noteText, onToast, onMarkExported } = props
  const defaultMode: AiTransformMode = promptText ? 'polish' : 'rewrite'
  const [mode, setMode] = useState<AiTransformMode>(defaultMode)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<TransformResult | null>(null)
  const [out, setOut] = useState('')
  const [stale, setStale] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const cache = loadAiCache(lessonId)
    setResult(null)
    setError(null)
    setOut(cache?.text ?? '')
    setStale(false)
    if (cache) {
      const current = cache.mode === 'polish' ? (promptText ?? '') : (noteText ?? '')
      setStale(fingerprint(current) !== cache.sourceFingerprint)
    }
    setMode(promptText ? 'polish' : 'rewrite')
  }, [lessonId, promptText, noteText])

  const sourceText = mode === 'polish' ? promptText : noteText
  const configured = isAiConfigured(loadAiSettings())

  async function run() {
    if (!sourceText) {
      setError(
        mode === 'polish'
          ? '尚未编译——先点「编译」生成编译稿，或切换为「由原文重写」'
          : '无原始笔记文本',
      )
      return
    }
    setRunning(true)
    setError(null)
    try {
      const r = await aiTransformLesson({
        mode,
        lessonTitle,
        typeLabel,
        subject: DEFAULT_PROMPT_SETTINGS.subject,
        level: DEFAULT_PROMPT_SETTINGS.level,
        sourceText,
      })
      setResult(r)
      setOut(r.text)
      saveAiCache(lessonId, {
        text: r.text,
        model: r.model,
        mode: r.mode,
        at: r.at,
        sourceFingerprint: fingerprint(sourceText),
      })
      onToast(`AI 转化完成（${r.model}，${r.attempts.filter((a) => !a.ok).length} 次回退）`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  async function copy() {
    if (!out.trim()) {
      onToast('没有可复制的 AI 提示词')
      return
    }
    const ok = await copyText(out)
    if (ok) {
      await onMarkExported()
      onToast('已复制 AI 版提示词（可粘贴到豆包爱学）')
    } else {
      onToast('复制失败（剪贴板不可用）——可手动全选下方文本')
    }
  }

  return (
    <div className="ai-panel">
      <h4>AI 转化（OpenRouter 免费模型 · 生成内容仅供审阅，不会自动写入编译稿）</h4>
      {!configured ? (
        <div className="warn-text">
          未配置 API Key——点击顶部「AI 设置」填入（或已由 .env.local 预置）。
        </div>
      ) : null}
      <div className="ai-controls">
        <label>
          输入材料{' '}
          <select value={mode} onChange={(e) => setMode(e.target.value as AiTransformMode)}>
            <option value="polish" disabled={!promptText}>
              润色编译稿{promptText ? `（${promptText.length} 字）` : '（未编译）'}
            </option>
            <option value="rewrite" disabled={!noteText}>
              由原文笔记重写{noteText ? `（${noteText.length} 字）` : '（无原文）'}
            </option>
          </select>
        </label>
        <button onClick={run} disabled={running || !sourceText}>
          {running ? '转化中…（免费模型可能需 30~120 秒）' : result ? '重新转化' : '运行 AI 转化'}
        </button>
        <button onClick={copy} disabled={running || !out.trim()}>
          复制 AI 版提示词
        </button>
      </div>
      {error ? <div className="error-banner">{error}</div> : null}
      {stale ? (
        <div className="warn-text">⚠ 缓存结果基于旧材料生成（材料已变化），建议重新转化</div>
      ) : null}
      {result ? (
        <div className="muted">
          模型 {result.model} · {new Date(result.at).toLocaleString('zh-CN')} ·{' '}
          {result.attempts.length > 1 ? (
            <details className="ai-attempts">
              <summary>回退明细（{result.attempts.length} 次尝试）</summary>
              <ul>
                {result.attempts.map((a, i) => (
                  <li key={i} className={a.ok ? '' : 'warn-text'}>
                    {a.ok ? '✓' : '✗'} {a.model}：{a.detail}（{a.ms}ms）
                  </li>
                ))}
              </ul>
            </details>
          ) : (
            '一次成功'
          )}
        </div>
      ) : null}
      {out ? (
        <textarea
          className="ai-result"
          value={out}
          onChange={(e) => setOut(e.target.value)}
          rows={Math.min(24, out.split('\n').length + 2)}
          title="可先编辑再复制；编辑仅影响本次复制，不写回编译稿"
        />
      ) : (
        <div className="muted">
          尚无结果。点击「运行 AI 转化」把{mode === 'polish' ? '编译稿' : '原始笔记'}交给模型，
          产出一份可整段粘贴到豆包爱学的互动课堂提示词。
        </div>
      )}
    </div>
  )
}
