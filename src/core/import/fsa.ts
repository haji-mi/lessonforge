/**
 * File System Access API（Chromium）目录绑定：把目录句柄持久化到项目记录，
 * 打开项目时重读目录实现增量更新（新增/内容变化/移除）。
 * lib.dom 未收录权限查询与目录异步遍历方法，此处补最小类型面；不支持的环境
 * （Firefox/Safari）回退 webkitdirectory 导入路径。
 */
import type { ImportDiagnostic, ImportedFile } from '../types'
import { fileKindOf } from '../types'
import { normalizeRelPath } from './paths'

/** Chromium 运行时存在但 lib.dom 未声明的方法（权限 + 异步遍历） */
interface DirHandleExt {
  values(): AsyncIterableIterator<FileSystemHandle>
  queryPermission?(desc: { mode: 'read' | 'readwrite' }): Promise<PermissionState>
  requestPermission?(desc: { mode: 'read' | 'readwrite' }): Promise<PermissionState>
}

export type CourseDirHandle = FileSystemDirectoryHandle & DirHandleExt

export function supportsDirectoryPicker(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function'
  )
}

/** 打开目录选择器；用户取消或环境不支持 → null */
export async function pickCourseDirectory(): Promise<CourseDirHandle | null> {
  const picker = (
    window as unknown as {
      showDirectoryPicker?: (opts?: { mode?: 'read' }) => Promise<CourseDirHandle>
    }
  ).showDirectoryPicker
  if (!picker) return null
  try {
    return await picker({ mode: 'read' })
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return null // 用户取消
    throw e
  }
}

/** 读权限：已授予 → true；待询问 → 借当前用户手势请求；拒绝/环境无权限 API 失败 → false */
export async function ensureReadPermission(handle: CourseDirHandle): Promise<boolean> {
  if (!handle.queryPermission && !handle.requestPermission) return true // 无权限 API 的环境：直接尝试读取
  try {
    if (handle.queryPermission && (await handle.queryPermission({ mode: 'read' })) === 'granted')
      return true
    if (
      handle.requestPermission &&
      (await handle.requestPermission({ mode: 'read' })) === 'granted'
    )
      return true
  } catch {
    return false
  }
  return false
}

/**
 * 递归遍历目录句柄 → ImportedFile[]。与 filesFromDirectoryPicker 语义对齐：
 * 根目录名作为首段路径（与 webkitRelativePath 一致，保证同目录两种导入方式路径相同），
 * 仅收 md/图片，其余记清单；单个文件读取失败不阻断（记诊断）。
 */
export async function filesFromDirectoryHandle(root: CourseDirHandle): Promise<{
  files: ImportedFile[]
  otherFiles: { path: string; size: number }[]
  diagnostics: ImportDiagnostic[]
}> {
  const files: ImportedFile[] = []
  const otherFiles: { path: string; size: number }[] = []
  const diagnostics: ImportDiagnostic[] = []
  const seen = new Set<string>()

  async function walk(dir: CourseDirHandle, prefix: string): Promise<void> {
    for await (const entry of dir.values()) {
      const rel = normalizeRelPath(`${prefix}/${entry.name}`)
      if (!rel) continue
      if (entry.kind === 'directory') {
        await walk(entry as CourseDirHandle, rel)
        continue
      }
      if (seen.has(rel)) {
        diagnostics.push({
          code: 'DIR_NAME_COLLISION',
          severity: 'warn',
          message: `路径重复（不同目录同名文件在规范化后冲突）：${rel}`,
        })
        continue
      }
      seen.add(rel)
      let file: File
      try {
        file = await (entry as FileSystemFileHandle).getFile()
      } catch {
        diagnostics.push({
          code: 'DIR_READ_FAILED',
          severity: 'warn',
          message: `文件读取失败（可能已被删除或移动）：${rel}`,
        })
        continue
      }
      const fileName = rel.split('/').pop()!
      const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : ''
      const kind = fileKindOf(ext)
      if (kind === 'other') {
        otherFiles.push({ path: rel, size: file.size })
        continue
      }
      files.push({
        normPath: rel,
        fileName,
        ext,
        byteSize: file.size,
        kind,
        source: { type: 'browser-file', file },
      })
    }
  }

  await walk(root, root.name)
  return { files, otherFiles, diagnostics }
}
