/**
 * 目录导入（webkitdirectory / 拖拽）：浏览器直接给出 UTF-8 名称，无编码歧义。
 * 字节懒加载（保留 File 句柄），仅 md/图片入库，其他类型记录清单。
 */
import type { ImportDiagnostic, ImportedFile } from '../types'
import { fileKindOf } from '../types'
import { normalizeRelPath } from './paths'

export function filesFromDirectoryPicker(files: File[]): {
  files: ImportedFile[]
  otherFiles: { path: string; size: number }[]
  diagnostics: ImportDiagnostic[]
} {
  const out: ImportedFile[] = []
  const otherFiles: { path: string; size: number }[] = []
  const diagnostics: ImportDiagnostic[] = []
  const seen = new Set<string>()
  for (const f of files) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name
    const norm = normalizeRelPath(rel)
    if (!norm) continue
    if (seen.has(norm)) {
      diagnostics.push({
        code: 'DIR_NAME_COLLISION',
        severity: 'warn',
        message: `路径重复（不同目录同名文件在规范化后冲突）：${norm}`,
      })
      continue
    }
    seen.add(norm)
    const fileName = norm.split('/').pop()!
    const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : ''
    const kind = fileKindOf(ext)
    if (kind === 'other') {
      otherFiles.push({ path: norm, size: f.size })
      continue
    }
    out.push({
      normPath: norm,
      fileName,
      ext,
      byteSize: f.size,
      kind,
      source: { type: 'browser-file', file: f },
    })
  }
  return { files: out, otherFiles, diagnostics }
}
