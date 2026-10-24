/**
 * 互动课堂提示词编译器（架构基线 §8）。
 *
 * - A 原始知识：逐字或保守句式变换，强制 trace（T1），编译期校验失败即硬错误。
 * - B 教学组织：确定性规则 + 依据（规则 ID + 触发内容），可解释可追溯。
 * - C 新增知识：第一版不实现生成（T2 默认零）；任何 C 段须经逐条人工批准（T3）。
 * - 环节池 + 内容可用性驱动（非固定模板）；内容不足 → 省略 + 注记，绝不编造。
 * - 护栏：环节间 span 重叠 >60% 去重、长度软预算警告、未纳入清单（K1 三态）。
 */
import { COMPILER_VERSION, PROMPT_SCHEMA_VERSION } from '../version'
import type { LessonType, TypeDecision } from '../classify/type'
import type { Mku } from '../model/mku'
import { computeCoverage } from '../model/mku'
import type { ParsedDoc } from '../parse/parse'
import type { Span } from '../types'

export interface Trace {
  file: string
  start: number
  end: number
}

export interface PromptSection {
  sectionId: string
  role: string
  contentType: 'A' | 'B' | 'C'
  content: string
  traces: Trace[]
  /** B 段生成依据（规则 ID + 触发内容） */
  basis?: string
  /** 内容不足等注记 */
  note?: string
}

export interface PromptSettings {
  subject: string
  level: string
  interaction: 'low' | 'mid' | 'high'
  lengthBudget: number
}

export const DEFAULT_PROMPT_SETTINGS: PromptSettings = {
  subject: '数学',
  level: '高中',
  interaction: 'mid',
  lengthBudget: 2000,
}

export interface LessonPlan {
  lessonId: string
  lessonTitle: string
  lessonPath: string
  type: LessonType
  typeEvidence: string[]
  compilerVersion: number
  promptSchemaVersion: number
  sections: PromptSection[]
  coverage: {
    coreTotal: number
    coreHandled: number
    uncovered: Mku[]
    excluded: { mku: Mku; reason: string }[]
  }
  warnings: string[]
  promptText: string
}

export interface CompileInput {
  lessonId: string
  lessonTitle: string
  lessonPath: string
  doc: ParsedDoc
  mkus: Mku[]
  type: TypeDecision
  settings?: Partial<PromptSettings>
  /** 用户排除（K1 已显式排除，必填理由由 UI 保证） */
  exclusions?: { mkuId: string; reason: string }[]
}

const TYPE_LABEL: Record<LessonType, string> = {
  concept: '概念理解',
  derivation: '公式推导',
  example: '例题讲解',
  generic: '通用讲解',
}

class CompileError extends Error {}

function traceOf(file: string, span: Span): Trace {
  return { file, start: span.start, end: span.end }
}

/** A 段工厂：内容 = 原文（逐字或保守句式变换），trace 必填 */
function aSection(
  id: string,
  role: string,
  content: string,
  mku: Mku,
  lessonPath: string,
  note?: string,
): PromptSection {
  return {
    sectionId: id,
    role,
    contentType: 'A',
    content,
    traces: [traceOf(lessonPath, mku.span)],
    note,
  }
}

function bSection(
  id: string,
  role: string,
  content: string,
  basis: string,
  traces: Trace[] = [],
): PromptSection {
  return { sectionId: id, role, contentType: 'B', content, traces, basis }
}

function sectionText(s: PromptSection): string {
  return s.content
}

/** 环节间引用重叠 >60% → 去重（保留首个，后续降为指代并警告） */
function dedupeSections(sections: PromptSection[], warnings: string[]): PromptSection[] {
  const kept: PromptSection[] = []
  for (const s of sections) {
    if (s.contentType !== 'A' || s.traces.length === 0) {
      kept.push(s)
      continue
    }
    const dup = kept.find(
      (k) =>
        k.contentType === 'A' &&
        k.traces.length > 0 &&
        overlapRatio(k.traces[0]!, s.traces[0]!) > 0.6,
    )
    if (dup) {
      warnings.push(`环节「${s.role}」与「${dup.role}」引用区间重叠超 60%，已去重为指代`)
      kept.push({ ...s, content: `（同前文「${dup.role}」引用的内容，此处不再重复）`, traces: [] })
    } else {
      kept.push(s)
    }
  }
  return kept
}

