/**
 * 课时类型识别（架构基线 §7）：确定性特征提取 + 可解释加权打分。
 * 置信度是规则得分（诚实标注，不伪装统计概率）；分差 < 0.15 → 阻断询问；
 * 人工覆盖由上层记录（typeManual）。
 *
 * K2 校准（2026-10-24）：信号统计在净化文本上进行（去强调/列表前缀），
 * 使 `**定义**：`、`- **例 1**：` 等真实笔记写法与裸文本命中同一信号；
 * 例题信号扩展到标题（`### 【例题4】`）与加粗步骤引导（`**第一步**：`）；
 * 公式块加分须伴随推导信号——性质课满是公式，不应因此判为推导课。
 */
import type { ParsedDoc } from '../parse/parse'
import { CUES, boldLeadOf, stripListPrefix, stripMarkers } from '../model/cues'

export type LessonType = 'concept' | 'derivation' | 'example' | 'generic'

export interface TypeFeatures {
  formulaBlocks: number
  inlineMath: number
  derivationSignals: number
  orderedSteps: number
  exampleProblems: number
  exampleSolutions: number
  conceptSignals: number
  exerciseSignals: number
  textLength: number
  /** 目录/导学页（索引、总览、大纲等）——只做通用讲解，不按课型编译 */
  navigationPage: boolean
}

export interface TypeDecision {
  type: LessonType
  score: number
  confidence: number
  runnerUp: LessonType | null
  gap: number
  ambiguous: boolean
  evidence: string[]
}

const DERIV_SIGNAL_RE = /证明|推导|不妨设|即得|从而|故|⇒|→|:\s*=/g
const NAV_RE = /索引|目录|总览|大纲|导学|学习路线/

export function extractFeatures(doc: ParsedDoc): TypeFeatures {
  const cueBlocks = doc.blocks.filter(
    (b) => b.kind === 'paragraph' || b.kind === 'heading' || b.kind === 'listItem',
  )
  // 信号统计用净化文本：去标记/列表前缀，并去掉行内公式——
  // 公式内的 ⇒/→/称为 等不属于作者的教学语言，会污染信号
  const plainOf = (b: (typeof doc.blocks)[number]) =>
    stripMarkers(stripListPrefix(b.text)).replace(/\$[^$]*\$/g, '')
  const plainText = cueBlocks.map(plainOf).join('\n')
  const derivationMatches = plainText.match(DERIV_SIGNAL_RE)?.length ?? 0
  const conceptMatches = plainText.match(new RegExp(CUES.defCue.source, 'g'))?.length ?? 0
  const exerciseMatches = plainText.match(/(^|\n)\s*(练习|习题|思考|作业|巩固)/g)?.length ?? 0
  let exampleProblems = 0
  let exampleSolutions = 0
  let orderedSteps = 0
  let inDerivationSection = false
  for (const b of doc.blocks) {
    const plain = plainOf(b)
    if (b.kind === 'heading') {
      if (CUES.derivHeading.test(plain)) inDerivationSection = true
      else inDerivationSection = false
      if (CUES.exampleHeading.test(plain)) exampleProblems++
      continue
    }
    if (b.kind === 'paragraph' || b.kind === 'listItem') {
      if (CUES.exampleStart.test(plain)) exampleProblems++
      if (CUES.solutionStart.test(plain)) exampleSolutions++
      const bold = boldLeadOf(stripListPrefix(b.text))
      if (bold && CUES.stepLead.test(bold.lead)) exampleSolutions++
    }
    if (b.kind === 'listItem') {
      // 有序列表项仅在推导小节内才算步骤链信号——
      // 性质/运算律的编号枚举不是推导
      const parentList = doc.blocks.find(
        (x) => x.kind === 'list' && x.span.start <= b.span.start && b.span.end <= x.span.end,
      )
      if (parentList && (parentList.meta.ordered ?? false) && inDerivationSection) orderedSteps++
    }
  }
  // 目录/导学/章末总结页：标题命中导航词，或 H1 以「本章」开头（本章考点/题型总结）
  const titleSources = [
    typeof doc.frontmatter.data?.['title'] === 'string' ? doc.frontmatter.data['title'] : '',
    ...doc.blocks.filter((b) => b.kind === 'heading' && b.meta.depth === 1).map((b) => b.text),
  ]
  const navigationPage = titleSources.some(
    (t) => t && (NAV_RE.test(stripMarkers(t)) || /^本章/.test(stripMarkers(t).trim())),
  )
  return {
    formulaBlocks: doc.mathNodes.filter((m) => m.display).length,
    inlineMath: doc.mathNodes.filter((m) => !m.display).length,
    derivationSignals: derivationMatches,
    orderedSteps,
    exampleProblems,
    exampleSolutions,
    conceptSignals: conceptMatches,
    exerciseSignals: exerciseMatches,
    textLength: plainText.length,
    navigationPage,
  }
}

