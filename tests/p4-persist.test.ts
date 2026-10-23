/** P4：持久化六场景 + 冲突处理（U1/U2）+ 审批门禁（K2）+ 备份往返 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ImportedFile } from '../src/core/types'
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
  renameLessonTitle,
  resolveConflict,
  saveEdit,
} from '../src/core/persist/project'
import { getDb, resetDbForTest } from '../src/core/persist/db'

function mdFile(path: string, text: string): ImportedFile {
  const bytes = new TextEncoder().encode(text)
  const fileName = path.split('/').pop()!
  return {
    normPath: path,
    fileName,
    ext: 'md',
    byteSize: bytes.length,
    kind: 'md',
    source: { type: 'bytes', bytes },
  }
}

async function freshProject(files: ImportedFile[]) {
  const project = await createProject('测试课程')
  await importFiles(project.id, files, 'dir')
  const lessons = await ensureLessons(project.id)
  return { project, lessons }
}

beforeEach(async () => {
  resetDbForTest()
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase('classroom-compiler')
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
    req.onblocked = () => resolve()
  })
  resetDbForTest()
})

describe('场景 1：刷新恢复', () => {
  it('导入→编译→编辑→刷新后全部状态可恢复', async () => {
    const { project, lessons } = await freshProject([
      mdFile('课程/第1章/a.md', '# A\n\n定义：A 称之为 B。\n\n普通段。'),
    ])
    const lessonId = lessons[0]!.id
    await compileAndStoreDraft(lessonId)
    await saveEdit(lessonId, 's1', '人工修改后的内容')

    // 模拟刷新：重置单例（同一 fake-indexeddb 数据仍在）
    resetDbForTest()
    const lessons2 = await listLessons(project.id)
    expect(lessons2).toHaveLength(1)
    expect(lessons2[0]!.title).toBe('A')
    const eff = await getEffectivePlan(lessonId)
    expect(eff).not.toBeNull()
    expect(eff!.hasEdits).toBe(true)
    // 编辑内容仍在
    const section = eff!.plan.sections.find((s) => s.sectionId === 's1')
    expect(section?.content).toBe('人工修改后的内容')
    const status = await computeLessonStatus(lessonId)
    expect(status.uiState).toBe('有修改')
  })
})

describe('场景 2：同一文件重复导入（幂等）', () => {
  it('同路径同内容 → unchanged，无新修订版', async () => {
    const f = mdFile('课程/a.md', '# 内容')
    const { project } = await freshProject([f])
    const outcome = await importFiles(project.id, [mdFile('课程/a.md', '# 内容')], 'dir')
    expect(outcome.unchanged).toEqual(['课程/a.md'])
    expect(outcome.changed).toHaveLength(0)
    const db = getDb()
    const idx = await db.pathIndex.where('projectId').equals(project.id).toArray()
    expect(idx[0]!.revisionIds).toHaveLength(1)
  })
})

describe('场景 3：源文件变化', () => {
  it('同路径新内容 → 新修订版 + staleSource；不自动重编译、overlay 不动', async () => {
    const { project, lessons } = await freshProject([
      mdFile('课程/a.md', '# A\n\n定义：A 称之为 B。'),
    ])
    const lessonId = lessons[0]!.id
    await compileAndStoreDraft(lessonId)
    await saveEdit(lessonId, 's1', '用户编辑')
    const statusBefore = await computeLessonStatus(lessonId)
    expect(statusBefore.uiState).toBe('有修改')

    await importFiles(project.id, [mdFile('课程/a.md', '# A 改\n\n定义：A 称之为 C。')], 'dir')
    const statusAfter = await computeLessonStatus(lessonId)
    expect(statusAfter.staleSource).toBe(true)
    expect(statusAfter.uiState).toBe('冲突') // 有编辑且过期
    // overlay 未被破坏
    const eff = await getEffectivePlan(lessonId)
    expect(eff!.hasEdits).toBe(true)
    // 修订版历史 2 条
    const db = getDb()
    const idx = await db.pathIndex.where('projectId').equals(project.id).toArray()
    expect(idx[0]!.revisionIds).toHaveLength(2)
  })
})

describe('场景 4：编译规则升级', () => {
  it('draft.compilerVersion 不匹配 → staleCompiler → 需重新编译（无编辑时）', async () => {
    const { lessons } = await freshProject([mdFile('课程/a.md', '# A\n\n定义：A 称之为 B。')])
    const lessonId = lessons[0]!.id
    await compileAndStoreDraft(lessonId)
    const db = getDb()
    const draft = await db.drafts.where('lessonId').equals(lessonId).first()
    await db.drafts.update(draft!.id, { compilerVersion: 0 })
    const status = await computeLessonStatus(lessonId)
    expect(status.staleCompiler).toBe(true)
    expect(status.uiState).toBe('需重新编译')
  })
})

describe('场景 5：已编辑后再编译（U1 核心场景）', () => {
  it('重编译 → candidate 草稿 + 冲突状态；旧 active + 编辑保持生效', async () => {
    const { lessons } = await freshProject([mdFile('课程/a.md', '# A\n\n定义：A 称之为 B。')])
    const lessonId = lessons[0]!.id
    const first = await compileAndStoreDraft(lessonId)
    await saveEdit(lessonId, 's1', '我的定制内容')
    const second = await compileAndStoreDraft(lessonId)
    expect(second.conflict).toBe(true)

    const status = await computeLessonStatus(lessonId)
    // 冲突 UI 状态定义为「有编辑且源/编译器过期」；待决 candidate 是独立标志
    expect(status.uiState).toBe('有修改')
    expect(status.hasCandidate).toBe(true)

    // 默认保留我的版本：active 仍是旧草稿，编辑生效
    const eff = await getEffectivePlan(lessonId)
    expect(eff!.baseDraftId).toBe(first.draftId)
    const s1 = eff!.plan.sections.find((s) => s.sectionId === 's1')
    expect(s1!.content).toBe('我的定制内容')

    // 裁决：keep-mine → candidate 作废，状态回到 有修改
    await resolveConflict(lessonId, 'keep-mine')
    const after = await computeLessonStatus(lessonId)
    expect(after.hasCandidate).toBe(false)
    expect(after.uiState).toBe('有修改')
  })

  it('裁决 adopt-new → 新草稿生效（人工迁移语义：编辑记录挂到新 base）', async () => {
    const { lessons } = await freshProject([mdFile('课程/a.md', '# A\n\n定义：A 称之为 B。')])
    const lessonId = lessons[0]!.id
    await compileAndStoreDraft(lessonId)
    await saveEdit(lessonId, 's1', '我的定制内容')
    const second = await compileAndStoreDraft(lessonId)
    expect(second.conflict).toBe(true)
    await resolveConflict(lessonId, 'adopt-new')
    const eff = await getEffectivePlan(lessonId)
    expect(eff!.baseDraftId).toBe(second.draftId)
    // 编辑记录保留（迁移后由用户核对；sectionId 对齐为提示）
    const db = getDb()
    const overlay = await db.overlays.get(lessonId)
    expect(overlay!.baseDraftId).toBe(second.draftId)
    // 旧草稿保留（superseded，U2 可恢复）
    const superseded = await db.drafts
      .where('lessonId')
      .equals(lessonId)
      .and((d) => d.state === 'superseded')
      .toArray()
    expect(superseded.length).toBeGreaterThanOrEqual(1)
  })

  it('交错场景（黄金断言）：编辑 × 重编译 ×3 后，用户最后看到的文本可精确重建', async () => {
    const { lessons } = await freshProject([mdFile('课程/a.md', '# A\n\n定义：A 称之为 B。')])
    const lessonId = lessons[0]!.id
    await compileAndStoreDraft(lessonId)
    await saveEdit(lessonId, 's1', '版本1')
    const r2 = await compileAndStoreDraft(lessonId)
    await resolveConflict(lessonId, 'keep-mine')
    const mid = await getEffectivePlan(lessonId)
    expect(mid!.plan.sections.find((s) => s.sectionId === 's1')!.content).toBe('版本1')
    await saveEdit(lessonId, 's1', '版本2')
    const r3 = await compileAndStoreDraft(lessonId)
    await resolveConflict(lessonId, 'keep-mine')
    const final = await getEffectivePlan(lessonId)
    expect(final!.plan.sections.find((s) => s.sectionId === 's1')!.content).toBe('版本2')
    // 全部草稿历史保留
    const db = getDb()
    const all = await db.drafts.where('lessonId').equals(lessonId).toArray()
    expect(all.length).toBe(3)
    expect(r2.conflict).toBe(true)
    expect(r3.conflict).toBe(true)
  })
})

describe('场景 6：删除项目', () => {
  it('删除后项目及其全部关联记录消失', async () => {
    const { project, lessons } = await freshProject([
      mdFile('课程/a.md', '# A\n\n定义：A 称之为 B。'),
    ])
    await compileAndStoreDraft(lessons[0]!.id)
    await deleteProject(project.id)
    expect(await listProjects()).toHaveLength(0)
    const db = getDb()
    expect(await db.revisions.where('projectId').equals(project.id).toArray()).toHaveLength(0)
    expect(await db.drafts.toArray()).toHaveLength(0)
    expect(await db.pathIndex.where('projectId').equals(project.id).toArray()).toHaveLength(0)
  })
})

describe('K2 试验期审批门禁', () => {
  it('未查看覆盖情况 → 拒绝批准；查看后 → 批准成功', async () => {
    const { lessons } = await freshProject([mdFile('课程/a.md', '# A\n\n定义：A 称之为 B。')])
    const lessonId = lessons[0]!.id
    await compileAndStoreDraft(lessonId)
    const denied = await approveLesson(lessonId)
    expect(denied.ok).toBe(false)
    expect(denied.reason).toContain('覆盖')
    await markCoverageAck(lessonId)
    const ok = await approveLesson(lessonId)
    expect(ok.ok).toBe(true)
    const lesson = await getDb().lessons.get(lessonId)
    expect(lesson!.status).toBe('approved')
  })
})

describe('备份与恢复', () => {
  it('JSON 备份往返：字节逐字相等（B1）+ 状态完整', async () => {
    const { project, lessons } = await freshProject([
      mdFile('课程/第1章/a.md', '# A\n\n定义：A 称之为 B。\n\n普通段。'),
    ])
    const lessonId = lessons[0]!.id
    await compileAndStoreDraft(lessonId)
    await saveEdit(lessonId, 's1', '备份前的编辑')
    const json = await exportProjectJson(project.id)
    const newId = await importProjectJson(json)
    expect(newId).not.toBe(project.id)
    const lessons2 = await listLessons(newId)
    expect(lessons2).toHaveLength(1)
    const eff = await getEffectivePlan(lessons2[0]!.id)
    expect(eff!.hasEdits).toBe(true)
    expect(eff!.plan.sections.find((s) => s.sectionId === 's1')!.content).toBe('备份前的编辑')
    // B1：备份中的源文件字节与原始导入逐字相等
    const parsed = JSON.parse(json)
    // 备份中的字节为 base64
    const B64CH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    function b64d(s2: string) {
      const clean = s2.replace(/=+$/, '')
      const out = []
      for (let i = 0; i < clean.length; i += 4) {
        const c0 = B64CH.indexOf(clean[i])
        const c1 = B64CH.indexOf(clean[i + 1] ?? 'A')
        const c2 = B64CH.indexOf(clean[i + 2] ?? 'A')
        const c3 = B64CH.indexOf(clean[i + 3] ?? 'A')
        out.push((c0 << 2) | (c1 >> 4))
        if (clean[i + 2] !== undefined && clean[i + 2] !== '=')
          out.push(((c1 & 15) << 4) | (c2 >> 2))
        if (clean[i + 3] !== undefined && clean[i + 3] !== '=') out.push(((c2 & 3) << 6) | c3)
      }
      return new Uint8Array(out)
    }
    const revBytes = b64d(parsed.revisions[0].bytes)
    const expected = new TextEncoder().encode('# A\n\n定义：A 称之为 B。\n\n普通段。')
    expect(revBytes.length).toBe(expected.length)
    expect(revBytes.every((b, i) => b === expected[i])).toBe(true)
  })
})

describe('课时元数据操作', () => {
  it('人工标题覆盖（titleSource=manual，ensureLessons 不冲掉）', async () => {
    const { project, lessons } = await freshProject([mdFile('课程/a.md', '# 原标题')])
    await renameLessonTitle(lessons[0]!.id, '我的课时名')
    const again = await ensureLessons(project.id)
    expect(again[0]!.title).toBe('我的课时名')
    expect(again[0]!.titleSource).toBe('manual')
  })
})
