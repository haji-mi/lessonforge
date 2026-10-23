/**
 * ZIP 条目名称解码四类别判定（架构基线 §4.1）。
 *
 * 1. flagged-utf8   标志置位 + 严格 UTF-8 通过（可靠）
 * 2. flagged-invalid 标志置位但严格 UTF-8 失败 → 占位 + 候选 + 人工裁决，不进入聚合
 * 3. extra-unicode   0x7075 扩展字段 CRC 通过 → 直接采用
 * 4. no-flag         聚合判定 + 双候选 + 确认制（小样本强制裁决）
 *
 * 承诺：不静默错误——凡无显式信号支撑的判定必然可见、可改、留痕。
 * 合理性得分只用于排序提示，不做最终裁决。
 */
import type { ImportDiagnostic } from '../../types'
import { latin1, strictGbk, strictUtf8 } from '../../codec/utf8'
import type { ZipEntryMeta } from './scanner'

export type NameCategory =
  'flagged-utf8' | 'flagged-invalid' | 'extra-unicode' | 'ascii' | 'no-flag'

export interface NameOutcome {
  index: number
  category: NameCategory
  /** 默认显示名（组模式结果或可靠解码；flagged-invalid 为占位符） */
  display: string
  /** 双解码均合法且不同时的候选（含默认在前） */
  candidates: { text: string; basis: string }[]
  /** 判定依据（人类可读证据） */
  basis: string
  /** 需要用户在确认页裁决 */
  needsChoice: boolean
  rawByteLength: number
}

export interface NameDecisionSet {
  outcomes: NameOutcome[]
  groupMode: 'utf-8' | 'gbk' | 'none'
  groupBasis: string
  nonAsciiNoFlagCount: number
  anyNeedsChoice: boolean
  diagnostics: ImportDiagnostic[]
}

/** 合理性得分（仅排序提示）：常用 CJK 区 + 常规文件名字符占比 */
export function plausibility(s: string): number {
  if (!s) return 0
  let good = 0
  for (const ch of s) {
    const c = ch.codePointAt(0)!
    if (
      (c >= 0x4e00 && c <= 0x9fff) || // CJK 常用区
      (c >= 0x30 && c <= 0x39) ||
      (c >= 0x41 && c <= 0x5a) ||
      (c >= 0x61 && c <= 0x7a) ||
      '._-()/ ·（）－'.includes(ch)
    ) {
      good++
    }
  }
  return good / [...s].length
}

function isAsciiOnly(bytes: Uint8Array): boolean {
  for (const b of bytes) if (b >= 0x80) return false
  return true
}

