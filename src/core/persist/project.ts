/**
 * 项目操作层：导入/幂等/课时/草稿/冲突/审批/备份（架构基线 §9 六场景）。
 *
 * U1 不可静默覆盖：重编译在存在用户编辑时产生 candidate 草稿，旧 active 保持生效，
 * 冲突由用户显式裁决（keep-mine / adopt-new 人工迁移）。
 * U2 可恢复：draft 永不删除（superseded 保留）；overlay 为追加式日志；JSON 备份含全历史。
 */
import { randomUUID } from './crypto'
import type { LessonPlan, PromptSettings } from '../compile/compile'
import { classifyType, extractFeatures, type LessonType } from '../classify/type'
import { compileLesson } from '../compile/compile'
import { buildRevision } from '../custody/custody'
import { inferStructure } from '../structure/infer'
import { parseDoc } from '../parse/parse'
import { segmentMkus } from '../model/mku'
import type { ImportedFile } from '../types'
import { COMPILER_VERSION } from '../version'
import {
  getDb,
  type DiagnosticRecord,
  type DraftRecord,
  type LessonRecord,
  type OverlayEdit,
  type OverlayRecord,
  type PathIndexRecord,
  type ProjectRecord,
  type RevisionRecord,
} from './db'

export type LessonUiState = '最新' | '有修改' | '需重新编译' | '冲突' | '编译错误' | '未编译'

export interface LessonStatus {
  staleSource: boolean
  staleCompiler: boolean
  hasEdits: boolean
  hasActiveDraft: boolean
  hasCandidate: boolean
  uiState: LessonUiState
}

export async function createProject(
  name: string,
  settings?: Partial<PromptSettings>,
): Promise<ProjectRecord> {
  const db = getDb()
  const now = Date.now()
  const rec: ProjectRecord = {
    id: randomUUID(),
    name,
    createdAt: now,
    updatedAt: now,
    modelVersion: 1,
    settings: settings as Record<string, unknown>,
  }
  await db.projects.add(rec)
  return rec
}

export interface ImportOutcome {
  added: string[]
  unchanged: string[]
  /** 同路径内容变化 → 新修订版 + 课时标 staleSource */
  changed: string[]
  revisions: string[]
}

/** 导入文件：字节入 custody（幂等：同路径同哈希 → 无操作；同路径新哈希 → 新修订版） */
export async function importFiles(
  projectId: string,
  files: ImportedFile[],
  source: 'dir' | 'zip',
): Promise<ImportOutcome> {
  const db = getDb()
  const outcome: ImportOutcome = { added: [], unchanged: [], changed: [], revisions: [] }
  const batchId = randomUUID()
  const mdFiles = files.filter((f) => f.kind === 'md')
  await db.batches.add({
    id: batchId,
    projectId,
    at: Date.now(),
    source,
    fileCount: mdFiles.length,
  })
  for (const f of files) {
    const { materializeBytes } = await import('../types')
    const bytes = await materializeBytes(f)
    const rev = await buildRevision(projectId, batchId, f, bytes)
    const key = `${projectId}:${f.normPath}`
    const existing = await db.pathIndex.get(key)
    if (existing) {
      if (existing.revisionIds.includes(rev.id)) {
        outcome.unchanged.push(f.normPath)
        continue // 幂等
      }
      // 内容变化：新修订版，指针切换，不自动重编译、不动 overlay
      await db.revisions.add(rev)
      await db.pathIndex.update(key, {
        currentRevisionId: rev.id,
        revisionIds: [...existing.revisionIds, rev.id],
        updatedAt: Date.now(),
      })
      outcome.changed.push(f.normPath)
      outcome.revisions.push(rev.id)
      continue
    }
    await db.revisions.add(rev)
    const rec: PathIndexRecord = {
      key,
      projectId,
      normPath: f.normPath,
      kind: f.kind === 'md' ? 'md' : 'image',
      currentRevisionId: rev.id,
      revisionIds: [rev.id],
      updatedAt: Date.now(),
    }
    await db.pathIndex.add(rec)
    if (f.kind === 'md') outcome.added.push(f.normPath)
    outcome.revisions.push(rev.id)
  }
  await db.projects.update(projectId, { updatedAt: Date.now() })
  return outcome
}

export async function getCurrentRevision(
  projectId: string,
  normPath: string,
): Promise<RevisionRecord | undefined> {
  const db = getDb()
  const idx = await db.pathIndex.get(`${projectId}:${normPath}`)
  if (!idx) return undefined
  return db.revisions.get(idx.currentRevisionId)
}