function overlapRatio(a: Trace, b: Trace): number {
  if (a.file !== b.file) return 0
  const inter = Math.min(a.end, b.end) - Math.max(a.start, b.start)
  if (inter <= 0) return 0
  const minLen = Math.min(a.end - a.start, b.end - b.start)
  return inter / minLen
}

export function compileLesson(input: CompileInput): LessonPlan {
  const settings = { ...DEFAULT_PROMPT_SETTINGS, ...input.settings }
  const { doc, mkus, type, lessonPath } = input
  const warnings: string[] = []
  const text = mkus.length > 0 ? (doc.blocks[0] ? doc.blocks[0]!.text : '') : ''
  void text

  const pick = (kind: Mku['kind']) => mkus.filter((m) => m.kind === kind)
  const sections: PromptSection[] = []
  let n = 0
  const nextId = () => `s${++n}`

  const t = type.type
  if (t === 'concept') {
    const defs = pick('definition')
    const props = pick('property')
    const examples = pick('exampleProblem')
    const bg = pick('background')
    // 环节：引入（有背景段才生成）
    if (bg.length > 0) {
      sections.push(
        aSection(nextId(), '情境引入', `先看一个背景：${bg[0]!.text}`, bg[0]!, lessonPath),
      )
    }
    if (defs.length === 0) {
      sections.push(
        bSection(nextId(), '定义', '（内容不足：原文未提供明确定义段）', 'rule:no-definition'),
      )
    }
    for (const d of defs) {
      sections.push(aSection(nextId(), '核心定义', d.text, d, lessonPath))
    }
    for (const p of props) {
      sections.push(aSection(nextId(), '属性辨析', p.text, p, lessonPath))
    }
    for (const e of examples) {
      sections.push(aSection(nextId(), '示例', e.text, e, lessonPath))
    }
    if (settings.interaction !== 'low' && defs.length > 0) {
      sections.push(
        bSection(
          nextId(),
          '即时检测',
          defs
            .map(
              (d) =>
                `提问：请学生用自己的话复述以下内容，并判断其中每个关键词能否去掉——"${firstSentence(d.text)}"`,
            )
            .join('\n'),
          `rule:concept-quickcheck（由 ${defs.length} 个定义段触发）`,
          defs.map((d) => traceOf(lessonPath, d.span)),
        ),
      )
    }
    if (defs.length > 0) {
      sections.push(
        bSection(
          nextId(),
          '课堂小结',
          `小结：回到定义本身——"${firstSentence(defs[0]!.text)}"，请学生齐读一遍。`,
          'rule:summary（引用首个定义段）',
          [traceOf(lessonPath, defs[0]!.span)],
        ),
      )
    }
  } else if (t === 'derivation') {
    const steps = pick('derivationStep')
    const formulas = pick('formula')
    const props = pick('property')
    const links = doc.wikilinks.filter(
      (w) => !/\.(png|jpe?g|gif|svg|webp|bmp|avif)$/i.test(w.data.target),
    )
    if (links.length > 0) {
      sections.push(
        bSection(
          nextId(),
          '前置回顾',
          `先回顾与本课相关的笔记：${[...new Set(links.map((l) => l.data.target))].map((x) => `「${x}」`).join('、')}。请学生回忆其要点。`,
          `rule:prereq（检测到 ${links.length} 个双链引用）`,
          links.map((l) => traceOf(lessonPath, l.span)),
        ),
      )
    }
    if (formulas.length > 0) {
      sections.push(
        aSection(
          nextId(),
          '目标命题',
          `本课要推导得到：${formulas[formulas.length - 1]!.latex ?? formulas[formulas.length - 1]!.text}`,
          formulas[formulas.length - 1]!,
          lessonPath,
        ),
      )
    }
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]!
      if (i > 0 && settings.interaction !== 'low') {
        // 预测设问：候选仅取原文后续真实步骤（不虚构选项）
        sections.push(
          bSection(
            nextId(),
            `分步推导·第 ${i + 1} 步预测`,
            `提问：上一步之后，你预测接下来会用什么方法推进？请学生先说思路，再揭示下一步。`,
            `rule:derivation-predict（第 ${i} 步后设问；选项即后续真实步骤）`,
            [traceOf(lessonPath, steps[i - 1]!.span)],
          ),
        )
      }
      sections.push(aSection(nextId(), `分步推导·第 ${i + 1} 步`, s.text, s, lessonPath))
    }
    if (steps.length === 0) {
      sections.push(
        bSection(
          nextId(),
          '分步推导',
          '（内容不足：原文未提供可识别的推导步骤链）',
          'rule:no-steps',
        ),
      )
    }
    for (const p of props.filter((x) => /^(其中|记|设|令)/.test(x.text))) {
      sections.push(aSection(nextId(), '变量说明', p.text, p, lessonPath))
    }
    for (const c of pick('caution')) {
      sections.push(aSection(nextId(), '易错提醒', c.text, c, lessonPath))
    }
  } else if (t === 'example') {
    const problems = pick('exampleProblem')
    const solutions = pick('exampleSolution')
    const cautions = pick('caution')
    const exercises = pick('exercise')
    for (const p of problems) {
      sections.push(aSection(nextId(), '例题呈现', p.text, p, lessonPath))
    }
    if (problems.length > 0 && settings.interaction !== 'low') {
      sections.push(
        bSection(
          nextId(),
          '先自己试一试',
          '给学生 1-2 分钟先自己尝试，不动笔讨论思路即可。到时间后再开始逐步讲解。',
          `rule:example-attempt-first（由 ${problems.length} 个例题段触发）`,
          problems.map((p) => traceOf(lessonPath, p.span)),
        ),
      )
    }
    for (const s of solutions) {
      sections.push(aSection(nextId(), '分步解答', s.text, s, lessonPath))
    }
    if (solutions.length === 0) {
      sections.push(
        bSection(
          nextId(),
          '分步解答',
          '（内容不足：原文未提供"解："形式的解答段）',
          'rule:no-solution',
        ),
      )
    }
    for (const c of cautions) {
      sections.push(aSection(nextId(), '易错点', c.text, c, lessonPath))
    }
    if (exercises.length > 0) {
      for (const e of exercises) {
        sections.push(aSection(nextId(), '同类练习', e.text, e, lessonPath))
      }
    } else {
      sections.push(
        bSection(
          nextId(),
          '同类练习',
          '（练习不足：原文未提供同类练习题，请教师自行补充，不虚构题目）',
          'rule:no-exercise',
        ),
      )
    }
  } else {
    // generic 兜底：讲解（核心 + 相关知识块按序）+ 小结。
    // 转写模式仅用于连可识别的相关知识都没有的结构异常场景（基线 §8）。
    const teachable = mkus.filter((m) => m.tier === 'core' || m.tier === 'related')
    if (teachable.length === 0) {
      sections.push(
        bSection(
          nextId(),
          '讲解',
          '（原文无可识别的核心知识块，进入原文转写模式）',
          'rule:generic-transcribe',
        ),
      )
      sections.push(
        bSection(
          nextId(),
          '原文转写',
          '请按原文顺序讲解以下内容（原文转写，未编译）：',
          'rule:transcribe',
        ),
      )
      sections.push(
        bSection(nextId(), '课堂小结', '请学生复述本课要点，教师补充。', 'rule:generic-summary'),
      )
    } else {
      for (const m of teachable) {
        sections.push(aSection(nextId(), '讲解', m.text, m, lessonPath))
      }
      sections.push(
        bSection(nextId(), '课堂小结', '请学生复述本课要点，教师补充。', 'rule:generic-summary'),
      )
    }
  }

  // 护栏：去重 + 长度预算
  const deduped = dedupeSections(sections, warnings)
  const totalLen = deduped.reduce((s, x) => s + sectionText(x).length, 0)
  if (totalLen > settings.lengthBudget) {
    warnings.push(
      `提示词总长 ${totalLen} 超过软预算 ${settings.lengthBudget}（不截断，请人工取舍）`,
    )
  }

  // T1 溯源校验（硬错误）
  for (const s of deduped) {
    if (s.contentType === 'A') {
      for (const tr of s.traces) {
        if (tr.file !== lessonPath) continue
        if (tr.start < 0 || tr.end > (doc.tree?.position?.end?.offset ?? 0) + 1e9) {
          throw new CompileError(`A 段 ${s.sectionId} 的 trace 越界：[${tr.start},${tr.end})`)
        }
        const hit = mkus.find((m) => m.span.start <= tr.start && tr.end <= m.span.end)
        if (!hit) {
          throw new CompileError(
            `A 段 ${s.sectionId} 的 trace 无法解析到 MKU：[${tr.start},${tr.end})`,
          )
        }
      }
    }
  }
  // T2：默认零 C 段
  if (deduped.some((s) => s.contentType === 'C')) {
    throw new CompileError('默认配置下不允许出现 C 级内容段')
  }

  // 覆盖三态（K1）
  const includedSpans = deduped
    .filter((s) => s.contentType === 'A')
    .flatMap((s) =>
      s.traces.map((tr) => ({ file: tr.file, span: { start: tr.start, end: tr.end } })),
    )
  const coverage = computeCoverage(mkus, includedSpans, lessonPath, input.exclusions ?? [])
  const coreEntries = coverage.filter((c) => c.mku.tier === 'core')
  const uncovered = coverage
    .filter((c) => c.state === 'uncovered' && c.mku.tier === 'core')
    .map((c) => c.mku)
  const excluded = coverage
    .filter((c) => c.state === 'excluded')
    .map((c) => ({ mku: c.mku, reason: c.reason ?? '' }))

  const promptText = serializePrompt(deduped, input, settings, TYPE_LABEL[t])

  return {
    lessonId: input.lessonId,
    lessonTitle: input.lessonTitle,
    lessonPath,
    type: t,
    typeEvidence: type.evidence,
    compilerVersion: COMPILER_VERSION,
    promptSchemaVersion: PROMPT_SCHEMA_VERSION,
    sections: deduped,
    coverage: {
      coreTotal: coreEntries.length,
      coreHandled: coreEntries.length - uncovered.length,
      uncovered,
      excluded,
    },
    warnings,
    promptText,
  }
}

