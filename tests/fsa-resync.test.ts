/**
 * 目录绑定与重读（File System Access API）：
 * 句柄递归扫描与 webkitdirectory 语义对齐 / 权限请求 / 打开项目重读增量合并
 * （幂等无操作 / 内容变化 / 新增 / 移除护栏 / 零重叠告警）/ 备份不含句柄。
 */
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  ensureReadPermission,
  filesFromDirectoryHandle,
  type CourseDirHandle,
} from '../src/core/import/fsa'
import {
  compileAndStoreDraft,
  computeLessonStatus,
  createProject,
  ensureLessons,
  exportProjectJson,
  importFiles,
  importProjectJson,
  listLessons,
  resyncProjectFromDir,
  setProjectDirHandle,
} from '../src/core/persist/project'
import { getDb, resetDbForTest } from '../src/core/persist/db'
import type { ImportedFile } from '../src/core/types'

function fakeFile(name: string, text: string, opts?: { fail?: boolean }): FileSystemFileHandle {
  const bytes = new TextEncoder().encode(text)
  return {
    kind: 'file',
    name,
    getFile: async () => {
      if (opts?.fail) throw new Error('NotFoundError')
      return new File([bytes], name)
    },
  } as unknown as FileSystemFileHandle
}

function fakeDir(name: string, children: unknown[]): CourseDirHandle {
  return {
    kind: 'directory',
    name,
    async *values() {
      for (const c of children) yield c as FileSystemHandle
    },
  } as unknown as CourseDirHandle
}

function mdFile(path: string, text: string): ImportedFile {
  const bytes = new TextEncoder().encode(text)
  return {
    normPath: path,
    fileName: path.split('/').pop()!,
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
  })
})

describe('filesFromDirectoryHandle', () => {
  it('递归扫描：根目录名入路径（与 webkitRelativePath 一致），md/图片/其他分拣', async () => {
    const root = fakeDir('数学课程', [
      fakeDir('第1章', [fakeFile('函数.md', '# 函数')]),
      fakeDir('assets', [fakeFile('图.png', 'x')]),
      fakeFile('说明.txt', 'x'),
    ])
    const { files, otherFiles, diagnostics } = await filesFromDirectoryHandle(root)
    expect(files.map((f) => f.normPath).sort()).toEqual([
      '数学课程/assets/图.png',
      '数学课程/第1章/函数.md',
    ])
    expect(files.every((f) => f.source.type === 'browser-file')).toBe(true)
    expect(otherFiles).toEqual([{ path: '数学课程/说明.txt', size: 1 }])
    expect(diagnostics).toHaveLength(0)
  })

  it('单个文件读取失败不阻断：记 DIR_READ_FAILED 诊断，其余照常', async () => {
    const root = fakeDir('课程', [fakeFile('a.md', 'A', { fail: true }), fakeFile('b.md', 'B')])
    const { files, diagnostics } = await filesFromDirectoryHandle(root)
    expect(files.map((f) => f.normPath)).toEqual(['课程/b.md'])
    expect(
      diagnostics.some((d) => d.code === 'DIR_READ_FAILED' && d.message.includes('a.md')),
    ).toBe(true)
  })
})

describe('ensureReadPermission', () => {
  it('已授予（queryPermission=granted）→ true 且不再请求', async () => {
    let requested = false
    const handle = {
      kind: 'directory',
      name: 'x',
      queryPermission: async () => 'granted',
      requestPermission: async () => {
        requested = true
        return 'granted'
      },
    } as unknown as CourseDirHandle
    expect(await ensureReadPermission(handle)).toBe(true)
    expect(requested).toBe(false)
  })

  it('待询问 → 借用户手势请求；拒绝 → false', async () => {
    const granted = {
      kind: 'directory',
      name: 'x',
      queryPermission: async () => 'prompt',
      requestPermission: async () => 'granted',
    } as unknown as CourseDirHandle
    const denied = {
      kind: 'directory',
      name: 'x',
      queryPermission: async () => 'prompt',
      requestPermission: async () => 'denied',
    } as unknown as CourseDirHandle
    expect(await ensureReadPermission(granted)).toBe(true)
    expect(await ensureReadPermission(denied)).toBe(false)
  })

  it('环境无权限 API → 直接放行（乐观尝试）', async () => {
    const handle = fakeDir('x', [])
    expect(await ensureReadPermission(handle)).toBe(true)
  })
})