export async function listLessons(projectId: string): Promise<LessonRecord[]> {
  const db = getDb()
  const all = await db.lessons.where('projectId').equals(projectId).toArray()
  return all
}

/** 从 pathIndex 重建课时记录（结构推断 + 已有记录的状态保留） */
export async function ensureLessons(projectId: string): Promise<LessonRecord[]> {
  const db = getDb()
  const idx = await db.pathIndex.where('projectId').equals(projectId).toArray()
  const mdPaths = idx.filter((x) => x.kind === 'md').map((x) => x.normPath)
  if (mdPaths.length === 0) return []
  // 信号：标题来自 frontmatter/H1（需读取当前修订文本解析——为控制成本仅取标题与 frontmatter）
  const revs = await Promise.all(mdPaths.map((p) => getCurrentRevision(projectId, p)))
  const signals = mdPaths.map((p, i) => {
    const rev = revs[i]
    let headings: { depth: number; text: string }[] = []
    let frontmatter: Record<string, unknown> | null = null
    if (rev) {
      const doc = parseDoc(rev.text)
      headings = doc.blocks
        .filter((b) => b.kind === 'heading')
        .map((b) => ({ depth: b.meta.depth ?? 1, text: b.text }))
      frontmatter = doc.frontmatter.ok ? doc.frontmatter.data : null
    }
    return { normPath: p, headings, frontmatter }
  })
  const structure = inferStructure(signals, '课程')
  const existing = new Map((await listLessons(projectId)).map((l) => [l.normPath, l]))

  const upserts: LessonRecord[] = []
  const walkChapters = (
    chapters: {
      name: string
      path: string
      lessons: { path: string; title: string }[]
      subChapters: any[]
    }[],
  ) => {
    for (const ch of chapters) {
      for (const l of ch.lessons) upsertLesson(l.path, ch.name, l.title)
      walkChapters(ch.subChapters ?? [])
    }
  }
  const upsertLesson = (path: string, chapter: string, title: string) => {
    const id = `${projectId}:${path}`
    const prev = existing.get(path)
    if (prev) {
      upserts.push({
        ...prev,
        chapter,
        // 已有人工标题保留
        title: prev.titleSource === 'manual' ? prev.title : title,
      })
      return
    }
    upserts.push({
      id,
      projectId,
      normPath: path,
      chapter,
      title,
      titleSource: 'inferred',
      typeManual: null,
      status: 'structured',
      coverageAckAt: null,
      approvedAt: null,
      exportedAt: null,
    })
  }
  walkChapters(structure.chapters)
  for (const l of structure.rootLessons) upsertLesson(l.path, '（未分章）', l.title)

  if (upserts.length > 0) await db.lessons.bulkPut(upserts)
  return upserts
}

/** 课时状态（派生标志 + UI 组合状态） */
export async function computeLessonStatus(lessonId: string): Promise<LessonStatus> {
  const db = getDb()
  const lesson = await db.lessons.get(lessonId)
  if (!lesson) throw new Error(`课时不存在: ${lessonId}`)
  const [activeDraft, candidateDraft, overlay] = await Promise.all([
    db.drafts
      .where('lessonId')
      .equals(lessonId)
      .and((d) => d.state === 'active')
      .first(),
    db.drafts
      .where('lessonId')
      .equals(lessonId)
      .and((d) => d.state === 'candidate')
      .first(),
    db.overlays.get(lessonId),
  ])
  const rev = await getCurrentRevision(lesson.projectId, lesson.normPath)
  const staleSource = !!activeDraft && !!rev && activeDraft.contentHash !== rev.contentHash
  const staleCompiler = !!activeDraft && activeDraft.compilerVersion !== COMPILER_VERSION
  const hasEdits = !!overlay && overlay.edits.length > 0
  const hasActiveDraft = !!activeDraft
  let uiState: LessonUiState
  if (!hasActiveDraft) uiState = candidateDraft ? '编译错误' : '未编译'
  else if (staleSource || staleCompiler) uiState = hasEdits ? '冲突' : '需重新编译'
  else if (hasEdits) uiState = '有修改'
  else uiState = '最新'
  return {
    staleSource,
    staleCompiler,
    hasEdits,
    hasActiveDraft,
    hasCandidate: !!candidateDraft,
    uiState,
  }
}

