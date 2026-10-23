/**
 * 笔记嵌入四规则（架构基线 §6）：
 * 1) 路径解析三步短路：相对当前文件目录 → 相对导入根 → 全局唯一 basename；③ 不唯一 → 候选+占位
 * 2) 重复嵌入：每处引用独立展开（不去重），溯源指向被嵌入文件
 * 3) 循环引用：展开链 visited 集合，命中截断 + 诊断；全局深度上限 5
 * 4) 缺失目标：占位 + 诊断（含原始引用文本），绝不生成内容
 */
import type { ParsedDoc } from '../parse/parse'
import type { Span } from '../types'

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'avif'])
export const EMBED_MAX_DEPTH = 5

export interface WikiTargetResolution {
  target: string | null
  candidates: string[]
  basis: string
}

function withMdExt(target: string): string {
  if (/\.\w+$/.test(target)) return target
  return `${target}.md`
}

/** 三步确定性路径解析 */
export function resolveWikiTarget(
  target: string,
  currentPath: string,
  allPaths: Set<string>,
): WikiTargetResolution {
  if (!target) return { target: null, candidates: [], basis: '空目标' }
  // ① 相对当前文件目录
  const dir = currentPath.includes('/') ? currentPath.slice(0, currentPath.lastIndexOf('/')) : ''
  const rel = dir ? `${dir}/${target}` : target
  for (const cand of [rel, withMdExt(rel)]) {
    if (allPaths.has(cand))
      return { target: cand, candidates: [cand], basis: `相对当前文件目录：${cand}` }
  }
  // ② 相对导入根
  for (const cand of [target, withMdExt(target)]) {
    if (allPaths.has(cand))
      return { target: cand, candidates: [cand], basis: `相对导入根：${cand}` }
  }
  // ③ 全局唯一 basename（Obsidian 最短唯一名引用）
  const wanted = target.replace(/\.md$/, '')
  const matches = [...allPaths].filter((p) => {
    const base = p.split('/').pop()!.replace(/\.md$/, '')
    return base === wanted
  })
  if (matches.length === 1) {
    return { target: matches[0]!, candidates: matches, basis: `全局唯一 basename：${matches[0]}` }
  }
  if (matches.length > 1) {
    return {
      target: null,
      candidates: matches,
      basis: `basename 匹配 ${matches.length} 个候选，无法唯一定位`,
    }
  }
  return { target: null, candidates: [], basis: `未找到目标：${target}` }
}

export interface EmbedExpansion {
  /** 嵌入引用在源文件中的 span */
  span: Span
  sourcePath: string
  raw: string
  targetPath: string | null
  status: 'ok' | 'missing' | 'ambiguous' | 'cycle' | 'depth-limit'
  candidates: string[]
  basis: string
  depth: number
}

export interface EmbedDiagnostic {
  code: string
  severity: 'info' | 'warn' | 'error'
  message: string
  path: string
  detail?: string
}

/**
 * 展开一个文件的全部嵌入（递归，含循环检测与深度上限）。
 * 每处引用独立展开（不去重）；溯源指向被嵌入文件（跨文件 trace）。
 */
export function expandEmbeds(
  docs: Map<string, ParsedDoc>,
  startPath: string,
  onDiagnostic?: (d: EmbedDiagnostic) => void,
): EmbedExpansion[] {
  const out: EmbedExpansion[] = []

  function walk(path: string, chain: string[], depth: number) {
    const doc = docs.get(path)
    if (!doc) return
    for (const link of doc.wikilinks) {
      if (!link.data.embed) continue
      const res = resolveWikiTarget(link.data.target, path, new Set(docs.keys()))
      let status: EmbedExpansion['status'] = 'ok'
      let diag: EmbedDiagnostic | null = null
      if (res.target === null) {
        status = res.candidates.length > 0 ? 'ambiguous' : 'missing'
        diag = {
          code: res.candidates.length > 0 ? 'EMBED_AMBIGUOUS' : 'EMBED_MISSING',
          severity: 'warn',
          message:
            res.candidates.length > 0
              ? `嵌入目标歧义（${res.candidates.length} 个候选）`
              : '未找到嵌入目标',
          path,
          detail: link.data.raw,
        }
      } else if (chain.includes(res.target)) {
        status = 'cycle'
        diag = {
          code: 'EMBED_CYCLE',
          severity: 'warn',
          message: `循环嵌入已截断（链：${[...chain, res.target].join(' → ')}）`,
          path,
          detail: link.data.raw,
        }
      } else if (depth + 1 > EMBED_MAX_DEPTH) {
        status = 'depth-limit'
        diag = {
          code: 'EMBED_DEPTH_LIMIT',
          severity: 'warn',
          message: `嵌入深度超过上限 ${EMBED_MAX_DEPTH}，已截断`,
          path,
          detail: link.data.raw,
        }
      }
      out.push({
        span: link.span,
        sourcePath: path,
        raw: link.data.raw,
        targetPath: res.target,
        status,
        candidates: res.candidates,
        basis: res.basis,
        depth,
      })
      if (diag) onDiagnostic?.(diag)
      if (status === 'ok' && res.target) {
        walk(res.target, [...chain, res.target], depth + 1)
      }
    }
  }

  walk(startPath, [startPath], 0)
  return out
}

export { IMAGE_EXT }