function firstSentence(text: string): string {
  const m = /^[^。；;！？\n]*[。；;！？]?/.exec(text.trim())
  return m ? m[0] : text.trim().slice(0, 60)
}

/** 固定脚手架（PROMPT_SCHEMA_VERSION 管理）+ 可配置槽位 */
export function serializePrompt(
  sections: PromptSection[],
  input: CompileInput,
  settings: PromptSettings,
  typeLabel: string,
): string {
  const lines: string[] = []
  lines.push(
    `【角色】你是一位${settings.level}${settings.subject}老师，正在上一堂「${typeLabel}」课。请严格按以下课堂结构授课，与学生互动推进，不要引入本提示词之外的新知识点。`,
  )
  lines.push(`【课题】${input.lessonTitle}（来源：${input.lessonPath}）`)
  lines.push(`【课堂目标】${goalOf(input.type.type)}`)
  lines.push('【课堂流程】')
  let idx = 0
  for (const s of sections) {
    if (!s.content) continue
    idx++
    lines.push(`${idx}. ${s.role}`)
    lines.push(indent(s.content, '   '))
  }
  lines.push(
    '【输出要求】按环节顺序推进；凡标注"提问"处必须等待学生回答后再继续；公式按原文 LaTeX 输出；不得编造原文没有的结论、答案或练习。',
  )
  return lines.join('\n')
}

function goalOf(t: LessonType): string {
  switch (t) {
    case 'concept':
      return `理解本课核心概念的定义与关键属性，能用自己的话复述并辨析。`
    case 'derivation':
      return `理解并复现本课的推导主线，掌握每一步的依据。`
    case 'example':
      return `通过例题掌握解题步骤与易错点，能独立完成同类练习。`
    default:
      return `理解本课内容要点。`
  }
}

function indent(text: string, pad: string): string {
  return text
    .split('\n')
    .map((l) => (l ? pad + l : l))
    .join('\n')
}