/** 编译并存草稿（无既有编辑 → active；有 → candidate，等待裁决） */
export async function compileAndStoreDraft(
  lessonId: string,
): Promise<{ plan: LessonPlan; draftId: string; conflict: boolean }> {
  const db = getDb()
  const lesson = await db.lessons.get(lessonId)
  if (!lesson) throw new Error(`课时不存在: ${lessonId}`)
  const rev = await getCurrentRevision(lesson.projectId, lesson.normPath)
  if (!rev) throw new Error('课时不指向任何修订版')
  const doc = parseDoc(rev.text)
  const features = extractFeatures(doc)
  let typeDecision = classifyType(features)
  if (lesson.typeManual) {
    typeDecision = { ...typeDecision, type: lesson.typeManual as LessonType, ambiguous: false }
  }
  const mkus = segmentMkus(doc, lesson.normPath)
  const project = await db.projects.get(lesson.projectId)
  const plan = compileLesson({
    lessonId,
    lessonTitle: lesson.title,
    lessonPath: lesson.normPath,
    doc,
    mkus,
    type: typeDecision,
    settings: (project?.settings ?? {}) as Partial<PromptSettings>,
  })
  const overlay = await db.overlays.get(lessonId)
  const activeDraft = await db.drafts
    .where('lessonId')
    .equals(lessonId)
    .and((d) => d.state === 'active')
    .first()
  const conflict = !!overlay && overlay.edits.length > 0 && !!activeDraft
  const draftId = randomUUID()
  await db.drafts.add({
    id: draftId,
    lessonId,
    state: conflict ? 'candidate' : 'active',
    plan,
    contentHash: rev.contentHash,
    compilerVersion: COMPILER_VERSION,
    createdAt: Date.now(),
  } satisfies DraftRecord)
  if (!conflict && activeDraft) {
    await db.drafts.update(activeDraft.id, { state: 'superseded' })
  }
  if (!conflict) {
    await db.lessons.update(lessonId, { status: 'compiled' })
  }
  return { plan, draftId, conflict }
}

/** 生效计划：active 草稿 + overlay 合成 */
export async function getEffectivePlan(lessonId: string): Promise<{
  plan: LessonPlan
  edits: OverlayEdit[]
  hasEdits: boolean
  baseDraftId: string
} | null> {
  const db = getDb()
  const active = await db.drafts
    .where('lessonId')
    .equals(lessonId)
    .and((d) => d.state === 'active')
    .first()
  if (!active) return null
  const overlay = await db.overlays.get(lessonId)
  const plan = active.plan as LessonPlan
  const edits = overlay && overlay.baseDraftId === active.id ? overlay.edits : []
  return {
    plan: applyEdits(plan, edits),
    edits,
    hasEdits: edits.length > 0,
    baseDraftId: active.id,
  }
}

export function applyEdits(plan: LessonPlan, edits: OverlayEdit[]): LessonPlan {
  if (edits.length === 0) return plan
  const sections = plan.sections.map((s) => ({ ...s }))
  for (const e of edits) {
    if (e.op === 'replace') {
      const t = sections.find((s) => s.sectionId === e.sectionId)
      if (t) t.content = e.content
    } else if (e.op === 'delete') {
      const i = sections.findIndex((s) => s.sectionId === e.sectionId)
      if (i >= 0) sections.splice(i, 1)
    } else if (e.op === 'add') {
      sections.push({
        sectionId: e.sectionId,
        role: '（人工补充）',
        contentType: 'A',
        content: e.content,
        traces: [],
        basis: '用户人工补充（无原文溯源）',
      })
    }
  }
  return { ...plan, sections }
}

/** 保存用户编辑（追加式；无 overlay 则基于当前 active 创建） */
export async function saveEdit(
  lessonId: string,
  sectionId: string,
  content: string,
): Promise<void> {
  const db = getDb()
  const active = await db.drafts
    .where('lessonId')
    .equals(lessonId)
    .and((d) => d.state === 'active')
    .first()
  if (!active) throw new Error('无 active 草稿，无法编辑')
  const existing = await db.overlays.get(lessonId)
  const edit: OverlayEdit = { sectionId, op: 'replace', content, at: Date.now() }
  if (existing && existing.baseDraftId === active.id) {
    // 追加式：同段后写覆盖先写（重建时按顺序应用）
    const edits = [
      ...existing.edits.filter((e) => !(e.sectionId === sectionId && e.op === 'replace')),
      edit,
    ]
    await db.overlays.update(lessonId, { edits, updatedAt: Date.now() })
  } else if (existing) {
    // base 变化的旧 overlay：保留历史于 JSON 备份语义中（记录仍在），但生效 overlay 重建
    await db.overlays.update(lessonId, {
      baseDraftId: active.id,
      edits: [...existing.edits, edit],
      updatedAt: Date.now(),
    })
  } else {
    await db.overlays.add({
      lessonId,
      baseDraftId: active.id,
      edits: [edit],
      updatedAt: Date.now(),
    })
  }
}

