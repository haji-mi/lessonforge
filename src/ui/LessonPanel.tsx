/** 课时工作台：文件树 + 原文预览 + 提示词编辑器（溯源并排/覆盖面板/冲突裁决/审批/导出/AI 转化） */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { LessonPlan, PromptSection } from '../core/compile/compile'
import type { LessonType } from '../core/classify/type'
import { parseDoc } from '../core/parse/parse'
import { getCurrentRevision, getEffectivePlan, type LessonStatus } from '../core/persist/project'
import type { LessonRecord, RevisionRecord } from '../core/persist/db'
import { chapterCheckState, groupByChapter, rangeBetween } from './tree-selection'
import { MarkdownView } from './MarkdownView'
import { AiPanel } from './AiPanel'

const TYPE_OPTIONS: { value: LessonType; label: string }[] = [
  { value: 'concept', label: '概念理解' },
  { value: 'derivation', label: '公式推导' },
  { value: 'example', label: '例题讲解' },
  { value: 'generic', label: '通用讲解' },
]

export interface LessonWorkbenchProps {
  lesson: LessonRecord
  status: LessonStatus
  effective: { plan: LessonPlan; hasEdits: boolean } | null
  revision: RevisionRecord | null
  onAction: (action: string, payload?: unknown) => void
  onEditSection: (sectionId: string, content: string) => void
  onSetType: (type: LessonType | null) => void
  onJumpTrace: (section: PromptSection) => void
  onIncludeMku: (mku: {
    id: string
    kind: string
    text: string
    span: { start: number; end: number }
  }) => void
  onToast: (msg: string) => void
  onMarkExported: () => void | Promise<void>
  refresh: () => void
}

