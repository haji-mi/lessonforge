/**
 * K3 二轮修复锁定（2026-10-24）。
 * 对应用户真实库诊断出的「不能生成提示词」问题：
 * ①「例如」误开例题区吞掉定义段（2-1 定义占位）
 * ②「**【推导】**：」引导语漏识别（2-4 分步推导占位）
 * ③「就定义了」句式不在 defCue
 * ④ 混合课型核心 MKU（尤其 formula）整批未纳入
 * ⑤ related 层（性质/运算律/易错提醒）静默丢弃且 UI 不可见
 * ⑥ 加粗兜底过宽：口诀含「定义」二字被误判 definition
 * ⑦ derivation 变量说明的列表前缀 bug
 */
import { describe, expect, it } from 'vitest'
import { classifyType, extractFeatures } from '../src/core/classify/type'
import { compileLesson } from '../src/core/compile/compile'
import { segmentMkus } from '../src/core/model/mku'
import { parseDoc } from '../src/core/parse/parse'
import { CUES } from '../src/core/model/cues'

function pipeline(text: string, path = 'x.md') {
  const doc = parseDoc(text)
  const type = classifyType(extractFeatures(doc))
  const mkus = segmentMkus(doc, path)
  const plan = compileLesson({
    lessonId: 'l',
    lessonTitle: path,
    lessonPath: path,
    doc,
    mkus,
    type,
  })
  return { doc, type, mkus, plan }
}

describe('K3①：「例如」不再误开例题区（真实笔记 2-1 样式）', () => {
  const NOTE = [
    '# 矩阵的概念',
    '',
    '例如，设 $m$ 个变量与 $n$ 个变量之间的线性关系为：',
    '',
    '这称为从变量 $x$ 到 $y$ 的**线性变换**。',
    '',
    '我们把这 $m \\times n$ 个数排成数表，就定义了**矩阵**：',
    '',
    '简记为 $A = (a_{ij})_{m \\times n}$。',
  ].join('\n')

  it('定义段保持 definition（此前被例如误开例题区吞成 exampleProblem）', () => {
    expect(CUES.exampleStart.test('例如，设 $m$ 个变量')).toBe(false)
    expect(CUES.exampleStart.test('例 1 求 x')).toBe(true)
    expect(CUES.exampleStart.test('例：求 x')).toBe(true)
    const { mkus } = pipeline(NOTE)
    expect(mkus.find((m) => m.text.includes('线性变换'))?.kind).toBe('definition')
    expect(mkus.find((m) => m.text.includes('就定义了'))?.kind).toBe('definition') // K3③
    expect(mkus.find((m) => m.text.includes('简记为'))?.kind).toBe('definition')
  })

  it('概念课编译不再出现「定义（内容不足）」占位', () => {
    const { plan } = pipeline(NOTE)
    expect(plan.type).toBe('concept')
    expect(plan.sections.some((s) => s.role === '定义' && s.content.includes('内容不足'))).toBe(
      false,
    )
    expect(plan.sections.filter((s) => s.role === '核心定义').length).toBeGreaterThanOrEqual(3)
  })
})

describe('K3②：「**【推导】**：」与「求法」标题（真实笔记 2-4 样式）', () => {
  const NOTE = [
    '# 逆矩阵',
    '',
    '## 逆矩阵的定义',
    '',
    '若 $AB = BA = E$，则称 $A$ 可逆，称 $B$ 为 $A$ 的逆矩阵，记作 $B = A^{-1}$。',
    '',
    '## 逆矩阵显示求法公式',
    '',
    '$$A^{-1} = \\frac{1}{|A|} A^*$$',
    '',
    '**【推导】**：在恒等式 $A A^* = |A| E$ 两边同除以 $|A|$，即得 $A^{-1} = \\frac{1}{|A|} A^*$。',
  ].join('\n')

  it('【推导】引导段 → derivationStep（core）', () => {
    const { mkus } = pipeline(NOTE)
    expect(mkus.find((m) => m.text.includes('【推导】'))?.kind).toBe('derivationStep')
    expect(mkus.find((m) => m.text.includes('【推导】'))?.tier).toBe('core')
  })

  it('推导课编译不再出现「分步推导（内容不足）」占位', () => {
    const { plan } = pipeline(NOTE)
    expect(plan.type).toBe('derivation')
    expect(plan.sections.some((s) => s.role === '分步推导' && s.content.includes('内容不足'))).toBe(
      false,
    )
    expect(
      plan.sections.some((s) => s.role.startsWith('分步推导·第') && s.contentType === 'A'),
    ).toBe(true)
  })

  it('**证明**：段落同理（derivLead）', () => {
    const doc = parseDoc('## 定理\n\n**证明**：由定义直接可得。')
    const mkus = segmentMkus(doc, 'p.md')
    expect(mkus.find((m) => m.text.includes('证明'))?.kind).toBe('derivationStep')
  })
})