/** 冲突裁决（U1）：keep-mine=保留旧 active（candidate 作废）；adopt-new=人工迁移到新草稿 */
export async function resolveConflict(
  lessonId: string,
  choice: 'keep-mine' | 'adopt-new',
): Promise<void> {
  const db = getDb()
  const candidate = await db.drafts
    .where('lessonId')
    .equals(lessonId)
    .and((d) => d.state === 'candidate')
    .first()
  const active = await db.drafts
    .where('lessonId')
    .equals(lessonId)
    .and((d) => d.state === 'active')
    .first()
  if (!candidate || !active) throw new Error('无待决冲突')
  if (choice === 'keep-mine') {
    await db.drafts.update(candidate.id, { state: 'superseded' })
    return
  }
  // adopt-new：新草稿转 active，人工迁移 = 把既有编辑记录追加到新 base（sectionId 对齐为提示，内容由用户核对）
  const overlay = await db.overlays.get(lessonId)
  await db.drafts.update(active.id, { state: 'superseded' })
  await db.drafts.update(candidate.id, { state: 'active' })
  if (overlay) {
    await db.overlays.update(lessonId, { baseDraftId: candidate.id, updatedAt: Date.now() })
  }
  await db.lessons.update(lessonId, { status: 'compiled' })
}

/** 审批（K2 试验期：要求已查看覆盖情况） */
export async function approveLesson(lessonId: string): Promise<{ ok: boolean; reason?: string }> {
  const db = getDb()
  const lesson = await db.lessons.get(lessonId)
  if (!lesson) return { ok: false, reason: '课时不存在' }
  const eff = await getEffectivePlan(lessonId)
  if (!eff) return { ok: false, reason: '尚无编译结果' }
  if (!lesson.coverageAckAt)
    return { ok: false, reason: '试验期门禁：请先查看覆盖情况（未纳入清单）' }
  await db.lessons.update(lessonId, { status: 'approved', approvedAt: Date.now() })
  return { ok: true }
}

export async function markCoverageAck(lessonId: string): Promise<void> {
  await getDb().lessons.update(lessonId, { coverageAckAt: Date.now() })
}

export async function markExported(lessonId: string): Promise<void> {
  await getDb().lessons.update(lessonId, { status: 'exported', exportedAt: Date.now() })
}

export async function renameLessonTitle(lessonId: string, title: string): Promise<void> {
  await getDb().lessons.update(lessonId, { title, titleSource: 'manual' })
}

export async function setLessonTypeManual(
  lessonId: string,
  type: LessonType | null,
): Promise<void> {
  await getDb().lessons.update(lessonId, { typeManual: type })
}

export async function addDiagnostic(rec: Omit<DiagnosticRecord, 'id' | 'at'>): Promise<void> {
  await getDb().diagnostics.add({ ...rec, at: Date.now() })
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : -1
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : -1
    out += B64[b0 >> 2]!
    out += B64[((b0 & 3) << 4) | (b1 === -1 ? 0 : b1 >> 4)]!
    out += b1 === -1 ? '=' : B64[((b1 & 15) << 2) | (b2 === -1 ? 0 : b2 >> 6)]!
    out += b2 === -1 ? '=' : B64[b2 & 63]!
  }
  return out
}

function base64ToBytes(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '')
  const out: number[] = []
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64.indexOf(clean[i]!)
    const c1 = B64.indexOf(clean[i + 1] ?? 'A')
    const c2 = clean[i + 2] === undefined ? -1 : B64.indexOf(clean[i + 2]!)
    const c3 = clean[i + 3] === undefined ? -1 : B64.indexOf(clean[i + 3]!)
    out.push((c0 << 2) | (c1 >> 4))
    if (c2 >= 0) out.push(((c1 & 15) << 4) | (c2 >> 2))
    if (c3 >= 0) out.push(((c2 & 3) << 6) | c3)
  }
  return new Uint8Array(out)
}

/** 项目 JSON 备份（含全部草稿与 overlay 历史） */
export async function exportProjectJson(projectId: string): Promise<string> {
  const db = getDb()
  const lessons = await db.lessons.where('projectId').equals(projectId).toArray()
  const lessonIds = new Set(lessons.map((l) => l.id))
  const [project, batches, revisions, pathIndex, drafts, overlays, diagnostics] = await Promise.all(
    [
      db.projects.get(projectId),
      db.batches.where('projectId').equals(projectId).toArray(),
      db.revisions.where('projectId').equals(projectId).toArray(),
      db.pathIndex.where('projectId').equals(projectId).toArray(),
      db.drafts.toArray().then((all) => all.filter((d) => lessonIds.has(d.lessonId))),
      db.overlays.toArray().then((all) => all.filter((o) => lessonIds.has(o.lessonId))),
      db.diagnostics.where('projectId').equals(projectId).toArray(),
    ],
  )
  if (!project) throw new Error('项目不存在')
  const revisionsB64 = revisions.map((r) => ({
    ...r,
    bytes: bytesToBase64(r.bytes) as unknown as Uint8Array,
  }))
  return JSON.stringify({
    format: 'classroom-compiler/project-backup',
    version: 1,
    exportedAt: Date.now(),
    project,
    batches,
    revisions: revisionsB64,
    pathIndex,
    lessons,
    drafts,
    overlays,
    diagnostics,
  })
}

