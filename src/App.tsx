/** 应用主入口：项目列表 / 导入向导 / 工作台 / 诊断 / 批量导出 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PromptSection } from './core/compile/compile'
import { parseDoc } from './core/parse/parse'
import {
  copyText,
  downloadBlob,
  exportLessonsZip,
  lessonToMarkdown,
  type LessonExportMeta,
} from './core/export/exporters'
import {
  addManualSection,
  approveLesson,
  compileAndStoreDraft,
  computeLessonStatus,
  createProject,
  deleteProject,
  ensureLessons,
  exportProjectJson,
  getEffectivePlan,
  importFiles,
  importProjectJson,
  listLessons,
  listProjects,
  markCoverageAck,
  markExported,
  renameLessonTitle,
  resyncProjectFromDir,
  resolveConflict,
  saveEdit,
  setLessonTypeManual,
  setProjectDirHandle,
  type DirResyncResult,
  type LessonStatus,
} from './core/persist/project'
import type { LessonRecord, ProjectRecord, RevisionRecord } from './core/persist/db'
import { getCurrentRevision } from './core/persist/project'
import {
  ensureReadPermission,
  pickCourseDirectory,
  supportsDirectoryPicker,
  type CourseDirHandle,
} from './core/import/fsa'
import { inferStructure, type StructureCourse } from './core/structure/infer'
import { ImportWizard, StructureConfirm } from './ui/ImportWizard'
import {
  LessonTree,
  LessonWorkbench,
  TracePeek,
  lessonTypeLabel,
  loadLessonContext,
} from './ui/LessonPanel'
import { AiSettingsDialog } from './ui/AiSettingsDialog'
import { ChapterMergeDialog } from './ui/ChapterMergeDialog'
import { orderedLessonIds, rangeBetween, setMany } from './ui/tree-selection'
import { runBatchTransform, type BatchLessonInput } from './ai/batch'
import { loadAiSettings, isAiConfigured } from './ai/settings'

type Screen = 'welcome' | 'import' | 'structure-confirm' | 'main'
/** 顶栏批量操作（编译/导出）的作用范围 */
type BatchScope = 'all' | 'checked'

