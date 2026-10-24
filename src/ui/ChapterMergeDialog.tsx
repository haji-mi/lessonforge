/**
 * 按章整合对话框：把一章内各课时的提示词材料（AI 建议稿 / 编译稿）按课时顺序
 * 合并为一份可整段粘贴到豆包爱学的整章提示词。
 *
 * - 取材偏好：自动（AI 稿优先、编译稿兜底）/ 只用编译稿 / 只用 AI 稿；
 * - 整合稿按（项目, 章节）缓存于 localStorage（派生数据，不进 IndexedDB 主数据链），
 *   刷新后仍可恢复；材料变化时提示过期，可一键按当前材料重新整合；
 * - 整合稿可手动编辑：编辑只存缓存与本次复制/导出，绝不写回编译稿（U1 不变）；
 * - 复制/导出成功后把本章已采用材料的课时标记为已导出（与单课时复制语义一致）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  buildChapterPrompt,
  chapterMergeStale,
  PART_KIND_LABEL,
  pickLessonMaterial,
  type ChapterMergePart,
} from '../core/compile/chapterMerge'
import { DEFAULT_PROMPT_SETTINGS, type PromptSettings } from '../core/compile/compile'
import { copyText, downloadBlob, sanitizeFileName } from '../core/export/exporters'
import { getEffectivePlan, markExported } from '../core/persist/project'
import type { LessonRecord, ProjectRecord } from '../core/persist/db'
import { loadAiCache } from '../ai/transform'
import { groupByChapter } from './tree-selection'
import {
  clearChapterMergeCache,
  loadChapterMergeCache,
  saveChapterMergeCache,
  type ChapterMergeCache,
} from './chapter-merge'

type Prefer = 'auto' | 'ai' | 'compiled'

const PREFER_OPTIONS: { value: Prefer; label: string }[] = [
  { value: 'auto', label: '自动（AI 稿优先，编译稿兜底）' },
  { value: 'compiled', label: '只用编译稿' },
  { value: 'ai', label: '只用 AI 稿' },
]

interface LessonMaterials {
  compiled: string | null
  ai: string | null
}

export function ChapterMergeDialog({
  project,
  lessons,
  onClose,
  onToast,
  onExported,
}: {
  project: ProjectRecord
  lessons: LessonRecord[]
  onClose: () => void
  onToast: (msg: string) => void
  /** 复制/导出后刷新课时状态（已标记导出） */
  onExported?: () => void | Promise<void>
}) {
  const chapters = useMemo(() => groupByChapter(lessons), [lessons])
  const [mats, setMats] = useState<Map<string, LessonMaterials> | null>(null)
  const [caches, setCaches] = useState<Map<string, ChapterMergeCache | null> | null>(null)
  const [prefer, setPrefer] = useState<Prefer>('auto')
  const [activeCh, setActiveCh] = useState<string | null>(() => chapters[0]?.[0] ?? null)
  const [text, setText] = useState<string | null>(null)

  // Esc 关闭（与点击遮罩一致）
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  // 一次性读入：每课时编译稿 + AI 建议稿 + 各章整合稿缓存（全为本地读取）
  useEffect(() => {
    let alive = true
    Promise.all(
      lessons.map(async (l): Promise<[string, LessonMaterials]> => {
        const eff = await getEffectivePlan(l.id)
        const ai = loadAiCache(l.id)
        return [l.id, { compiled: eff?.plan.promptText ?? null, ai: ai?.text ?? null }]
      }),
    ).then((entries) => {
      if (alive) setMats(new Map(entries))
    })
    setCaches(new Map(chapters.map(([ch]) => [ch, loadChapterMergeCache(project.id, ch)])))
    return () => {
      alive = false
    }
  }, [lessons, chapters, project.id])

  // 切换章节 / 缓存更新后，把编辑区对齐到缓存稿
  useEffect(() => {
    const c = activeCh && caches ? (caches.get(activeCh) ?? null) : null
    setText(c?.text ?? null)
  }, [activeCh, caches])

  const partsOf = useCallback(
    (items: LessonRecord[]): ChapterMergePart[] =>
      items.map((l) => {
        const m = mats?.get(l.id)
        const picked = m ? pickLessonMaterial(prefer, m.compiled, m.ai) : null
        return picked
          ? { lessonId: l.id, title: l.title, kind: picked.kind, text: picked.text }
          : { lessonId: l.id, title: l.title, kind: 'missing', text: '' }
      }),
    [mats, prefer],
  )

  const activeLessons = useMemo(
    () => chapters.find(([ch]) => ch === activeCh)?.[1] ?? [],
    [chapters, activeCh],
  )
  const activeParts = useMemo(() => partsOf(activeLessons), [partsOf, activeLessons])
  const readyCount = activeParts.filter((p) => p.kind !== 'missing').length
  const cache = activeCh && caches ? (caches.get(activeCh) ?? null) : null
  const stale = cache ? chapterMergeStale(cache, { parts: activeParts }) : false

  /** 各章缓存过期态（导航徽标用；随取材偏好联动） */
  const staleByCh = useMemo(() => {
    const m = new Map<string, boolean>()
    if (!mats || !caches) return m
    for (const [ch, items] of chapters) {
      const c = caches.get(ch)
      if (c) m.set(ch, chapterMergeStale(c, { parts: partsOf(items) }))
    }
    return m
  }, [chapters, caches, mats, partsOf])

  function updateCache(ch: string, next: ChapterMergeCache | null) {
    setCaches((prev) => {
      const n = new Map(prev ?? [])
      n.set(ch, next)
      return n
    })
    if (next) saveChapterMergeCache(project.id, ch, next)
    else clearChapterMergeCache(project.id, ch)
  }

  function regenerate() {
    if (!activeCh) return
    if (cache?.edited && !confirm('当前整合稿含手动修改，重新整合将覆盖。继续？')) return
    const ps: PromptSettings = { ...DEFAULT_PROMPT_SETTINGS, ...(project.settings ?? {}) }
    const t = buildChapterPrompt(activeParts, {
      chapter: activeCh,
      subject: ps.subject,
      level: ps.level,
    })
    setText(t)
    updateCache(activeCh, { at: Date.now(), parts: activeParts, text: t, edited: false })
    onToast(
      `已整合《${activeCh}》：${readyCount}/${activeParts.length} 课时，共 ${t.length} 字（已缓存，刷新不丢）`,
    )
  }

  function onEdit(v: string) {
    if (!activeCh) return
    setText(v)
    updateCache(activeCh, {
      at: cache?.at ?? Date.now(),
      parts: cache?.parts ?? activeParts,
      text: v,
      edited: true,
    })
  }

  function removeCache() {
    if (!activeCh) return
    updateCache(activeCh, null)
    setText(null)
    onToast(`已清除《${activeCh}》整合稿缓存`)
  }

  /** 复制/导出成功后：本章已采用材料的课时统一标记已导出 */
  async function afterAdopted() {
    for (const p of activeParts) if (p.kind !== 'missing') await markExported(p.lessonId)
    await onExported?.()
  }

  async function copyAll() {
    if (!text?.trim()) {
      onToast('还没有整合稿——先点「整合本章」')
      return
    }
    const ok = await copyText(text)
    if (!ok) {
      onToast('复制失败（剪贴板不可用）——可手动全选下方文本')
      return
    }
    await afterAdopted()
    onToast(`已复制《${activeCh}》整章提示词（${text.length} 字），可整段粘贴到豆包爱学`)
  }

  function exportMd() {
    if (!text?.trim() || !activeCh) {
      onToast('还没有整合稿——先点「整合本章」')
      return
    }
    const header = `<!-- Classroom Compiler 按章整合 | 章节：${activeCh} | ${new Date(cache?.at ?? Date.now()).toLocaleString('zh-CN')} -->\n\n`
    downloadBlob(
      new Blob([header + text], { type: 'text/markdown' }),
      `${sanitizeFileName(activeCh)}-整合提示词.md`,
    )
    void afterAdopted()
    onToast('已导出整章 MD')
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog-box chapter-merge-box" onClick={(e) => e.stopPropagation()}>
        <h3>📑 按章整合提示词</h3>
        <div className="muted">
          把一章各课时的提示词（AI 稿 / 编译稿）按顺序合并成一份，整段复制或导出 MD
          后粘贴给豆包爱学；整合稿自动缓存（本机 localStorage），可手动编辑，材料变化会提示过期。
        </div>
        {!mats || !caches ? (
          <div className="muted" style={{ padding: '16px 0' }}>
            读取课时材料中…
          </div>
        ) : (
          <div className="cm-columns">
            <div className="cm-nav">
              {chapters.map(([ch, items]) => {
                const c = caches.get(ch) ?? null
                const ready = items.filter((l) => {
                  const m = mats.get(l.id)
                  return !!m && (!!m.compiled || !!m.ai)
                }).length
                const isStale = staleByCh.get(ch)
                return (
                  <div
                    key={ch}
                    className={`cm-nav-item ${activeCh === ch ? 'active' : ''}`}
                    onClick={() => setActiveCh(ch)}
                  >
                    📁 {ch || '（未分章）'}
                    <span className="muted cm-nav-sub">
                      {items.length} 课时 · {ready} 有稿
                      {c ? (isStale ? ' · ⚠ 已过期' : ' · 已整合') : ''}
                    </span>
                  </div>
                )
              })}
            </div>
            <div className="cm-detail">
              <div className="cm-toolbar">
                <label className="type-override">
                  取材{' '}
                  <select value={prefer} onChange={(e) => setPrefer(e.target.value as Prefer)}>
                    {PREFER_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button onClick={regenerate}>
                  {cache ? '重新整合（按当前材料）' : '整合本章'}
                </button>
                <button onClick={copyAll} disabled={!text?.trim()}>
                  复制整合稿
                </button>
                <button onClick={exportMd} disabled={!text?.trim()}>
                  导出 MD
                </button>
                <button className="danger" onClick={removeCache} disabled={!cache}>
                  清除缓存
                </button>
              </div>
              {readyCount === 0 ? (
                <div className="warn-text">
                  本章没有任何可用材料（未编译且无 AI 稿）——先在工作台「编译」，或用侧栏「AI
                  一键生成」。
                </div>
              ) : null}
              {stale ? (
                <div className="warn-text">
                  ⚠ 已缓存的整合稿基于旧材料或旧取材偏好，建议「重新整合」
                </div>
              ) : null}
              {cache ? (
                <div className="muted">
                  已缓存：{new Date(cache.at).toLocaleString('zh-CN')}
                  {cache.edited ? ' · 含手动修改' : ''}
                </div>
              ) : null}
              <div className="cm-mat-list">
                {activeParts.map((p, i) => {
                  const m = mats.get(p.lessonId)
                  return (
                    <div key={p.lessonId} className="cm-mat-row">
                      <span>
                        {i + 1}. {p.title}
                      </span>
                      <span className={`chip ${m?.ai ? 'chip-ok' : 'chip-none'}`}>
                        AI 稿{m?.ai ? ' ✓' : ' ✗'}
                      </span>
                      <span className={`chip ${m?.compiled ? 'chip-ok' : 'chip-none'}`}>
                        编译稿{m?.compiled ? ' ✓' : ' ✗'}
                      </span>
                      <span className="muted">采用：{PART_KIND_LABEL[p.kind]}</span>
                    </div>
                  )
                })}
              </div>
              {text ? (
                <textarea
                  className="cm-text"
                  value={text}
                  onChange={(e) => onEdit(e.target.value)}
                  rows={Math.min(26, text.split('\n').length + 2)}
                  title="可先编辑再复制；编辑保存到本机缓存，不写回编译稿"
                />
              ) : (
                <div className="muted">
                  尚未整合本章——点「整合本章」把各课时提示词按顺序合并成一份（自动缓存）。
                </div>
              )}
            </div>
          </div>
        )}
        <div className="dialog-actions">
          <button className="link" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