/** 从 JSON 备份恢复（新项目 ID，避免覆盖现有数据） */
export async function importProjectJson(json: string): Promise<string> {
  const db = getDb()
  const data = JSON.parse(json)
  if (data.format !== 'classroom-compiler/project-backup') throw new Error('非本项目备份格式')
  const newId = randomUUID()
  await db.projects.add({ ...data.project, id: newId, updatedAt: Date.now() })
  for (const t of ['revisions', 'pathIndex', 'lessons'] as const) {
    const rows = (data[t] as Record<string, unknown>[]).map((r) => rewriteProjectId(r, newId))
    await db.table(t).bulkAdd(rows)
  }
  // 字节以 base64 恢复为 Uint8Array
  await db.revisions
    .where('projectId')
    .equals(newId)
    .modify((r) => {
      ;(r as unknown as { bytes: Uint8Array }).bytes = base64ToBytes(r.bytes as unknown as string)
    })
  // batches 主键为随机 UUID：必须整体换新，避免与现有记录冲突
  for (const b of data.batches as Record<string, unknown>[]) {
    await db.batches.add({ ...b, id: randomUUID(), projectId: newId } as never)
  }
  // drafts / overlays：lessonId 需重写（含 projectId）
  const lessonIdMap = new Map<string, string>()
  for (const l of data.lessons as { id: string; normPath: string }[]) {
    lessonIdMap.set(l.id, `${newId}:${l.normPath}`)
  }
  const draftIdMap = new Map<string, string>()
  for (const d of data.drafts as DraftRecord[]) {
    const newDraftId = randomUUID()
    draftIdMap.set(d.id, newDraftId)
    await db.drafts.add({ ...d, lessonId: lessonIdMap.get(d.lessonId)!, id: newDraftId })
  }
  for (const o of data.overlays as OverlayRecord[]) {
    await db.overlays.add({
      ...o,
      lessonId: lessonIdMap.get(o.lessonId)!,
      baseDraftId: draftIdMap.get(o.baseDraftId) ?? o.baseDraftId,
    })
  }
  for (const diag of data.diagnostics as Record<string, unknown>[]) {
    await db.diagnostics.add({
      ...(diag as Omit<DiagnosticRecord, 'id'>),
      projectId: newId,
      id: undefined as any,
    })
  }
  return newId
}

function rewriteProjectId<T extends Record<string, unknown>>(row: T, newId: string): T {
  const out: Record<string, unknown> = { ...row, projectId: newId }
  const id = row['id']
  if (typeof id === 'string' && id.includes(':')) {
    out['id'] = id.replace(/^[^:]+:/, `${newId}:`)
  }
  const key = row['key']
  if (typeof key === 'string') out['key'] = key.replace(/^[^:]+:/, `${newId}:`)
  return out as T
}

export async function deleteProject(projectId: string): Promise<void> {
  const db = getDb()
  const lessons = await db.lessons.where('projectId').equals(projectId).toArray()
  await db.transaction(
    'rw',
    [
      db.projects,
      db.batches,
      db.revisions,
      db.pathIndex,
      db.lessons,
      db.drafts,
      db.overlays,
      db.diagnostics,
    ],
    async () => {
      await db.projects.delete(projectId)
      await db.batches.where('projectId').equals(projectId).delete()
      await db.revisions.where('projectId').equals(projectId).delete()
      await db.pathIndex.where('projectId').equals(projectId).delete()
      await db.lessons.where('projectId').equals(projectId).delete()
      for (const l of lessons) {
        await db.drafts.where('lessonId').equals(l.id).delete()
      }
      await db.overlays
        .where('lessonId')
        .anyOf(lessons.map((l) => l.id))
        .delete()
      await db.diagnostics.where('projectId').equals(projectId).delete()
    },
  )
}

export async function listProjects(): Promise<ProjectRecord[]> {
  return getDb().projects.orderBy('updatedAt').reverse().toArray()
}