export function LessonWorkbench(props: LessonWorkbenchProps) {
  const {
    lesson,
    status,
    effective,
    revision,
    onAction,
    onEditSection,
    onSetType,
    onJumpTrace,
    onIncludeMku,
    onToast,
    onMarkExported,
  } = props
  const [editingSection, setEditingSection] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [showCoverage, setShowCoverage] = useState(false)
  const [showAi, setShowAi] = useState(false)
  const activeType: LessonType =
    effective?.plan.type ?? (lesson.typeManual as LessonType | null) ?? 'generic'
  const typeLabel = TYPE_OPTIONS.find((t) => t.value === activeType)?.label ?? '通用讲解'

  return (
    <div className="workbench">
      <div className="wb-header">
        <h2>
          {lesson.title} <span className={`chip chip-${status.uiState}`}>{status.uiState}</span>
        </h2>
        <div className="muted">
          {lesson.normPath} · 章节 {lesson.chapter}
        </div>
        <div className="wb-actions">
          <label className="type-override">
            课型{' '}
            <select
              value={lesson.typeManual ?? ''}
              onChange={(e) => onSetType((e.target.value || null) as LessonType | null)}
              title="人工覆盖课型判定（留空=自动）"
            >
              <option value="">
                自动
                {effective
                  ? `（${TYPE_OPTIONS.find((t) => t.value === effective.plan.type)?.label ?? effective.plan.type}）`
                  : ''}
              </option>
              {TYPE_OPTIONS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                  {lesson.typeManual === t.value ? '（已指定）' : ''}
                </option>
              ))}
            </select>
          </label>
          <button onClick={() => onAction('compile')}>{effective ? '重新编译' : '编译'}</button>
          <button onClick={() => setShowAi(!showAi)}>AI 转化</button>
          {status.hasCandidate ? (
            <>
              <span className="warn-text">存在待决冲突（重编译产生了新草稿）</span>
              <button onClick={() => onAction('keep-mine')}>保留我的版本</button>
              <button onClick={() => onAction('adopt-new')}>采用新版（人工迁移编辑）</button>
            </>
          ) : null}
          {effective ? (
            <>
              <button onClick={() => setShowCoverage(!showCoverage)}>覆盖情况</button>
              <button onClick={() => onAction('approve')}>批准</button>
              <button onClick={() => onAction('copy')}>复制提示词</button>
              <button onClick={() => onAction('export-md')}>导出 MD</button>
            </>
          ) : null}
        </div>
        {status.staleSource ? (
          <div className="warn-text">源文件已变化（当前草稿基于旧版本）</div>
        ) : null}
        {status.staleCompiler ? (
          <div className="warn-text">编译器已升级，草稿由旧版生成</div>
        ) : null}
        {effective?.plan.typeAmbiguous ? (
          <div className="warn-text">
            课型判定分差过小（候选课型得分接近），结果可能不稳——建议用上方「课型」下拉人工确认后重编译
          </div>
        ) : null}
      </div>

      {showAi ? (
        <AiPanel
          lessonId={lesson.id}
          lessonTitle={lesson.title}
          typeLabel={typeLabel}
          promptText={effective?.plan.promptText ?? null}
          noteText={revision?.text ?? null}
          onToast={onToast}
          onMarkExported={onMarkExported}
        />
      ) : null}

      {showCoverage && effective ? (
        <CoveragePanel
          plan={effective.plan}
          lessonId={lesson.id}
          onAck={() => {
            onAction('ack-coverage')
            setShowCoverage(false)
          }}
          onInclude={onIncludeMku}
        />
      ) : null}

      <div className="wb-columns">
        <div className="wb-source">
          <h3>原文预览（只读，永不修改）</h3>
          {revision ? <SourcePreview revision={revision} /> : <div className="muted">无修订版</div>}
          {revision?.lossy ? (
            <div className="error-banner">
              该文件解码有损（{revision.issues.length} 处非法序列，字节已原样保管）
            </div>
          ) : null}
        </div>
        <div className="wb-prompt">
          <h3>课堂提示词</h3>
          {!effective ? (
            <div className="muted">尚未编译。点击「编译」生成提示词。</div>
          ) : (
            <div>
              {effective.plan.warnings.map((w, i) => (
                <div key={i} className="warn-text">
                  ⚠ {w}
                </div>
              ))}
              {effective.plan.sections.map((s) => (
                <SectionEditor
                  key={s.sectionId}
                  section={s}
                  editing={editingSection === s.sectionId}
                  draft={editDraft}
                  onStart={() => {
                    setEditingSection(s.sectionId)
                    setEditDraft(s.content)
                  }}
                  onDraft={setEditDraft}
                  onSave={() => {
                    onEditSection(s.sectionId, editDraft)
                    setEditingSection(null)
                  }}
                  onCancel={() => setEditingSection(null)}
                  onJump={() => onJumpTrace(s)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function SectionEditor({
  section,
  editing,
  draft,
  onStart,
  onDraft,
  onSave,
  onCancel,
  onJump,
}: {
  section: PromptSection
  editing: boolean
  draft: string
  onStart: () => void
  onDraft: (s: string) => void
  onSave: () => void
  onCancel: () => void
  onJump: () => void
}) {
  return (
    <div className={`section section-${section.contentType.toLowerCase()}`}>
      <div className="section-head">
        <span className={`ct-badge ct-${section.contentType}`}>{section.contentType}</span>
        <b>{section.role}</b>
        {section.traces.length > 0 ? (
          <button
            className="link"
            onClick={onJump}
            title={`溯源 ${section.traces.map((t) => `[${t.start},${t.end})`).join(', ')}`}
          >
            ↪ 溯源
          </button>
        ) : null}
        {section.basis ? <span className="muted">依据：{section.basis}</span> : null}
      </div>
      {editing ? (
        <div>
          <textarea
            value={draft}
            onChange={(e) => onDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onCancel()
            }}
            rows={Math.min(12, draft.split('\n').length + 1)}
          />
          <div>
            <button onClick={onSave}>保存（记录为用户编辑）</button>
            <button className="link" onClick={onCancel}>
              取消
            </button>
          </div>
        </div>
      ) : (
        <pre className="section-body" onDoubleClick={onStart} title="双击编辑">
          {section.content || '（空）'}
        </pre>
      )}
    </div>
  )
}

function CoveragePanel({
  plan,
  lessonId,
  onAck,
  onInclude,
}: {
  plan: LessonPlan
  lessonId: string
  onAck: () => void
  onInclude: (mku: LessonPlan['coverage']['uncovered'][number]) => void
}) {
  return (
    <div className="coverage-panel">
      <h4>知识覆盖情况（K1 三态 · 试验期）</h4>
      <div>
        核心知识块：已处理 {plan.coverage.coreHandled}/{plan.coverage.coreTotal}
        {plan.coverage.uncovered.length > 0 ? (
          <span className="warn-text">（未纳入 {plan.coverage.uncovered.length} 个）</span>
        ) : null}
      </div>
      {plan.coverage.uncovered.length > 0 ? (
        <ul>
          {plan.coverage.uncovered.map((m) => (
            <li key={m.id} className="uncovered-item">
              [{m.kind}] {m.text.slice(0, 60)}…{' '}
              <button className="link" onClick={() => onInclude(m)}>
                补入提示词
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {plan.coverage.uncoveredRelated.length > 0 ? (
        <details>
          <summary className="warn-text">
            相关知识块未纳入 {plan.coverage.uncoveredRelated.length} 个（性质/练习/提醒，可补入）
          </summary>
          <ul>
            {plan.coverage.uncoveredRelated.map((m) => (
              <li key={m.id} className="uncovered-item">
                [{m.kind}] {m.text.slice(0, 60)}…{' '}
                <button className="link" onClick={() => onInclude(m)}>
                  补入提示词
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {plan.coverage.excluded.length > 0 ? (
        <div className="muted">
          已显式排除：{plan.coverage.excluded.map((e) => `${e.mku.kind}（${e.reason}）`).join('、')}
        </div>
      ) : null}
      <button onClick={onAck}>我已查看覆盖情况</button>
      <span className="muted">
        （试验期审批门禁：批准前需查看；正式门禁待三篇真实笔记校准后启用）{lessonId ? '' : ''}
      </span>
    </div>
  )
}

function SourcePreview({ revision }: { revision: RevisionRecord }) {
  const doc = useMemo(() => parseDoc(revision.text), [revision.text])
  const model = useMemo(
    () => ({ tags: doc.tags, comments: doc.comments, resolvedWikiTargets: new Map() }),
    [doc],
  )
  return <MarkdownView tree={doc.tree} model={model} />
}

/** 课时中文课型标签（批量 AI 等复用）：编译稿课型优先，其次人工指定，兜底通用 */
export function lessonTypeLabel(typeManual: string | null, planType?: LessonType): string {
  const t: LessonType = planType ?? (typeManual as LessonType | null) ?? 'generic'
  return TYPE_OPTIONS.find((x) => x.value === t)?.label ?? '通用讲解'
}

/** 一次滑选手势的状态：锚点行 + 方向值（锚点已勾→拖动=取消，未勾→拖动=勾上） */
interface DragCheckState {
  anchorId: string
  value: boolean
  /** 已真正进入拖拽（跨到过另一行）；未激活前松手 = 普通单击 */
  active: boolean
  lastId: string
  pointerId: number
}

/**
 * 左侧课时树（章节分组 + 状态徽标 + 批量勾选）。
 * 多选交互：
 * - 按住左键在课时行上滑动 → 锚点行决定方向（已勾=逐行取消 / 未勾=逐行勾上），跨章拖拽按视觉顺序覆盖中间章节全部课时；
 * - Shift+点击勾选框/行 → [上次单点锚点..本行] 整段置为同一状态；Ctrl/Cmd+点击行 → 切换该行勾选不打开；
 * - 章节行：点勾选框或章节名 = 本章节全选/全取消（部分勾选显示半选态）；点 ▸/▾ 折叠章节；
 * - 树内键盘：↑↓ 移动焦点行、Space 勾选、Enter 打开、Ctrl+A 全选/清空。
 * 仅响应鼠标滑选（pointerType==='mouse'），不劫持触屏/笔的滚动。
 */
export function LessonTree({
  lessons,
  statuses,
  selectedId,
  onSelect,
  checkedIds,
  onToggleCheck,
  onSetCheckedMany,
}: {
  lessons: LessonRecord[]
  statuses: Map<string, LessonStatus>
  selectedId: string | null
  onSelect: (id: string) => void
  checkedIds: Set<string>
  onToggleCheck: (id: string, opts?: { shift?: boolean }) => void
  onSetCheckedMany: (ids: string[], value: boolean) => void
}) {
  const ordered = useMemo(() => groupByChapter(lessons), [lessons])
  const orderedIds = useMemo(
    () => ordered.flatMap(([, items]) => items.map((l) => l.id)),
    [ordered],
  )
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [kbFocusId, setKbFocusId] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const treeRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<DragCheckState | null>(null)
  const rafRef = useRef<number | null>(null)
  const lastPtRef = useRef<{ x: number; y: number } | null>(null)
  /** 拖拽结束后吞掉尾随 click（防止松手误打开课时/误切勾选） */
  const suppressClickRef = useRef(false)
  /** checkbox 的 change 事件不带修饰键，onClick（先于 change 触发）暂存 shift 状态 */
  const lastShiftRef = useRef(false)

  /** 折叠后可见的课时（键盘导航只走可见行） */
  const visibleIds = useMemo(
    () => ordered.flatMap(([ch, items]) => (collapsed.has(ch) ? [] : items.map((l) => l.id))),
    [ordered, collapsed],
  )

  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  useEffect(() => {
    if (!kbFocusId) return
    treeRef.current?.querySelector('.lesson-row.kb-focus')?.scrollIntoView({ block: 'nearest' })
  }, [kbFocusId, collapsed])

  function rowIdFromPoint(x: number, y: number): string | null {
    const el = document.elementFromPoint(x, y)
    const row = el instanceof Element ? el.closest('.lesson-row') : null
    return row instanceof HTMLElement ? (row.dataset.id ?? null) : null
  }

  /** 把滑选范围应用到 [锚点..当前行]；首次跨行时激活拖拽并接管指针 */
  function applyDragRange(id: string) {
    const d = dragRef.current
    if (!d || id === d.lastId) return
    if (!d.active) {
      d.active = true
      setDragging(true)
      try {
        treeRef.current?.setPointerCapture(d.pointerId)
      } catch {
        /* 指针已释放等边缘情况：不影响已应用的勾选 */
      }
    }
    d.lastId = id
    onSetCheckedMany(rangeBetween(orderedIds, d.anchorId, id), d.value)
  }

  /** 指针贴近侧栏上下缘时持续滚动，滚动中指针不动、行在动，需重算当前行 */
  function autoScrollStep() {
    rafRef.current = null
    const d = dragRef.current
    const pt = lastPtRef.current
    const box = treeRef.current?.closest('.sidebar')
    if (!d || !pt || !(box instanceof HTMLElement)) return
    const r = box.getBoundingClientRect()
    const edge = 24
    let dy = 0
    if (pt.y < r.top + edge) dy = -Math.ceil((r.top + edge - pt.y) / 3)
    else if (pt.y > r.bottom - edge) dy = Math.ceil((pt.y - (r.bottom - edge)) / 3)
    if (dy === 0) return
    box.scrollTop += dy
    const id = rowIdFromPoint(pt.x, pt.y)
    if (id) applyDragRange(id)
    rafRef.current = requestAnimationFrame(autoScrollStep)
  }

  function endDrag() {
    const d = dragRef.current
    dragRef.current = null
    setDragging(false)
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (d?.active) {
      suppressClickRef.current = true
      window.setTimeout(() => {
        suppressClickRef.current = false
      }, 0)
    }
  }

  function onTreePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0 || e.pointerType !== 'mouse') return
    const row = e.target instanceof Element ? e.target.closest('.lesson-row') : null
    if (!(row instanceof HTMLElement) || !row.dataset.id) return
    const id = row.dataset.id
    dragRef.current = {
      anchorId: id,
      value: !checkedIds.has(id),
      active: false,
      lastId: id,
      pointerId: e.pointerId,
    }
    lastPtRef.current = { x: e.clientX, y: e.clientY }
  }

  function onTreePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current
    if (!d || e.pointerId !== d.pointerId) return
    lastPtRef.current = { x: e.clientX, y: e.clientY }
    const id = rowIdFromPoint(e.clientX, e.clientY)
    if (id) applyDragRange(id)
    if (d.active && rafRef.current == null) rafRef.current = requestAnimationFrame(autoScrollStep)
  }

  function onTreePointerUp() {
    if (dragRef.current) endDrag()
  }

  function onTreeKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      onSetCheckedMany(orderedIds, checkedIds.size !== lessons.length)
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const cur = kbFocusId ? visibleIds.indexOf(kbFocusId) : -1
      const next =
        cur < 0
          ? e.key === 'ArrowDown'
            ? 0
            : visibleIds.length - 1
          : Math.max(0, Math.min(visibleIds.length - 1, cur + (e.key === 'ArrowDown' ? 1 : -1)))
      setKbFocusId(visibleIds[next] ?? null)
      return
    }
    if (!kbFocusId) return
    if (e.key === ' ') {
      e.preventDefault()
      onToggleCheck(kbFocusId)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      onSelect(kbFocusId)
    }
  }

  function toggleCollapse(chapter: string) {
    setCollapsed((prev) => {
      const n = new Set(prev)
      if (n.has(chapter)) n.delete(chapter)
      else n.add(chapter)
      return n
    })
  }

  return (
    <div
      ref={treeRef}
      className={`lesson-tree ${dragging ? 'dragging' : ''}`}
      tabIndex={0}
      title="按住左键滑动可批量勾选；树内 ↑↓ 选择、Space 勾选、Enter 打开"
      onPointerDown={onTreePointerDown}
      onPointerMove={onTreePointerMove}
      onPointerUp={onTreePointerUp}
      onPointerCancel={onTreePointerUp}
      onKeyDown={onTreeKeyDown}
      onDragStart={(e) => e.preventDefault()}
    >
      {ordered.map(([chapter, items]) => {
        const ids = items.map((l) => l.id)
        const st = chapterCheckState(ids, checkedIds)
        const isCollapsed = collapsed.has(chapter)
        return (
          <div key={chapter}>
            <div
              className="chapter-row"
              onClick={() => onSetCheckedMany(ids, st !== 'all')}
              title="点击全选/取消本章节"
            >
              <span
                className="collapse-toggle"
                role="button"
                aria-label={isCollapsed ? '展开章节' : '折叠章节'}
                onClick={(e) => {
                  e.stopPropagation()
                  toggleCollapse(chapter)
                }}
              >
                {isCollapsed ? '▸' : '▾'}
              </span>
              <input
                type="checkbox"
                className="chapter-check"
                checked={st === 'all'}
                ref={(el) => {
                  if (el) el.indeterminate = st === 'partial'
                }}
                onClick={(e) => e.stopPropagation()}
                onChange={() => onSetCheckedMany(ids, st !== 'all')}
                title="全选/取消本章节"
              />
              📁 {chapter || '（未分章）'}
              <span className="muted chapter-count"> ({items.length})</span>
            </div>
            {!isCollapsed &&
              items.map((l) => {
                const st = statuses.get(l.id)
                return (
                  <div
                    key={l.id}
                    data-id={l.id}
                    className={`lesson-row selectable ${selectedId === l.id ? 'selected' : ''} ${
                      kbFocusId === l.id ? 'kb-focus' : ''
                    }`}
                    onClick={(e) => {
                      if (suppressClickRef.current) return
                      setKbFocusId(l.id)
                      if (e.shiftKey) onToggleCheck(l.id, { shift: true })
                      else if (e.ctrlKey || e.metaKey) onToggleCheck(l.id)
                      else onSelect(l.id)
                    }}
                  >
                    <input
                      type="checkbox"
                      className="lesson-check"
                      checked={checkedIds.has(l.id)}
                      onClick={(e) => {
                        if (suppressClickRef.current) {
                          e.preventDefault()
                          return
                        }
                        e.stopPropagation()
                        lastShiftRef.current = e.shiftKey
                      }}
                      onChange={() => onToggleCheck(l.id, { shift: lastShiftRef.current })}
                      title="勾选后可用侧栏「AI 一键生成」批量转化；Shift+点击勾选一段"
                    />
                    📄 {l.title}{' '}
                    {st ? <span className={`chip chip-${st.uiState}`}>{st.uiState}</span> : null}
                  </div>
                )
              })}
          </div>
        )
      })}
    </div>
  )
}

/** 溯源跳转高亮：给定 trace 显示原文片段 */
export function TracePeek({
  revision,
  trace,
}: {
  revision: RevisionRecord | null
  trace: { start: number; end: number } | null
}) {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    if (!revision || !trace) {
      setText(null)
      return
    }
    const around = 40
    const s = Math.max(0, trace.start - around)
    const e = Math.min(revision.text.length, trace.end + around)
    setText(
      (s > 0 ? '…' : '') +
        revision.text.slice(s, e).replace(/\n/g, '⏎') +
        (e < revision.text.length ? '…' : ''),
    )
  }, [revision, trace])
  if (!text) return null
  return <div className="trace-peek">溯源片段：{text}</div>
}

export async function loadLessonContext(lesson: LessonRecord) {
  const revision = (await getCurrentRevision(lesson.projectId, lesson.normPath)) ?? null
  const effective = await getEffectivePlan(lesson.id)
  return { revision, effective }
}
