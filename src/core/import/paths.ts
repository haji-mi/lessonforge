/** 路径规范化与自然排序（中文路径，数字感知，中文数字映射） */
import type { FileKind } from '../types'
import { fileKindOf } from '../types'

/** 规范化为 POSIX 风格相对路径；不去除 ..（安全性单独检查） */
export function normalizeRelPath(p: string): string {
  let s = p.replace(/\\/g, '/')
  s = s.replace(/^\/+/, '')
  s = s.replace(/\/{2,}/g, '/')
  const parts = s.split('/').filter((seg) => seg !== '' && seg !== '.')
  return parts.join('/')
}

export type UnsafePathReason =
  | 'EMPTY'
  | 'NAME_TOO_LONG'
  | 'CONTROL_CHARS'
  | 'ABSOLUTE'
  | 'DRIVE_LETTER'
  | 'UNC'
  | 'TRAVERSAL'
  | 'RESERVED_DEVICE'

/** ZIP 条目路径安全检查（zip-slip 防护）；通过则返回规范化虚拟路径 */
export function safeEntryPath(
  name: string,
): { ok: true; path: string } | { ok: false; reason: UnsafePathReason } {
  if (!name || name.length === 0) return { ok: false, reason: 'EMPTY' }
  if (name.length > 512) return { ok: false, reason: 'NAME_TOO_LONG' }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return { ok: false, reason: 'CONTROL_CHARS' }
  const s = name.replace(/\\/g, '/')
  if (s.startsWith('//')) return { ok: false, reason: 'UNC' }
  if (s.startsWith('/')) return { ok: false, reason: 'ABSOLUTE' }
  if (/^[a-zA-Z]:/.test(s)) return { ok: false, reason: 'DRIVE_LETTER' }
  if (s.startsWith('//')) return { ok: false, reason: 'UNC' }
  const segs = s.split('/')
  if (segs.includes('..')) return { ok: false, reason: 'TRAVERSAL' }
  // Windows 保留设备名（CON/PRN/AUX/NUL/COM1..9/LPT1..9）
  for (const seg of segs) {
    const base = seg.split('.')[0].toUpperCase()
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(base))
      return { ok: false, reason: 'RESERVED_DEVICE' }
  }
  const path = segs.filter((x) => x !== '' && x !== '.').join('/')
  if (!path) return { ok: false, reason: 'EMPTY' }
  return { ok: true, path }
}

const zhCollator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })

const CN_DIGITS: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
}

/** 中文数字（一~千位）转数值；不匹配返回 null */
export function chineseNumeralToNumber(s: string): number | null {
  if (!s) return null
  let total = 0
  let current = 0
  for (const ch of s) {
    if (ch === '十') {
      total += (current || 1) * 10
      current = 0
    } else if (ch === '百') {
      total += (current || 1) * 100
      current = 0
    } else if (ch === '千') {
      total += (current || 1) * 1000
      current = 0
    } else {
      const d = CN_DIGITS[ch]
      if (d === undefined) return null
      current = d
    }
  }
  return total + current
}

/** 排序键提示：第X章 的中文/阿拉伯数字统一为零填充（可选项） */
export function sortKeyHint(name: string, cnNumerals: boolean): string {
  if (!cnNumerals) return name
  return name.replace(
    /第([0-9零一两二三四五六七八九十百千]+)([章节讲课时卷部篇])/,
    (_m, num: string, unit: string) => {
      const n = /^[0-9]+$/.test(num) ? parseInt(num, 10) : chineseNumeralToNumber(num)
      return n === null || Number.isNaN(n) ? _m : `第${String(n).padStart(4, '0')}${unit}`
    },
  )
}

export interface SortableEntry {
  name: string
  kind: string
}

/** 文件树条目比较：自然排序（数字感知 + 中文拼音），可选中文数字映射 */
export function compareEntries(a: SortableEntry, b: SortableEntry, cnNumerals = true): number {
  const ka = sortKeyHint(a.name, cnNumerals)
  const kb = sortKeyHint(b.name, cnNumerals)
  return zhCollator.compare(ka, kb)
}

export interface FileTreeNode {
  name: string
  path: string
  kind: 'dir' | 'file'
  fileKind?: FileKind
  children: FileTreeNode[]
  size?: number
}

/** 构建排序后的文件树（目录与文件混排，同资源管理器/Obsidian 习惯） */
export function buildFileTree(files: { normPath: string; byteSize: number }[]): FileTreeNode {
  const root: FileTreeNode = { name: '', path: '', kind: 'dir', children: [] }
  const dirIndex = new Map<string, FileTreeNode>([['', root]])
  for (const f of files) {
    const segs = f.normPath.split('/')
    let cur = root
    let acc = ''
    for (let i = 0; i < segs.length - 1; i++) {
      acc = acc ? `${acc}/${segs[i]}` : segs[i]
      let node = dirIndex.get(acc)
      if (!node) {
        node = { name: segs[i], path: acc, kind: 'dir', children: [] }
        dirIndex.set(acc, node)
        cur.children.push(node)
      }
      cur = node
    }
    const fileName = segs[segs.length - 1]
    const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : ''
    cur.children.push({
      name: fileName,
      path: f.normPath,
      kind: 'file',
      fileKind: fileKindOf(ext),
      children: [],
      size: f.byteSize,
    })
  }
  const sortRec = (node: FileTreeNode) => {
    node.children.sort((a, b) => compareEntries(a, b))
    node.children.forEach(sortRec)
  }
  sortRec(root)
  return root
}
