/**
 * 课时类型识别（架构基线 §7）：确定性特征提取 + 可解释加权打分。
 * 置信度是规则得分（诚实标注，不伪装统计概率）；分差 < 0.15 → 阻断询问；
 * 人工覆盖由上层记录（typeManual）。
 */
import type { ParsedDoc } from '../parse/parse'

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

export function extractFeatures(doc: ParsedDoc): TypeFeatures {
  const text = doc.blocks
    .filter((b) => b.kind === 'paragraph' || b.kind === 'heading' || b.kind === 'listItem')
    .map((b) => b.text)
    .join('\n')
  const derivationMatches = text.match(/证明|推导|不妨设|即得|从而|故|⇒|→|:\s*=/g)?.length ?? 0
  const conceptMatches =
    text.match(/定义为|是指|称之为|叫做|所谓|定义[::：]|【定义】/g)?.length ?? 0
  const exerciseMatches = text.match(/(^|\n)\s*(练习|习题|思考|作业|巩固)/g)?.length ?? 0
  let exampleProblems = 0
  let exampleSolutions = 0
  let orderedSteps = 0
  for (const b of doc.blocks) {
    if (b.kind === 'paragraph') {
      if (/^\s*(例\s*\d*|例题|【例)/.test(b.text)) exampleProblems++
      if (/^\s*解\s*[:：]/.test(b.text)) exampleSolutions++
    }
    if (b.kind === 'listItem') {
      // 有序列表项（推导步骤链信号）
      const parentList = doc.blocks.find(
        (x) => x.kind === 'list' && x.span.start <= b.span.start && b.span.end <= x.span.end,
      )
      if (parentList && (parentList.meta.ordered ?? false)) orderedSteps++
    }
  }
  return {
    formulaBlocks: doc.mathNodes.filter((m) => m.display).length,
    inlineMath: doc.mathNodes.filter((m) => !m.display).length,
    derivationSignals: derivationMatches,
    orderedSteps,
    exampleProblems,
    exampleSolutions,
    conceptSignals: conceptMatches,
    exerciseSignals: exerciseMatches,
    textLength: text.length,
  }
}

/** 分差阈值：top1 - top2 < 该值 → 阻断询问 */
export const TYPE_GAP_THRESHOLD = 0.15

export function classifyType(f: TypeFeatures): TypeDecision {
  const scores: Record<LessonType, number> = {
    concept: f.conceptSignals * 2.0,
    derivation: f.derivationSignals * 1.2 + f.orderedSteps * 1.0 + (f.formulaBlocks >= 1 ? 2.0 : 0),
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
  if (f.exampleProblems) evidence.push(`例题标记 ×${f.exampleProblems}`)
  if (f.exampleSolutions) evidence.push(`解答标记（解:）×${f.exampleSolutions}`)
  if (f.conceptSignals) evidence.push(`定义信号 ×${f.conceptSignals}`)
  if (f.exerciseSignals) evidence.push(`练习标记 ×${f.exerciseSignals}`)

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