describe('K3④：混合课型兜底——未覆盖核心 MKU 以「补充·」环节纳入', () => {
  const NOTE = [
    '# 概念与公式混合课',
    '',
    '**定义**：若 $AB = BA = E$，称 $A$ 可逆。',
    '',
    '$$A^{-1} = \\frac{1}{|A|} A^*$$',
    '',
    '$$|A^{-1}| = |A|^{-1}$$',
  ].join('\n')

  it('概念课的公式不再整批未纳入（补充·公式环节，带溯源）', () => {
    const { plan } = pipeline(NOTE)
    expect(plan.type).toBe('concept')
    const extra = plan.sections.filter((s) => s.role === '补充·公式')
    expect(extra.length).toBe(2)
    expect(extra.every((s) => s.contentType === 'A' && s.traces.length === 1)).toBe(true)
    expect(plan.coverage.uncovered).toHaveLength(0)
    expect(plan.coverage.coreHandled).toBe(plan.coverage.coreTotal)
  })

  it('例题课的推导步骤同样兜底纳入', () => {
    const NOTE2 = [
      '## 推导',
      '',
      '- 因为 $a > b$',
      '- 所以 $b < a$',
      '',
      '例 1 应用上述结论。',
      '',
      '解：代入即可。',
    ].join('\n')
    const { plan } = pipeline(NOTE2)
    expect(plan.type).toBe('example')
    expect(plan.sections.some((s) => s.role === '补充·推导步骤')).toBe(true)
    expect(plan.coverage.uncovered).toHaveLength(0)
  })

  it('兜底不与既有 A 段重复（span 重叠者跳过）', () => {
    const { plan, mkus } = pipeline(NOTE)
    // 定义段（已作为核心定义引用）不应再出现补充·核心定义
    expect(plan.sections.some((s) => s.role === '补充·核心定义')).toBe(false)
    const aSpans = plan.sections.filter((s) => s.contentType === 'A').flatMap((s) => s.traces)
    const def = mkus.find((m) => m.kind === 'definition')!
    expect(aSpans.filter((t) => t.start < def.span.end && def.span.start < t.end)).toHaveLength(1)
  })
})

describe('K3⑤：related 层未纳入显式报告 + 各课型取材补齐', () => {
  it('推导课的运算律 → 性质与运算律环节（不再静默丢弃）', () => {
    const NOTE = [
      '## 推导',
      '',
      '因为 $a > b$，即得 $b < a$。',
      '',
      '- 从而结论成立',
      '',
      '## 运算性质',
      '',
      '1. $(AB)^{-1} = B^{-1} A^{-1}$（穿脱原则）',
      '2. $(A^T)^{-1} = (A^{-1})^T$',
    ].join('\n')
    const { plan } = pipeline(NOTE)
    expect(plan.type).toBe('derivation')
    expect(plan.sections.filter((s) => s.role === '性质与运算律').length).toBeGreaterThanOrEqual(2)
  })

  it('概念课的 caution/exercise 纳入（易错提醒/同类练习）', () => {
    const NOTE = [
      '**定义**：若 $AB = BA = E$，称 $A$ 可逆。',
      '',
      '注意：逆矩阵唯一。',
      '',
      '练习 1 求 $A^{-1}$。',
    ].join('\n')
    const { plan } = pipeline(NOTE)
    expect(plan.sections.some((s) => s.role === '易错提醒')).toBe(true)
    expect(plan.sections.some((s) => s.role === '同类练习')).toBe(true)
  })

  it('例题课的 property → 相关知识环节', () => {
    const NOTE = [
      '**常用结论**：二阶逆矩阵口诀为主对调副变号。',
      '',
      '例 1 求逆矩阵。',
      '',
      '解：伴随法。',
    ].join('\n')
    const { plan } = pipeline(NOTE)
    expect(plan.type).toBe('example')
    expect(plan.sections.some((s) => s.role === '相关知识')).toBe(true)
  })

  it('仍未纳入的 related（如推导课的练习）在 uncoveredRelated 中可见', () => {
    const NOTE = [
      '## 推导',
      '',
      '因为 $a > b$，所以 $b < a$。',
      '',
      '## 练习',
      '',
      '练习 1 复述上述推导。',
    ].join('\n')
    const { plan } = pipeline(NOTE)
    expect(plan.type).toBe('derivation')
    expect(plan.coverage.uncoveredRelated.some((m) => m.kind === 'exercise')).toBe(true)
  })
})

describe('K3⑥：加粗引导语锚定首词（口诀不再误判 definition）', () => {
  it('「**行列定义看逆序…**」口诀 → property（related）而非 definition', () => {
    const doc = parseDoc('1. **行列定义看逆序，非零元素乘积和。**')
    const mkus = segmentMkus(doc, 'i.md')
    const m = mkus.find((x) => x.text.includes('逆序'))
    expect(m?.kind).toBe('property')
    expect(m?.tier).toBe('related')
  })
})

describe('K3⑦：推导课变量说明的列表前缀 bug', () => {
  it('「- 记 A 为…」列表项 → 变量说明（此前被 `- ` 前缀挡住）', () => {
    const NOTE = [
      '## 推导过程',
      '',
      '证明：由已知出发。',
      '',
      '- 记 $k$ 为非零常数',
      '',
      '$$x = y$$',
      '',
      '故结论成立。',
    ].join('\n')
    const { plan } = pipeline(NOTE)
    expect(plan.sections.some((s) => s.role === '变量说明' && s.content.includes('记'))).toBe(true)
  })
})
