/** T 空间（解码文本）字符偏移区间 [start, end) */
export interface Span {
  start: number
  end: number
}

export type FileKind = 'md' | 'image' | 'other'

export function fileKindOf(ext: string): FileKind {
  if (ext === 'md' || ext === 'markdown') return 'md'
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'avif'].includes(ext)) return 'image'
  return 'other'
}

/** 导入后的逻辑文件（字节懒加载：目录导入为浏览器 File，ZIP 导入为已解压字节） */
export interface ImportedFile {
  normPath: string
  fileName: string
  ext: string
  byteSize: number
  kind: FileKind
  source: { type: 'browser-file'; file: File } | { type: 'bytes'; bytes: Uint8Array }
}

export async function materializeBytes(f: ImportedFile): Promise<Uint8Array> {
  return f.source.type === 'bytes'
    ? f.source.bytes
    : new Uint8Array(await f.source.file.arrayBuffer())
}

export interface ImportDiagnostic {
  code: string
  severity: 'info' | 'warn' | 'error'
  message: string
  detail?: string
  path?: string
}
