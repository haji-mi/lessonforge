/**
 * 最小知识单元（MKU）切分（架构基线 §3 K1 / §8）。
 * 全部确定性规则；tier 归属为领域启发式（K2 试验期，待真实笔记校准）。
 * 切分对 CourseModel 的块序列进行；%%注释%% 作为作者注单元（背景层）。
 */
import type { ParsedDoc } from '../parse/parse'
import type { Span } from '../types'

export type MkuKind =
  | 'definition'
  | 'formula'
  | 'derivationStep'
  | 'exampleProblem'
  | 'exampleSolution'
  | 'property'
  | 'caution'
  | 'exercise'
  | 'code'
  | 'background'
  | 'authorNote'

export type MkuTier = 'core' | 'related' | 'background'

export interface Mku {
  id: string
  span: Span
  kind: MkuKind
  tier: MkuTier
  text: string
  latex?: string
  lang?: string
  calloutType?: string
}

const TIER: Record<MkuKind, MkuTier> = {
  definition: 'core',
  formula: 'core',
  derivationStep: 'core',
  exampleProblem: 'core',
  exampleSolution: 'core',
  exercise: 'related',
  property: 'related',
  caution: 'related',
  code: 'background',
  background: 'background',
  authorNote: 'background',
}

export interface MkuExclusion {
  mkuId: string
  reason?: string
}

export function segmentMkus(doc: ParsedDoc, sourcePath: string): Mku[] {
  const out: Mku[] = []
  let inDerivation = false
  let inExample = false

  const push = (span: Span, kind: MkuKind, text: string, extra?: Partial<Mku>) => {
    const id = `${sourcePath}:${span.start}-${span.end}`
    out.push({ id, span, kind, tier: TIER[kind], text, ...extra })
  }

  /** 容器块（其内部块已由容器文本覆盖，避免双重入列） */
  const CONTAINERS: ReadonlySet<string> = new Set([
    'listItem',
    'callout',
    'blockquote',
    'table',
    'code',
  ])

  const blocks = doc.blocks
  let i = 0
  while (i < blocks.length) {
    const block = blocks[i]!
    if (block.kind === 'list') {
      i++ // list 本身不产生 MKU，逐项处理
      continue
    }
    if (CONTAINERS.has(block.kind)) {
      emitContainerBlock(block)
      const end = block.span.end
      i++
      while (
        i < blocks.length &&
        blocks[i]!.span.end <= end &&
        blocks[i]!.span.start >= block.span.start
      )
        i++
      continue
    }
    processBlock(block)
    i++
  }

  function emitContainerBlock(block: (typeof blocks)[number]) {
    if (block.kind === 'code') {
      push(block.span, 'code', block.text, { lang: block.meta.lang })
      return
    }
    if (block.kind === 'callout') {
      const t = block.meta.calloutType ?? 'note'
      const kind: MkuKind = ['warning', 'caution', 'danger', 'bug'].includes(t)
        ? 'caution'
        : 'property'
      push(block.span, kind, block.text, { calloutType: t })
      return
    }
    if (block.kind === 'listItem') {
      if (inDerivation || /^(由|因为|所以|因此|两式|化简|代入)/.test(block.text)) {
        push(block.span, 'derivationStep', block.text)
      } else {
        push(block.span, 'background', block.text)
      }
      return
    }
    push(block.span, 'background', block.text)
  }

  function processBlock(block: (typeof blocks)[number]) {
    if (block.kind === 'frontmatter' || block.kind === 'heading') {
      if (block.kind === 'heading' && /证明|推导|引理/.test(block.text)) inDerivation = true
      else if (block.kind === 'heading') {
        inDerivation = false
        inExample = false
      }
      return
    }
    if (block.kind === 'thematicBreak') return
    if (block.kind === 'math') {
      const m = doc.mathNodes.find((x) => x.span.start === block.span.start)
      push(block.span, 'formula', block.text, { latex: m?.latex ?? '' })
      return
    }
    if (block.kind !== 'paragraph') {
      push(block.span, 'background', block.text)
      return
    }
    // 段落内的块级公式（单行 $$..$$ 属段落内 inlineMath）→ 公式 MKU（span 精确到公式）
    const displayMaths = doc.mathNodes.filter(
      (m) => m.display && m.span.start >= block.span.start && m.span.end <= block.span.end,
    )
    for (const m of displayMaths) {
      push(m.span, 'formula', m.raw, { latex: m.latex })
    }
    const stripped = displayMaths.reduce((s2, m) => s2.replace(m.raw, ''), block.text)
    if (stripped.trim().length === 0) return // 纯公式段落已处理
    const text = block.text

    if (/^\s*(练习|习题|思考|作业|巩固)/.test(text)) {
      inExample = false
      push(block.span, 'exercise', text)
      return
    }
    if (/^\s*(例\s*\d*|例题|【例)/.test(text)) {
      inExample = true
      push(block.span, 'exampleProblem', text)
      return
    }
    if (/^\s*解\s*[:：]/.test(text)) {
      push(block.span, 'exampleSolution', text)
      return
    }
    if (inExample) {
      push(block.span, 'exampleProblem', text)
      return
    }
    if (/^\s*(注意|易错|常见错误|小心|警示)/.test(text)) {
      push(block.span, 'caution', text)
      return
    }
    if (/^\s*(其中|记|设|令|性质|特点|特征)/.test(text)) {
      push(block.span, 'property', text)
      return
    }
    if (/定义为|是指|称之为|叫做|所谓|【定义】|定义\s*[:：]/.test(text)) {
      push(block.span, 'definition', text)
      return
    }
    push(block.span, 'background', text)
  }

  // %%注释%% → 作者注（背景层）
  for (const c of doc.comments) {
    push(c.span, 'authorNote', c.text)
  }

  return out
}

export interface CoverageEntry {
  mku: Mku
  state: 'included' | 'excluded' | 'uncovered'
  reason?: string
}

/** 应用用户排除（进入列表即排除），并按引用区间计算三态覆盖 */
export function computeCoverage(
  mkus: Mku[],
  includedSpans: { file: string; span: Span }[],
  sourcePath: string,
  exclusions: MkuExclusion[] = [],
): CoverageEntry[] {
  const exclusionMap = new Map(exclusions.map((o) => [o.mkuId, o]))
  const ownSpans = includedSpans.filter((s) => s.file === sourcePath).map((s) => s.span)
  return mkus.map((m) => {
    const ov = exclusionMap.get(m.id)
    if (ov)
      return { mku: m, state: 'excluded' as const, reason: ov.reason ?? '用户排除（未填理由）' }
    const covered = ownSpans.some((s) => s.start < m.span.end && m.span.start < s.end)
    return covered
      ? { mku: m, state: 'included' as const }
      : { mku: m, state: 'uncovered' as const }
  })
}
