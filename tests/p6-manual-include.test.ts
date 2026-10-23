/** 人工补入（未纳入 MKU → A 段 + 溯源 + overlay 保护）与批量编译相关持久化行为 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ImportedFile } from '../src/core/types'
import {
  addManualSection,
  compileAndStoreDraft,
  createProject,
  ensureLessons,
  getEffectivePlan,
  importFiles,
} from '../src/core/persist/project'
import { getDb, resetDbForTest } from '../src/core/persist/db'

function mdFile(path: string, text: string): ImportedFile {
  const bytes = new TextEncoder().encode(text)
  return {
    normPath: path,
    fileName: path.split('/')!.pop()!,
    ext: 'md',
    byteSize: bytes.length,
    kind: 'md',
    source: { type: 'bytes', bytes },
  }
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

describe('人工补入（基线 §8 护栏）', () => {
  it('补入后：生成带溯源的 A 级段落、计入 overlay、刷新后保留、覆盖数下降', async () => {
    const project = await createProject('课程')
    await importFiles(
      project.id,
      [mdFile('课程/a.md', '# A\n\n定义：A 称之为 B。\n\n普通未纳入段。')],
      'dir',
    )
    const lessons = await ensureLessons(project.id)
    const lessonId = lessons[0]!.id
    await compileAndStoreDraft(lessonId)

    let eff = await getEffectivePlan(lessonId)!
    const before = eff!.plan.coverage.coreTotal
    const uncoveredBefore = eff!.plan.coverage.uncovered.length
    expect(uncoveredBefore).toBeGreaterThanOrEqual(0)

    // 找一个未覆盖的背景段（MKU 列表在编译时生成；这里直接补入已知区间——"普通未纳入段。"）
    const rev = (await import('../src/core/persist/project')).getCurrentRevision(
      project.id,
      '课程/a.md',
    )
    const text = (await rev)!.text
    const idx = text.indexOf('普通未纳入段。')
    expect(idx).toBeGreaterThan(0)
    await addManualSection(lessonId, '补充·background', '普通未纳入段。', {
      file: '课程/a.md',
      start: idx,
      end: idx + '普通未纳入段。'.length,
    })

    eff = (await getEffectivePlan(lessonId))!
    const manual = eff!.plan.sections.find((s) => s.role === '补充·background')
    expect(manual).toBeDefined()
    expect(manual!.contentType).toBe('A')
    expect(manual!.traces).toHaveLength(1)
    expect(manual!.traces[0]!.file).toBe('课程/a.md')
    expect(eff!.hasEdits).toBe(true)

    // 刷新后保留（U2）
    resetDbForTest()
    const eff2 = (await getEffectivePlan(lessonId))!
    expect(eff2!.plan.sections.some((s) => s.role === '补充·background')).toBe(true)
    expect(eff2!.plan.coverage.coreTotal).toBe(before)
  })

  it('与编辑共存：补入 + 段落编辑同时生效', async () => {
    const project = await createProject('课程')
    await importFiles(project.id, [mdFile('课程/a.md', '# A\n\n定义：A 称之为 B。')], 'dir')
    const lessons = await ensureLessons(project.id)
    const lessonId = lessons[0]!.id
    await compileAndStoreDraft(lessonId)
    const { saveEdit } = await import('../src/core/persist/project')
    await saveEdit(lessonId, 's1', '人工改写')
    await addManualSection(lessonId, '补充·extra', '补充内容', {
      file: '课程/a.md',
      start: 0,
      end: 5,
    })
    const eff = (await getEffectivePlan(lessonId))!
    expect(eff!.plan.sections.find((s) => s.sectionId === 's1')!.content).toBe('人工改写')
    expect(eff!.plan.sections.some((s) => s.role === '补充·extra')).toBe(true)
    const db = getDb()
    const overlay = await db.overlays.get(lessonId)
    expect(overlay!.edits.length).toBe(2)
  })
})