export default function App() {
  const [screen, setScreen] = useState<Screen>('welcome')
  const [projects, setProjects] = useState<ProjectRecord[]>([])
  const [project, setProject] = useState<ProjectRecord | null>(null)
  const [pendingStructure, setPendingStructure] = useState<StructureCourse | null>(null)
  const [renames, setRenames] = useState<Map<string, string>>(new Map())
  const [lessons, setLessons] = useState<LessonRecord[]>([])
  const [statuses, setStatuses] = useState<Map<string, LessonStatus>>(new Map())
  const [selected, setSelected] = useState<LessonRecord | null>(null)
  const [revision, setRevision] = useState<RevisionRecord | null>(null)
  const [effective, setEffective] = useState<{ plan: any; hasEdits: boolean } | null>(null)
  const [trace, setTrace] = useState<{ start: number; end: number } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [showAiSettings, setShowAiSettings] = useState(false)
  const [showChapterMerge, setShowChapterMerge] = useState(false)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  /** 编译/导出的作用范围（默认全部）；勾选清空时自动回落为全部 */
  const [batchScope, setBatchScope] = useState<BatchScope>('all')
  /** AI 批量「停止」旗标：当前篇完成后不再继续（不中断进行中的请求） */
  const batchCancelRef = useRef(false)
  /** 顶栏「重读目录」进行中（防止并发重读） */
  const [resyncBusy, setResyncBusy] = useState(false)
  /** Shift 范围勾选的锚点 = 上一次单点勾选的行 */
  const lastCheckedIdRef = useRef<string | null>(null)
  const [aiBatch, setAiBatch] = useState<{
    running: boolean
    done: number
    total: number
    current: string | null
  } | null>(null)

  const refreshProjects = useCallback(async () => setProjects(await listProjects()), [])
  const refreshLessons = useCallback(async (projectId: string) => {
    const ls = await ensureLessons(projectId)
    setLessons(ls)
    const st = new Map<string, LessonStatus>()
    for (const l of ls) st.set(l.id, await computeLessonStatus(l.id))
    setStatuses(st)
    return ls
  }, [])

  useEffect(() => {
    refreshProjects()
  }, [refreshProjects])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3500)
    return () => clearTimeout(t)
  }, [toast])

  /** 重读结果提示文案；无任何变化 → null（打开时静默，不打扰） */
  function resyncToastText(r: DirResyncResult): string | null {
    const changedCount = r.outcome.added.length + r.outcome.changed.length + r.removed.length
    if (changedCount === 0) return null
    const parts = [`新增 ${r.outcome.added.length}`, `内容变化 ${r.outcome.changed.length}`]
    if (r.removed.length > 0) parts.push(`移除 ${r.removed.length}`)
    return `已重读课程目录：${parts.join('，')}，无变化 ${r.outcome.unchanged.length}`
  }

  /** 打开项目时重读绑定的课程目录；授权丢失/读取失败 → 降级用上次导入内容并提示 */
  async function resyncBoundDir(p: ProjectRecord) {
    if (!p.dirHandle) return
    try {
      if (!(await ensureReadPermission(p.dirHandle))) {
        setToast('目录读取未授权——本次展示上次导入的内容；点击顶部「重读目录」可重新授权')
        return
      }
      const r = await resyncProjectFromDir(p.id, p.dirHandle)
      const text = resyncToastText(r)
      if (r.noOverlap) setToast('重读结果与已导入内容零重叠——请确认绑定的是当初导入的同一目录')
      else if (text) setToast(text)
    } catch (e) {
      setToast(`重读课程目录失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** 顶栏「重读目录」：已绑定 → 立即重读；未绑定（旧项目）→ 先选目录绑定 */
  async function bindOrResyncDir() {
    if (!project || resyncBusy) return
    setResyncBusy(true)
    try {
      let handle = project.dirHandle ?? null
      if (!handle) {
        handle = await pickCourseDirectory()
        if (!handle) return
        await setProjectDirHandle(project.id, handle)
        setProject({ ...project, dirHandle: handle })
      }
      if (!(await ensureReadPermission(handle))) {
        setToast('未获得目录读取授权，无法重读')
        return
      }
      const r = await resyncProjectFromDir(project.id, handle)
      setToast(
        r.noOverlap
          ? '重读结果与已导入内容零重叠——请确认绑定的是当初导入的同一目录'
          : (resyncToastText(r) ?? `已重读课程目录：无变化 ${r.outcome.unchanged.length}`),
      )
      await refreshLessons(project.id)
      await refreshSelected()
    } catch (e) {
      setToast(`重读目录失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setResyncBusy(false)
    }
  }

  async function selectProject(p: ProjectRecord, opts?: { skipResync?: boolean }) {
    setProject(p)
    setSelected(null)
    setChecked(new Set())
    if (!opts?.skipResync) await resyncBoundDir(p)
    const ls = await refreshLessons(p.id)
    if (ls.length > 0) await selectLesson(ls[0]!)
    setScreen('main')
  }

  async function selectLesson(l: LessonRecord) {
    setSelected(l)
    setTrace(null)
    const ctx = await loadLessonContext(l)
    setRevision(ctx.revision)
    setEffective(
      ctx.effective ? { plan: ctx.effective.plan, hasEdits: ctx.effective.hasEdits } : null,
    )
  }

  async function refreshSelected() {
    if (!selected) return
    const ls = await refreshLessons(selected.projectId)
    const fresh = ls.find((x) => x.id === selected.id) ?? null
    setSelected(fresh)
    if (fresh) await selectLesson(fresh)
  }

  async function onImportDone(
    files: import('./core/types').ImportedFile[],
    source: 'dir' | 'zip',
    _otherFiles: { path: string; size: number }[],
    dirHandle: CourseDirHandle | null,
  ) {
    const p = await createProject(`课程 ${new Date().toLocaleString('zh-CN')}`)
    if (dirHandle) await setProjectDirHandle(p.id, dirHandle)
    p.dirHandle = dirHandle ?? undefined
    const outcome = await importFiles(p.id, files, source)
    setProject(p)
    await refreshProjects()
    // 结构确认（证据 + 重命名）
    const ls = await ensureLessons(p.id)
    const signals = await Promise.all(
      ls.map(async (l) => {
        const rev = await getCurrentRevision(p.id, l.normPath)
        const doc = rev ? parseDoc(rev.text) : null
        return {
          normPath: l.normPath,
          headings:
            doc?.blocks
              .filter((b) => b.kind === 'heading')
              .map((b) => ({ depth: b.meta.depth ?? 1, text: b.text })) ?? [],
          frontmatter: doc?.frontmatter.ok ? doc.frontmatter.data : null,
        }
      }),
    )
    setPendingStructure(inferStructure(signals, p.name))
    setRenames(new Map())
    setScreen('structure-confirm')
    setToast(
      `导入完成：新增 ${outcome.added.length}，无变化 ${outcome.unchanged.length}，内容变化 ${outcome.changed.length}`,
    )
  }

  async function onStructureConfirm() {
    // 应用重命名
    for (const [path, title] of renames) {
      const ls = lessons.length > 0 ? lessons : await listLessons(project!.id)
      const target = ls.find((l) => l.normPath === path)
      if (target) await renameLessonTitle(target.id, title)
    }
    // 刚导入完成，内容即为最新，跳过打开时的自动重读
    await selectProject(project!, { skipResync: true })
  }

  async function onAction(action: string) {
    if (!selected || !project) return
    try {
      if (action === 'compile') {
        const r = await compileAndStoreDraft(selected.id)
        setToast(
          r.conflict ? '已生成新草稿（存在用户编辑 → 待决冲突，默认保留我的版本）' : '编译完成',
        )
      } else if (action === 'keep-mine') {
        await resolveConflict(selected.id, 'keep-mine')
        setToast('已保留我的版本（新草稿归档为 superseded）')
      } else if (action === 'adopt-new') {
        await resolveConflict(selected.id, 'adopt-new')
        setToast('已采用新版草稿（编辑记录已迁移，请核对内容）')
      } else if (action === 'ack-coverage') {
        await markCoverageAck(selected.id)
        setToast('已记录「查看覆盖情况」')
      } else if (action === 'approve') {
        const r = await approveLesson(selected.id)
        setToast(r.ok ? '已批准' : `批准失败：${r.reason}`)
      } else if (action === 'copy') {
        const eff = await getEffectivePlan(selected.id)
        const ok = await copyText(eff ? eff.plan.promptText : '')
        setToast(ok ? '已复制到剪贴板（可粘贴到豆包爱学）' : '复制失败（剪贴板不可用）')
        if (ok) await markExported(selected.id)
      } else if (action === 'export-md') {
        const eff = await getEffectivePlan(selected.id)
        if (eff) {
          const meta: LessonExportMeta = {
            title: selected.title,
            chapter: selected.chapter,
            orderKey: selected.normPath.split('/').pop()!.replace(/\.md$/, ''),
          }
          downloadBlob(
            new Blob([lessonToMarkdown(eff.plan, meta)], { type: 'text/markdown' }),
            `${meta.title}.md`,
          )
          await markExported(selected.id)
          setToast('已导出 MD')
        }
      }
    } catch (e) {
      setToast(`操作失败：${e instanceof Error ? e.message : String(e)}`)
    }
    await refreshSelected()
  }

  async function onEditSection(sectionId: string, content: string) {
    if (!selected) return
    await saveEdit(selected.id, sectionId, content)
    setToast('已保存用户编辑（追加式，永不静默覆盖）')
    await refreshSelected()
  }

  /** 勾选清空时范围自动回落为全部，避免下拉选中「已勾选」后无值可选 */
  const effectiveScope: BatchScope =
    batchScope === 'checked' && checked.size > 0 ? 'checked' : 'all'

  /** 顶栏批量操作（编译/导出）的目标列表：按范围下拉取全部或已勾选课时 */
  function scopeTargets(): LessonRecord[] {
    if (effectiveScope === 'checked') {
      const ts = lessons.filter((l) => checked.has(l.id))
      if (ts.length === 0) {
        setToast('勾选列表为空——先在左侧勾选课时，或把范围切回「全部」')
        return []
      }
      return ts
    }
    return lessons
  }

  async function batchCompile() {
    if (!project) return
    const targets = scopeTargets()
    if (targets.length === 0) return
    let compiled = 0
    let conflicts = 0
    const failed: string[] = []
    for (const l of targets) {
      try {
        const r = await compileAndStoreDraft(l.id)
        compiled++
        if (r.conflict) conflicts++
      } catch (e) {
        // 单课时失败不阻断批次（B4 故障隔离），但必须点名报告（不允许静默吞错）
        failed.push(`${l.title}：${e instanceof Error ? e.message : String(e)}`)
      }
    }
    await refreshLessons(project.id)
    const fresh = await listLessons(project.id)
    if (selected) {
      const cur = fresh.find((x) => x.id === selected.id)
      if (cur) await selectLesson(cur)
    }
    if (failed.length > 0) {
      setToast(`批量编译：成功 ${compiled} 课时，失败 ${failed.length} 个——${failed.join('；')}`)
    } else {
      setToast(
        `批量编译完成：${compiled} 课时${conflicts > 0 ? `（${conflicts} 个存在待决冲突，默认保留用户版本）` : ''}`,
      )
    }
  }

  async function batchExport() {
    if (!project) return
    const targets = scopeTargets()
    if (targets.length === 0) return
    const exported: { plan: any; meta: LessonExportMeta }[] = []
    for (const l of targets) {
      const eff = await getEffectivePlan(l.id)
      if (!eff) continue
      const st = await computeLessonStatus(l.id)
      if (st.uiState === '未编译') continue
      exported.push({
        plan: eff.plan,
        meta: {
          title: l.title,
          chapter: l.chapter,
          orderKey: l.normPath.split('/').pop()!.replace(/\.md$/, ''),
        },
      })
    }
    if (exported.length === 0) {
      setToast('没有已编译的课时可导出')
      return
    }
    const blob = exportLessonsZip(exported)
    downloadBlob(blob, `${project.name}.zip`)
    setToast(`已批量导出 ${exported.length} 个课时（ZIP）`)
    for (const l of targets) await markExported(l.id)
    await refreshLessons(project.id)
  }

  async function backupJson() {
    if (!project) return
    const json = await exportProjectJson(project.id)
    downloadBlob(new Blob([json], { type: 'application/json' }), `备份-${project.name}.json`)
    setToast('项目 JSON 备份已下载（含原始字节与全部历史）')
  }

  // ── 批量勾选 + AI 一键生成 ──

  /**
   * 单点勾选/取消。Shift+点击 → [上次单点锚点..本行] 整段置为本次点击后的状态
   * （锚点不移动，便于连续扩选）；普通点击 → 切换并更新锚点。
   */
  function toggleChecked(id: string, opts?: { shift?: boolean }) {
    if (opts?.shift) {
      const anchor = lastCheckedIdRef.current
      if (anchor && anchor !== id) {
        const ordered = orderedLessonIds(lessons)
        const value = !checked.has(id)
        setChecked((prev) => setMany(prev, rangeBetween(ordered, anchor, id), value))
        return
      }
    }
    setChecked((prev) => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
    lastCheckedIdRef.current = id
  }

  /** 批量置值：滑选区间 / Shift 范围 / 章节全选共用 */
  function setCheckedMany(ids: string[], value: boolean) {
    setChecked((prev) => setMany(prev, ids, value))
  }

  function toggleCheckAll() {
    setChecked((prev) =>
      prev.size === lessons.length ? new Set() : new Set(lessons.map((l) => l.id)),
    )
  }

  /** 勾选课时 → 逐篇 AI 转化（顺序 + 篇间隔限流；单篇失败不阻断，结束点名报告） */
  async function batchAi() {
    if (!project || aiBatch?.running) return
    if (!isAiConfigured(loadAiSettings())) {
      setToast('当前 AI 供应商未配置 API Key——点击顶部「AI 设置」')
      return
    }
    const targets = lessons.filter((l) => checked.has(l.id))
    if (targets.length === 0) {
      setToast('未勾选任何课时')
      return
    }
    if (
      !confirm(
        `将对勾选的 ${targets.length} 篇课时各发起至少 1 次 AI 请求（OpenRouter 免费档每日限额约 50 次，失败换模型会增多）。结果按课时缓存，可在各课时「AI 转化」面板查看。继续？`,
      )
    )
      return
    try {
      const inputs: BatchLessonInput[] = []
      for (const l of targets) {
        const ctx = await loadLessonContext(l)
        inputs.push({
          lessonId: l.id,
          title: l.title,
          typeLabel: lessonTypeLabel(l.typeManual, ctx.effective?.plan.type),
          promptText: ctx.effective?.plan.promptText ?? null,
          noteText: ctx.revision?.text ?? null,
        })
      }
      setAiBatch({ running: true, done: 0, total: inputs.length, current: null })
      batchCancelRef.current = false
      const r = await runBatchTransform(inputs, {
        onProgress: (p) =>
          setAiBatch({ running: true, done: p.done, total: p.total, current: p.currentTitle }),
        isCancelled: () => batchCancelRef.current,
      })
      const failed = r.outcomes.filter((o) => !o.ok)
      const stopNote = r.cancelled
        ? `（已手动停止，余下 ${inputs.length - r.outcomes.length} 篇未处理）`
        : ''
      setToast(
        failed.length > 0
          ? `AI 批量完成${stopNote}：成功 ${r.ok}，失败 ${failed.length}——${failed.map((f) => `${f.title}：${f.detail}`).join('；')}`
          : r.cancelled
            ? `AI 批量已停止：完成 ${r.ok} 篇（结果已缓存，可重新勾选续跑，已完成的走缓存不再耗额度）`
            : `AI 批量完成：${r.ok} 篇全部成功（结果已缓存，到各课时「AI 转化」面板审阅/复制）`,
      )
    } catch (e) {
      setToast(`AI 批量中断：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setAiBatch(null)
    }
  }

  async function restoreJson(file: File) {
    try {
      const newId = await importProjectJson(await file.text())
      await refreshProjects()
      const p = (await listProjects()).find((x) => x.id === newId)
      if (p) await selectProject(p)
      setToast('备份已恢复为新项目')
    } catch (e) {
      setToast(`恢复失败：${String(e)}`)
    }
  }

  // ── 界面 ──
  if (screen === 'welcome') {
    return (
      <div className="app">
        <header className="app-header">
          <h1>LessonForge</h1>
          <span className="muted">Obsidian 课程 → 互动课堂提示词（本地运行 · 零上传）</span>
        </header>
        <div className="welcome">
          <button
            onClick={() => {
              setScreen('import')
            }}
          >
            导入课程资料，新建项目
          </button>
          <h3>已有项目（刷新后自动恢复）</h3>
          {projects.length === 0 ? <div className="muted">暂无项目</div> : null}
          {projects.map((p) => (
            <div key={p.id} className="project-row">
              <button
                onClick={() => {
                  selectProject(p)
                }}
              >
                打开
              </button>
              <span>{p.name}</span>
              <span className="muted">{new Date(p.updatedAt).toLocaleString('zh-CN')}</span>
              <button
                className="danger"
                onClick={async () => {
                  if (!confirm(`删除项目「${p.name}」？建议先导出 JSON 备份。`)) return
                  await deleteProject(p.id)
                  await refreshProjects()
                }}
              >
                删除
              </button>
            </div>
          ))}
          <div className="restore">
            从 JSON 备份恢复：
            <input
              type="file"
              accept=".json"
              onChange={(e) => e.target.files?.[0] && restoreJson(e.target.files[0])}
            />
          </div>
        </div>
        {toast ? <div className="toast">{toast}</div> : null}
      </div>
    )
  }

  if (screen === 'import') {
    return (
      <div className="app">
        <ImportWizard
          onDone={(files, source, otherFiles, dirHandle) =>
            onImportDone(files, source, otherFiles, dirHandle)
          }
          onCancel={() => setScreen('welcome')}
        />
        {toast ? <div className="toast">{toast}</div> : null}
      </div>
    )
  }

  if (screen === 'structure-confirm' && pendingStructure) {
    return (
      <div className="app">
        <StructureConfirm
          structure={pendingStructure}
          onRename={(path, title) => {
            const m = new Map(renames)
            m.set(path, title)
            setRenames(m)
          }}
          onConfirm={onStructureConfirm}
        />
        {toast ? <div className="toast">{toast}</div> : null}
      </div>
    )
  }

  return (
    <div className="app main">
      <header className="app-header">
        <button className="link" onClick={() => setScreen('welcome')}>
          ← 项目
        </button>
        <h1>{project?.name}</h1>
        <div className="header-actions">
          <select
            className="scope-select"
            value={effectiveScope}
            onChange={(e) => setBatchScope(e.target.value as BatchScope)}
            title="「编译」与「批量导出」的作用范围：全部课时，或左侧勾选的课时"
          >
            <option value="all">范围：全部课时</option>
            {checked.size > 0 ? (
              <option value="checked">范围：已勾选（{checked.size}）</option>
            ) : null}
          </select>
          <button onClick={batchCompile}>
            {effectiveScope === 'checked' ? `编译勾选（${checked.size}）` : '编译全部'}
          </button>
          <button onClick={batchExport}>
            {effectiveScope === 'checked' ? `导出勾选（${checked.size}）` : '批量导出 ZIP'}
          </button>
          <button
            onClick={() => setShowChapterMerge(true)}
            title="把一章各课时的提示词（AI 稿/编译稿）合并成一份，整段复制/导出给豆包爱学"
          >
            📑 按章整合
          </button>
          {project?.dirHandle || supportsDirectoryPicker() ? (
            <button
              onClick={bindOrResyncDir}
              disabled={resyncBusy}
              title={
                project?.dirHandle
                  ? '重新读取绑定的课程目录：新增/内容变化自动合并，检测到源文件删除会同步移除课时'
                  : '绑定课程目录（选当初导入的同一文件夹）：此后每次打开项目自动重读目录增量更新'
              }
            >
              {resyncBusy ? '重读中…' : project?.dirHandle ? '⟳ 重读目录' : '⟳ 绑定目录'}
            </button>
          ) : null}
          <button onClick={backupJson}>备份 JSON</button>
          <button onClick={() => setShowAiSettings(true)}>⚙ AI 设置</button>
        </div>
      </header>
      <div className="main-columns">
        <aside className="sidebar">
          <div className="sidebar-toolbar">
            <button className="link" onClick={toggleCheckAll}>
              {lessons.length > 0 && checked.size === lessons.length ? '清空' : '全选'}
            </button>
            <span className="muted">已勾选 {checked.size}</span>
            <button
              className="ai-batch-btn"
              onClick={batchAi}
              disabled={checked.size === 0 || (aiBatch?.running ?? false)}
              title="对勾选课时逐篇调用 OpenRouter 免费模型生成提示词（顺序执行，结果缓存到各课时）"
            >
              {aiBatch?.running
                ? `AI 批量中 ${aiBatch.done}/${aiBatch.total}…`
                : `AI 一键生成（${checked.size}）`}
            </button>
          </div>
          {aiBatch?.running ? (
            <div className="sidebar-progress">
              <span className="muted">
                {aiBatch.done}/{aiBatch.total}
                {aiBatch.current ? ` 当前：《${aiBatch.current}》` : ''}
              </span>
              <button className="link" onClick={() => (batchCancelRef.current = true)}>
                停止
              </button>
            </div>
          ) : null}
          <LessonTree
            lessons={lessons}
            statuses={statuses}
            selectedId={selected?.id ?? null}
            onSelect={(id) => {
              const l = lessons.find((x) => x.id === id)
              if (l) selectLesson(l)
            }}
            checkedIds={checked}
            onToggleCheck={toggleChecked}
            onSetCheckedMany={setCheckedMany}
          />
        </aside>
        <main className="content">
          {selected ? (
            <>
              <TracePeek revision={revision} trace={trace} />
              <LessonWorkbench
                lesson={selected}
                status={statuses.get(selected.id) ?? ({ uiState: '未编译' } as LessonStatus)}
                effective={effective}
                revision={revision}
                onAction={onAction}
                onEditSection={onEditSection}
                onSetType={async (t) => {
                  if (!selected) return
                  await setLessonTypeManual(selected.id, t)
                  setToast(t ? '已人工指定课型（重编译后生效）' : '已恢复自动课型判定')
                  await refreshSelected()
                }}
                onIncludeMku={async (mku) => {
                  if (!selected) return
                  try {
                    await addManualSection(selected.id, `补充·${mku.kind}`, mku.text, {
                      file: selected.normPath,
                      start: mku.span.start,
                      end: mku.span.end,
                    })
                    setToast('已补入为 A 级段落（带原文溯源，overlay 保护）')
                  } catch (e) {
                    setToast(`补入失败：${String(e)}`)
                  }
                  await refreshSelected()
                }}
                onJumpTrace={(s: PromptSection) => {
                  const t = s.traces[0]
                  if (t) setTrace({ start: t.start, end: t.end })
                }}
                onToast={setToast}
                onMarkExported={async () => {
                  if (!selected) return
                  await markExported(selected.id)
                }}
                refresh={refreshSelected}
              />
            </>
          ) : (
            <div className="muted">选择左侧课时</div>
          )}
        </main>
      </div>
      {showAiSettings ? (
        <AiSettingsDialog onClose={() => setShowAiSettings(false)} onToast={setToast} />
      ) : null}
      {showChapterMerge && project ? (
        <ChapterMergeDialog
          project={project}
          lessons={lessons}
          onClose={() => setShowChapterMerge(false)}
          onToast={setToast}
          onExported={async () => {
            await refreshLessons(project.id)
          }}
        />
      ) : null}
      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  )
}
