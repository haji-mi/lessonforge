/**
 * 本地持久化（架构基线 §9）：IndexedDB + Dexie。
 * 实体：Project / ImportBatch / SourceFileRevision（不可变）/ PathIndex / Lesson /
 * Draft（active|candidate|superseded，永不删除）/ Overlay（追加式操作日志）/ 诊断。
 * 刷新恢复：全部状态落库，载入即重建；JSON 为备份/迁移格式。
 */
import Dexie, { type Table } from 'dexie'
import { APP_MODEL_VERSION } from '../version'
import type { EolStats } from '../custody/custody'

export interface ProjectRecord {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  modelVersion: number
  settings: Record<string, unknown>
}

export interface ImportBatchRecord {
  id: string
  projectId: string
  at: number
  source: 'dir' | 'zip'
  fileCount: number
  note?: string
}

export interface RevisionRecord {
  id: string // projectId:normPath:hash12
  projectId: string
  normPath: string
  contentHash: string
  bytes: Uint8Array
  byteSize: number
  text: string
  encoding: string
  bom: boolean
  eol: EolStats
  lossy: boolean
  issues: { byteStart: number; byteEnd: number; kind: string }[]
  gbkViewOffered: boolean
  importedAt: number
}

export interface PathIndexRecord {
  key: string // projectId:normPath
  projectId: string
  normPath: string
  kind: 'md' | 'image'
  currentRevisionId: string
  revisionIds: string[]
  updatedAt: number
}

export interface LessonRecord {
  id: string // projectId:normPath
  projectId: string
  normPath: string
  chapter: string
  title: string
  titleSource: 'inferred' | 'manual'
  /** 用户手动覆盖的课型（typeManual 非空时生效） */
  typeManual: string | null
  status: 'structured' | 'compiled' | 'approved' | 'exported'
  coverageAckAt: number | null
  approvedAt: number | null
  exportedAt: number | null
}

export interface DraftRecord {
  id: string
  lessonId: string
  /** active=当前生效；candidate=重编译产生的备选（冲突待决）；superseded=历史（永不删除） */
  state: 'active' | 'candidate' | 'superseded'
  plan: unknown // LessonPlan（避免循环依赖以 unknown 存储）
  contentHash: string
  compilerVersion: number
  createdAt: number
}

export interface OverlayEdit {
  sectionId: string
  op: 'replace' | 'delete' | 'add'
  content: string
  at: number
  /** add 操作的环节角色（人工补入） */
  role?: string
  /** add 操作可携带原文来源（人工补入的 MKU 溯源） */
  traces?: { file: string; start: number; end: number }[]
}

export interface OverlayRecord {
  lessonId: string
  baseDraftId: string
  edits: OverlayEdit[]
  updatedAt: number
}

export interface DiagnosticRecord {
  id?: number
  projectId: string
  scope: 'project' | 'lesson'
  lessonId?: string
  code: string
  severity: 'info' | 'warn' | 'error'
  message: string
  detail?: string
  at: number
}

export class AppDB extends Dexie {
  projects!: Table<ProjectRecord, string>
  batches!: Table<ImportBatchRecord, string>
  revisions!: Table<RevisionRecord, string>
  pathIndex!: Table<PathIndexRecord, string>
  lessons!: Table<LessonRecord, string>
  drafts!: Table<DraftRecord, string>
  overlays!: Table<OverlayRecord, string>
  diagnostics!: Table<DiagnosticRecord, number>

  constructor() {
    super('classroom-compiler')
    this.version(APP_MODEL_VERSION).stores({
      projects: 'id, updatedAt',
      batches: 'id, projectId',
      revisions: 'id, projectId, normPath',
      pathIndex: 'key, projectId, normPath',
      lessons: 'id, projectId, chapter',
      drafts: 'id, lessonId, state',
      overlays: 'lessonId',
      diagnostics: '++id, projectId, lessonId',
    })
  }
}

let dbSingleton: AppDB | null = null

export function getDb(): AppDB {
  if (!dbSingleton) dbSingleton = new AppDB()
  return dbSingleton
}

/** 测试用：重置单例（配合 fake-indexeddb 的 new IDBFactory） */
export function resetDbForTest(): void {
  dbSingleton?.close()
  dbSingleton = null
}
