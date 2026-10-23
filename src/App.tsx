/** 应用主入口：项目列表 / 导入向导 / 工作台 / 诊断 / 批量导出 */
import { useCallback, useEffect, useState } from 'react'
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
  resolveConflict,
  saveEdit,
  type LessonStatus,
} from './core/persist/project'
import type { LessonRecord, ProjectRecord, RevisionRecord } from './core/persist/db'
import { getCurrentRevision } from './core/persist/project'
import { inferStructure, type StructureCourse } from './core/structure/infer'
import { ImportWizard, StructureConfirm } from './ui/ImportWizard'
import { LessonTree, LessonWorkbench, TracePeek, loadLessonContext } from './ui/LessonPanel'

type Screen = 'welcome' | 'import' | 'structure-confirm' | 'main'

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

  async function selectProject(p: ProjectRecord) {
    setProject(p)
    setSelected(null)
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

  async function onImportDone(files: import('./core/types').ImportedFile[], source: 'dir' | 'zip') {
    const p = await createProject(`课程 ${new Date().toLocaleString('zh-CN')}`)
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
    await selectProject(project!)
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

  async function batchExport() {
    if (!project) return
    const exported: { plan: any; meta: LessonExportMeta }[] = []
    for (const l of lessons) {
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
    for (const l of lessons) await markExported(l.id)
    await refreshLessons(project.id)
  }

  async function backupJson() {
    if (!project) return
    const json = await exportProjectJson(project.id)
    downloadBlob(new Blob([json], { type: 'application/json' }), `备份-${project.name}.json`)
    setToast('项目 JSON 备份已下载（含原始字节与全部历史）')
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
          <h1>Classroom Compiler</h1>
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
          onDone={(files, source) => onImportDone(files, source)}
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
          <button onClick={batchExport}>批量导出 ZIP</button>
          <button onClick={backupJson}>备份 JSON</button>
        </div>
      </header>
      <div className="main-columns">
        <aside className="sidebar">
          <LessonTree
            lessons={lessons}
            statuses={statuses}
            selectedId={selected?.id ?? null}
            onSelect={(id) => {
              const l = lessons.find((x) => x.id === id)
              if (l) selectLesson(l)
            }}
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
                onJumpTrace={(s: PromptSection) => {
                  const t = s.traces[0]
                  if (t) setTrace({ start: t.start, end: t.end })
                }}
                refresh={refreshSelected}
              />
            </>
          ) : (
            <div className="muted">选择左侧课时</div>
          )}
        </main>
      </div>
      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  )
}
