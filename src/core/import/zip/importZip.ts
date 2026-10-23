/**
 * ZIP 导入编排：扫描 → 名称判定（确认制两阶段）→ 守卫式解压 → ImportedFile。
 * 第一阶段（scanZip）供确认页展示解码报告；第二阶段（importZipEntries）在用户确认后执行。
 */
import type { ImportDiagnostic, ImportedFile } from '../../types'
import { fileKindOf } from '../../types'
import { safeEntryPath } from '../paths'
import { decideNames, type NameDecisionSet } from './names'
import {
  DEFAULT_ZIP_LIMITS,
  inflateEntryFromBlob,
  readStoredEntry,
  type InflateStats,
  type ZipLimits,
} from './inflate'
import { locateEntryData, scanZipBlob, type ZipEntryMeta, type ZipScan } from './scanner'

export interface ZipScanResult extends ZipScan {
  names: NameDecisionSet
}

export async function scanZip(blob: Blob, forcedMode?: 'utf-8' | 'gbk'): Promise<ZipScanResult> {
  const scan = await scanZipBlob(blob)
  const names = decideNames(scan.entries, forcedMode)
  return { ...scan, names }
}

export interface ZipImportOptions {
  /** 用户在确认页选择的显示名（entryIndex → 显示名） */
  nameChoices?: Map<number, string>
  limits?: Partial<ZipLimits>
}

export interface ZipImportResult {
  files: ImportedFile[]
  /** 非 md/图片的文件清单（记录但不解析） */
  otherFiles: { path: string; size: number }[]
  diagnostics: ImportDiagnostic[]
  totalActualOutput: number
  abortedEntries: string[]
  maxChunkSeen: number
  /** 整档预算耗尽导致剩余条目未处理 */
  truncatedByTotalBudget: boolean
}

export async function importZipEntries(
  blob: Blob,
  scan: ZipScanResult,
  opts: ZipImportOptions = {},
): Promise<ZipImportResult> {
  const limits: ZipLimits = { ...DEFAULT_ZIP_LIMITS, ...opts.limits }
  const budget = { total: 0 }
  const files: ImportedFile[] = []
  const otherFiles: { path: string; size: number }[] = []
  const diagnostics: ImportDiagnostic[] = [...scan.names.diagnostics]
  const abortedEntries: string[] = []
  const seenPaths = new Set<string>()
  let maxChunkSeen = 0
  let truncated = false

  for (const entry of scan.entries) {
    const outcome = scan.names.outcomes[entry.index]!
    if (entry.isDirectory) continue
    if (entry.flagEncrypted) {
      diagnostics.push({
        code: 'ZIP_ENCRYPTED',
        severity: 'warn',
        message: '加密条目不支持，已跳过',
      })
      continue
    }
    if (entry.method !== 0 && entry.method !== 8) {
      diagnostics.push({
        code: 'ZIP_METHOD_UNSUPPORTED',
        severity: 'warn',
        message: `不支持的压缩方法 ${entry.method}，已跳过`,
      })
      continue
    }

    const displayName = opts.nameChoices?.get(entry.index) ?? outcome.display
    const safe = safeEntryPath(displayName)
    if (!safe.ok) {
      diagnostics.push({
        code: 'ZIP_PATH_UNSAFE',
        severity: 'error',
        message: `条目路径不安全（${safe.reason}），已拒绝`,
        detail: `原始显示名：${displayName}`,
      })
      continue
    }
    let path = safe.path
    if (seenPaths.has(path)) {
      let n = 2
      const dot = path.lastIndexOf('.')
      const stem = dot > 0 ? path.slice(0, dot) : path
      const ext = dot > 0 ? path.slice(dot) : ''
      while (seenPaths.has(`${stem} (${n})${ext}`)) n++
      path = `${stem} (${n})${ext}`
      diagnostics.push({
        code: 'ZIP_NAME_COLLISION',
        severity: 'warn',
        message: `规范化后路径重复，已重命名为 ${path}`,
      })
    }
    seenPaths.add(path)

    // 快速失败：声明值超预算（真正的保证来自流式实际计数）
    if (entry.uncompSize > limits.entryBudget) {
      diagnostics.push({
        code: 'ZIP_BUDGET_EXCEEDED',
        severity: 'error',
        message: `条目声明未压缩尺寸 ${entry.uncompSize} 超过单条目预算 ${limits.entryBudget}`,
        path,
      })
      abortedEntries.push(path)
      continue
    }
    if (budget.total >= limits.totalBudget) {
      truncated = true
      diagnostics.push({
        code: 'ZIP_TOTAL_BUDGET_EXCEEDED',
        severity: 'error',
        message: '整档累计输出预算耗尽，剩余条目未处理',
      })
      break
    }

    const located = await locateEntryData(blob, entry)
    if ('error' in located) {
      diagnostics.push({
        code: located.error,
        severity: 'error',
        message: '本地头损坏，条目无法定位数据区',
        path,
      })
      continue
    }

    // 声明压缩长度越界（快失败；实际保证仍在解压层）
    if (located.dataStart + entry.compSize > blob.size) {
      diagnostics.push({
        code: 'ZIP_CORRUPT_RANGE',
        severity: 'error',
        message: '声明的压缩数据范围越界',
        path,
      })
      continue
    }

    const expected = { crc32: entry.crc32, uncompSize: entry.uncompSize }
    const result =
      entry.method === 0
        ? await readStoredEntry(blob, located.dataStart, entry.compSize, expected, limits, budget)
        : await inflateEntryFromBlob(
            blob,
            located.dataStart,
            entry.compSize,
            expected,
            limits,
            budget,
          )
    maxChunkSeen = Math.max(maxChunkSeen, result.stats.maxChunkSeen)

    if (!result.ok) {
      const msg: Record<string, string> = {
        BUDGET_EXCEEDED: '实际输出超过预算，条目被拒收',
        CRC_MISMATCH: 'CRC-32 校验不符',
        SIZE_MISMATCH: '实际尺寸与声明不符',
        TRUNCATED_OR_CORRUPT: '压缩数据截断或损坏',
      }
      diagnostics.push({
        code: `ZIP_${result.code}`,
        severity: 'error',
        message: msg[result.code!] ?? result.code!,
        path,
      })
      if (result.code === 'BUDGET_EXCEEDED') {
        abortedEntries.push(path)
        if (result.budgetScope === 'total') {
          // 整档累计预算超限：终止后续条目（基线 §4.2）
          truncated = true
          diagnostics.push({
            code: 'ZIP_TOTAL_BUDGET_EXCEEDED',
            severity: 'error',
            message: '整档累计输出预算耗尽，剩余条目未处理',
          })
          break
        }
      }
      continue
    }

    const fileName = path.split('/').pop()!
    const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : ''
    const kind = fileKindOf(ext)
    if (kind === 'other') {
      otherFiles.push({ path, size: result.data!.length })
      continue
    }
    files.push({
      normPath: path,
      fileName,
      ext,
      byteSize: result.data!.length,
      kind,
      source: { type: 'bytes', bytes: result.data! },
    })
  }

  return {
    files,
    otherFiles,
    diagnostics,
    totalActualOutput: budget.total,
    abortedEntries,
    maxChunkSeen,
    truncatedByTotalBudget: truncated,
  }
}

export type { ZipEntryMeta, InflateStats, ZipLimits, NameDecisionSet }