/** 分差阈值：top1 - top2 < 该值 → 阻断询问 */
export const TYPE_GAP_THRESHOLD = 0.15

export function classifyType(f: TypeFeatures): TypeDecision {
  const scores: Record<LessonType, number> = {
    concept: f.conceptSignals * 2.0,
    derivation:
      f.derivationSignals * 1.2 +
      f.orderedSteps * 1.0 +
      (f.formulaBlocks >= 1 && f.derivationSignals > 0 ? 2.0 : 0),
    example: f.exampleProblems * 3.0 + f.exampleSolutions * 1.5,
    generic: 0,
  }
  const entries = (Object.entries(scores) as [LessonType, number][]).sort((a, b) => b[1] - a[1])
  const [top, topScore] = entries[0]!
  const [runnerUp, runnerScore] = entries[1] ?? [null, 0]
  const sum = entries.reduce((s, [, v]) => s + v, 0)
  const evidence: string[] = []
  if (f.formulaBlocks) evidence.push(`公式块 ×${f.formulaBlocks}`)
  if (f.inlineMath) evidence.push(`行内公式 ×${f.inlineMath}`)
  if (f.derivationSignals) evidence.push(`推导信号 ×${f.derivationSignals}（证明/即得/⇒…）`)
  if (f.orderedSteps) evidence.push(`有序步骤项 ×${f.orderedSteps}`)
  if (f.exampleProblems) evidence.push(`例题标记 ×${f.exampleProblems}（含标题/列表项）`)
  if (f.exampleSolutions) evidence.push(`解答标记 ×${f.exampleSolutions}（解:/第N步）`)
  if (f.conceptSignals) evidence.push(`定义信号 ×${f.conceptSignals}`)
  if (f.exerciseSignals) evidence.push(`练习标记 ×${f.exerciseSignals}`)

  // 目录/导学页 → 通用讲解（内容是导航与口诀，不是某个课型的知识展开）
  if (f.navigationPage) {
    return {
      type: 'generic',
      score: 0,
      confidence: 0,
      runnerUp: null,
      gap: 0,
      ambiguous: false,
      evidence: ['目录/导学/章末总结页（标题命中导航词或 H1「本章」开头）→ 通用讲解'],
    }
  }

  // 信号全弱 → generic 兜底
  if (topScore < 2.0) {
    return {
      type: 'generic',
      score: 0,
      confidence: 0,
      runnerUp: null,
      gap: 0,
      ambiguous: false,
      evidence: evidence.length ? evidence : ['未检测到课型信号'],
    }
  }
  const gap = topScore - runnerScore
  return {
    type: top,
    score: topScore,
    confidence: sum > 0 ? topScore / sum : 0,
    runnerUp: runnerScore > 0 ? (runnerUp as LessonType) : null,
    gap,
    ambiguous: runnerScore > 0 && gap < TYPE_GAP_THRESHOLD * Math.max(topScore, 1),
    evidence,
  }
}
