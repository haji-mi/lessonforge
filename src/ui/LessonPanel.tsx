/** 课时工作台：文件树 + 原文预览 + 提示词编辑器（溯源并排/覆盖面板/冲突裁决/审批/导出/AI 转化） */
import { useEffect, useMemo, useState } from 'react'
import type { LessonPlan, PromptSection } from '../core/compile/compile'
import type { LessonType } from '../core/classify/type'
import { parseDoc } from '../core/parse/parse'
import { getCurrentRevision, getEffectivePlan, type LessonStatus } from '../core/persist/project'
import type { LessonRecord, RevisionRecord } from '../core/persist/db'
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

/** 左侧课时树（章节分组 + 状态徽标） */
export function LessonTree({
  lessons,
  statuses,
  selectedId,
  onSelect,
}: {
  lessons: LessonRecord[]
  statuses: Map<string, LessonStatus>
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const byChapter = useMemo(() => {
    const m = new Map<string, LessonRecord[]>()
    for (const l of lessons) {
      if (!m.has(l.chapter)) m.set(l.chapter, [])
      m.get(l.chapter)!.push(l)
    }
    return m
  }, [lessons])
  return (
    <div className="lesson-tree">
      {[...m_byChapterEntries(byChapter)].map(([chapter, items]) => (
        <div key={chapter}>
          <div className="chapter-row">📁 {chapter || '（未分章）'}</div>
          {items.map((l) => {
            const st = statuses.get(l.id)
            return (
              <div
                key={l.id}
                className={`lesson-row selectable ${selectedId === l.id ? 'selected' : ''}`}
                onClick={() => onSelect(l.id)}
              >
                📄 {l.title}{' '}
                {st ? <span className={`chip chip-${st.uiState}`}>{st.uiState}</span> : null}
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

function m_byChapterEntries(m: Map<string, LessonRecord[]>): [string, LessonRecord[]][] {
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-Hans-CN'))
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