export function decideNames(
  entries: ZipEntryMeta[],
  forcedMode?: 'utf-8' | 'gbk',
): NameDecisionSet {
  const outcomes: NameOutcome[] = []
  const diagnostics: ImportDiagnostic[] = []
  const noFlagIdx: number[] = []

  for (const e of entries) {
    const len = e.nameBytes.length
    if (e.flagUtf8) {
      const s = strictUtf8(e.nameBytes)
      if (s !== null) {
        outcomes.push({
          index: e.index,
          category: 'flagged-utf8',
          display: s,
          candidates: [],
          basis: 'UTF-8 标志 + 严格解码通过',
          needsChoice: false,
          rawByteLength: len,
        })
      } else {
        const candidates: { text: string; basis: string }[] = []
        const g = strictGbk(e.nameBytes)
        if (g !== null) candidates.push({ text: g, basis: '候选·GBK（仅为候选显示）' })
        candidates.push({ text: latin1(e.nameBytes), basis: '候选·Latin1（仅为候选显示）' })
        diagnostics.push({
          code: 'ZIP_NAME_UTF8_FLAG_INVALID',
          severity: 'error',
          message: `条目声明 UTF-8 但名称 ${len} 字节无法严格解码（名称损坏）`,
        })
        outcomes.push({
          index: e.index,
          category: 'flagged-invalid',
          display: `⟨名称损坏·${len}字节⟩`,
          candidates,
          basis: 'UTF-8 标志置位但严格解码失败 → 保留原始字节，等待用户裁决',
          needsChoice: true,
          rawByteLength: len,
        })
      }
      continue
    }
    if (e.unicodePath?.crcOk) {
      outcomes.push({
        index: e.index,
        category: 'extra-unicode',
        display: e.unicodePath.name,
        candidates: [],
        basis: 'Unicode Path 扩展字段（CRC32 校验通过）',
        needsChoice: false,
        rawByteLength: len,
      })
      continue
    }
    if (e.unicodePath && !e.unicodePath.crcOk) {
      diagnostics.push({
        code: 'ZIP_NAME_EXTRA_CRC_MISMATCH',
        severity: 'warn',
        message: 'Unicode Path 扩展字段 CRC 不符，已忽略该字段，按无标志处理',
      })
    }
    if (isAsciiOnly(e.nameBytes)) {
      outcomes.push({
        index: e.index,
        category: 'ascii',
        display: latin1(e.nameBytes),
        candidates: [],
        basis: '纯 ASCII，无编码歧义',
        needsChoice: false,
        rawByteLength: len,
      })
      continue
    }
    noFlagIdx.push(e.index)
    outcomes.push({
      index: e.index,
      category: 'no-flag',
      display: '',
      candidates: [],
      basis: '',
      needsChoice: false,
      rawByteLength: len,
    })
  }

  // 无标志非 ASCII 组：聚合判定
  let groupMode: 'utf-8' | 'gbk' | 'none' = 'none'
  let groupBasis = '无非 ASCII 无标志条目'
  let utf8FailCount = 0
  if (noFlagIdx.length > 0) {
    if (forcedMode) {
      groupMode = forcedMode
      groupBasis = `用户指定模式：${forcedMode === 'gbk' ? 'GBK' : 'UTF-8'}`
    } else {
      for (const idx of noFlagIdx) {
        if (strictUtf8(entries[idx].nameBytes) === null) utf8FailCount++
      }
      if (utf8FailCount > 0) {
        groupMode = 'gbk'
        groupBasis = `组内 ${utf8FailCount}/${noFlagIdx.length} 条未通过严格 UTF-8 → 组默认 GBK`
      } else {
        groupMode = 'utf-8'
        groupBasis = `非 ASCII 无标志名称 ${noFlagIdx.length} 条全部通过严格 UTF-8 → 组默认 UTF-8`
      }
    }
  }

  const smallSample = noFlagIdx.length <= 2 && noFlagIdx.length > 0
  for (const idx of noFlagIdx) {
    const e = entries[idx]
    const out = outcomes[idx]!
    if (groupMode === 'utf-8') {
      const primary = strictUtf8(e.nameBytes)!
      const gbkAlt = strictGbk(e.nameBytes)
      const candidates: { text: string; basis: string }[] = []
      if (gbkAlt !== null && gbkAlt !== primary) {
        candidates.push(
          { text: primary, basis: '组默认·UTF-8' },
          { text: gbkAlt, basis: '候选·GBK' },
        )
      }
      let basis = groupBasis
      if (smallSample) basis += '；非 ASCII 条目 ≤2，证据不足，需人工裁决'
      if (
        candidates.length > 0 &&
        plausibility(candidates[1]!.text) > plausibility(primary) + 0.15
      ) {
        basis += '；评分提示：GBK 候选可能更合理（仅供参考）'
      }
      out.display = primary
      out.candidates = candidates
      out.basis = basis
      out.needsChoice = smallSample && candidates.length > 0
    } else {
      // gbk
      const g = strictGbk(e.nameBytes)
      if (g !== null) {
        // 混合档案防护：双解码均合法且不同 → 一律展示双候选（默认仍为组模式结果）
        const u = strictUtf8(e.nameBytes)
        const candidates =
          u !== null && u !== g
            ? [
                { text: g, basis: '组默认·GBK' },
                { text: u, basis: '候选·UTF-8' },
              ]
            : [{ text: g, basis: '组默认·GBK' }]
        let basis = groupBasis
        if (candidates.length > 1 && plausibility(u!) > plausibility(g) + 0.15) {
          basis += '；评分提示：UTF-8 候选可能更合理（疑似混合来源，仅供参考）'
        }
        out.display = g
        out.candidates = candidates
        out.basis = basis
        out.needsChoice = smallSample && candidates.length > 1
      } else {
        const u = strictUtf8(e.nameBytes)
        if (u !== null) {
          out.display = u
          out.candidates = [
            { text: u, basis: '疑似混合来源·UTF-8' },
            { text: latin1(e.nameBytes), basis: '候选·Latin1' },
          ]
          out.basis = '组默认 GBK 失败但严格 UTF-8 通过 → 疑似混合来源，需人工裁决'
          out.needsChoice = true
          diagnostics.push({
            code: 'ZIP_NAME_MIXED_ARCHIVE',
            severity: 'warn',
            message: '疑似混合编码档案：该条目与组模式矛盾',
          })
        } else {
          out.display = latin1(e.nameBytes)
          out.candidates = [{ text: latin1(e.nameBytes), basis: 'Latin1 兜底（无法解码）' }]
          out.basis = 'UTF-8 与 GBK 严格解码均失败 → Latin1 兜底 + 诊断'
          out.needsChoice = true
          diagnostics.push({
            code: 'ZIP_NAME_UNDECODABLE',
            severity: 'error',
            message: `条目名 ${e.nameBytes.length} 字节无法以 UTF-8/GBK 严格解码`,
          })
        }
      }
    }
  }

  return {
    outcomes,
    groupMode,
    groupBasis,
    nonAsciiNoFlagCount: noFlagIdx.length,
    anyNeedsChoice: outcomes.some((o) => o.needsChoice),
    diagnostics,
  }
}
