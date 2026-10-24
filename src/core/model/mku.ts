/**
 * 最小知识单元（MKU）切分（架构基线 §3 K1 / §8）。
 * 全部确定性规则；tier 归属为领域启发式（K2 试验期，2026-10-24 依据真实笔记首轮校准）。
 * 切分对 CourseModel 的块序列进行；%%注释%% 作为作者注单元（背景层）。
 *
 * 校准要点：列表项与加粗引导语（`**术语**：内容`）是真实笔记的主要知识载体，
 * 与段落走同一套线索解析（cues.ts）；标题建立章节上下文（推导/例题/定义/性质），
 * 性质表格与 ⚠️ 提醒引用块按上下文归入相应层次，不再一律进背景层。
 */
import type { ParsedDoc } from '../parse/parse'
import type { Span } from '../types'
import { CUES, boldLeadOf, stripListPrefix, stripMarkers } from './cues'

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

/** 章节上下文（由标题维护） */
interface SegCtx {
  inDerivation: boolean
  inExample: boolean
  section: 'definition' | 'property' | null
}

/**
 * 线索解析器：段落与列表项共用。
 * 顺序即优先级；返回 null → 背景层。
 */
function resolveKind(
  raw: string,
  ctx: SegCtx,
  isListItem: boolean,
  isOrdered = false,
): MkuKind | null {
  const afterPrefix = stripListPrefix(raw)
  const bold = boldLeadOf(afterPrefix)
  const plain = stripMarkers(afterPrefix)

  if (CUES.exerciseStart.test(plain)) return 'exercise'
  if (CUES.exampleStart.test(plain)) return 'exampleProblem'
  if (CUES.solutionStart.test(plain)) return 'exampleSolution'
  if (bold && CUES.stepLead.test(bold.lead)) {
    return ctx.inDerivation ? 'derivationStep' : 'exampleSolution'
  }
  // 例题/推导区内的有序列表 = 步骤链（`**【详细解题步骤】**：` + `1. **分析**：…`）
  if (isListItem && isOrdered && (ctx.inExample || ctx.inDerivation)) {
    return ctx.inExample ? 'exampleSolution' : 'derivationStep'
  }
  if (ctx.inExample) return 'exampleProblem'
  if (CUES.cautionStart.test(plain) || (bold && CUES.cautionCue.test(bold.lead))) return 'caution'
  if (CUES.propStart.test(plain)) return 'property'
  if (ctx.inDerivation || (isListItem && CUES.derivStart.test(plain))) return 'derivationStep'
  if (CUES.defCue.test(plain)) return 'definition'
  if (bold && CUES.defLead.test(bold.lead)) return 'definition'
  if (ctx.section === 'definition' && (bold || isListItem)) return 'definition'
  if (bold && CUES.propLead.test(bold.lead)) return 'property'
  if (bold) return 'property'
  if (ctx.section === 'property' && (bold || isListItem)) return 'property'
  return null
}

export function segmentMkus(doc: ParsedDoc, sourcePath: string): Mku[] {
  const out: Mku[] = []
  const ctx: SegCtx = { inDerivation: false, inExample: false, section: null }

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

  /** 区域开关随识别结果推进（与段落路径行为一致） */
  const applyRegionSwitch = (kind: MkuKind | null) => {
    if (kind === 'exampleProblem') ctx.inExample = true
    else if (kind === 'exercise') ctx.inExample = false
  }

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
      const parentList = doc.blocks.find(
        (x) =>
          x.kind === 'list' && x.span.start <= block.span.start && block.span.end <= x.span.end,
      )
      const isOrdered = !!parentList?.meta.ordered
      const kind = resolveKind(block.text, ctx, true, isOrdered)
      applyRegionSwitch(kind)
      push(block.span, kind ?? 'background', block.text)
      return
    }
    if (block.kind === 'blockquote') {
      const plain = stripMarkers(stripListPrefix(block.text))
      push(block.span, CUES.cautionCue.test(plain) ? 'caution' : 'background', block.text)
      return
    }
    if (block.kind === 'table') {
      // 性质/考点/题型区的表格是知识本体（性质表、解题策略表），归相关知识层
      const teachable = ctx.section === 'property' || ctx.section === 'definition' || ctx.inExample
      push(block.span, teachable ? 'property' : 'background', block.text)
      return
    }
    push(block.span, 'background', block.text)
  }

  function processBlock(block: (typeof blocks)[number]) {
    if (block.kind === 'frontmatter') return
    if (block.kind === 'heading') {
      const plain = stripMarkers(block.text)
      if (CUES.derivHeading.test(plain)) {
        ctx.inDerivation = true
        ctx.inExample = false
        ctx.section = null
      } else if (CUES.exampleHeading.test(plain)) {
        ctx.inExample = true
        ctx.inDerivation = false
        ctx.section = null
      } else if (CUES.defHeading.test(plain)) {
        ctx.section = 'definition'
        ctx.inDerivation = false
        ctx.inExample = false
      } else if (CUES.propHeading.test(plain)) {
        ctx.section = 'property'
        ctx.inDerivation = false
        ctx.inExample = false
      } else {
        ctx.inDerivation = false
        ctx.inExample = false
        ctx.section = null
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

    const kind = resolveKind(text, ctx, false)
    applyRegionSwitch(kind)
    push(block.span, kind ?? 'background', text)
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