describe('resyncProjectFromDir', () => {
  async function seedProject(files: ImportedFile[]) {
    const p = await createProject('测试课程')
    await importFiles(p.id, files, 'dir')
    await ensureLessons(p.id)
    return p
  }

  it('内容无变化 → 全部 unchanged，不移除', async () => {
    const p = await seedProject([mdFile('课程/a.md', 'A'), mdFile('课程/b.md', 'B')])
    const r = await resyncProjectFromDir(
      p.id,
      fakeDir('课程', [fakeFile('a.md', 'A'), fakeFile('b.md', 'B')]),
    )
    expect(r.outcome.added).toHaveLength(0)
    expect(r.outcome.changed).toHaveLength(0)
    expect(r.outcome.unchanged.sort()).toEqual(['课程/a.md', '课程/b.md'])
    expect(r.removed).toHaveLength(0)
    expect(r.noOverlap).toBe(false)
  })

  it('内容变化 → 新修订版 + 已编译课时标记「需重新编译」', async () => {
    const p = await seedProject([mdFile('课程/a.md', 'A')])
    const [lesson] = await listLessons(p.id)
    await compileAndStoreDraft(lesson!.id)
    const r = await resyncProjectFromDir(p.id, fakeDir('课程', [fakeFile('a.md', 'A2')]))
    expect(r.outcome.changed).toEqual(['课程/a.md'])
    const st = await computeLessonStatus(lesson!.id)
    expect(st.uiState).toBe('需重新编译')
    expect(st.staleSource).toBe(true)
  })

  it('新增文件 → added + ensureLessons 纳入新课', async () => {
    const p = await seedProject([mdFile('课程/a.md', 'A')])
    const r = await resyncProjectFromDir(
      p.id,
      fakeDir('课程', [fakeFile('a.md', 'A'), fakeFile('new/b.md', 'B')]),
    )
    expect(r.outcome.added).toEqual(['课程/new/b.md'])
    const lessons = await ensureLessons(p.id)
    expect(lessons.map((l) => l.normPath).sort()).toEqual(['课程/a.md', '课程/new/b.md'])
  })

  it('源文件删除（少数）→ 路径与课时移除，修订版历史保留', async () => {
    const p = await seedProject([
      mdFile('课程/a.md', 'A'),
      mdFile('课程/b.md', 'B'),
      mdFile('课程/c.md', 'C'),
    ])
    const r = await resyncProjectFromDir(
      p.id,
      fakeDir('课程', [fakeFile('a.md', 'A'), fakeFile('b.md', 'B')]),
    )
    expect(r.removed).toEqual(['课程/c.md'])
    const lessons = await listLessons(p.id)
    expect(lessons.map((l) => l.normPath).sort()).toEqual(['课程/a.md', '课程/b.md'])
    expect(await getDb().pathIndex.get(`${p.id}:课程/c.md`)).toBeUndefined()
    // U2：修订版字节永不删除
    const revs = await getDb().revisions.where('normPath').equals('课程/c.md').toArray()
    expect(revs.length).toBeGreaterThan(0)
  })

  it('移除护栏：消失路径过半 → 跳过移除，仅记诊断', async () => {
    const p = await seedProject([
      mdFile('课程/a.md', 'A'),
      mdFile('课程/b.md', 'B'),
      mdFile('课程/c.md', 'C'),
    ])
    const r = await resyncProjectFromDir(p.id, fakeDir('课程', [fakeFile('a.md', 'A')]))
    expect(r.removed).toHaveLength(0)
    const lessons = await listLessons(p.id)
    expect(lessons).toHaveLength(3)
    const diags = await getDb().diagnostics.where('projectId').equals(p.id).toArray()
    expect(diags.some((d) => d.code === 'DIR_RESYNC_REMOVAL_SKIPPED')).toBe(true)
  })

  it('零重叠（疑似绑错目录）→ noOverlap 告警且不误删既有课时', async () => {
    const p = await seedProject([mdFile('课程/a.md', 'A')])
    const r = await resyncProjectFromDir(p.id, fakeDir('其他目录', [fakeFile('x.md', 'X')]))
    expect(r.noOverlap).toBe(true)
    expect(r.outcome.added).toEqual(['其他目录/x.md'])
    // App 流程：重读后由 refreshLessons → ensureLessons 重建课时表
    const lessons = await ensureLessons(p.id)
    // 默认 sort()（UTF-16 码元序）：「其」U+5176 < 「课」U+8BFE
    expect(lessons.map((l) => l.normPath).sort()).toEqual(['其他目录/x.md', '课程/a.md'])
    const diags = await getDb().diagnostics.where('projectId').equals(p.id).toArray()
    expect(diags.some((d) => d.code === 'DIR_RESYNC_NO_OVERLAP')).toBe(true)
  })

  it('句柄持久化到项目记录；JSON 备份不含句柄且恢复后可正常导入', async () => {
    const p = await seedProject([mdFile('课程/a.md', 'A')])
    // 真实 FSA 句柄可结构化克隆；fake-indexeddb 无法克隆函数成员，这里用可克隆的最小替身
    const handle = { kind: 'directory', name: '课程' } as unknown as CourseDirHandle
    await setProjectDirHandle(p.id, handle)
    const stored = await getDb().projects.get(p.id)
    expect(stored?.dirHandle).toBeDefined()

    const json = await exportProjectJson(p.id)
    expect(json).not.toContain('dirHandle')
    const newId = await importProjectJson(json)
    const restored = await getDb().projects.get(newId)
    expect(restored).toBeDefined()
    expect(restored?.dirHandle ?? null).toBeFalsy() // 恢复的项目需重新绑定
  })
})
