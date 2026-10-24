/**
 * K2 首轮真实笔记校准（2026-10-24）。
 * 样式取自用户真实线性代数笔记（NotebookLM 风格，内容为等价改写）：
 * 加粗术语列表、性质表格、⚠️ 提醒引用块、加粗步骤段、例题标题。
 * 校准前这些写法全部落入背景层，导致「原文无可识别的核心知识块」误报。
 */
import { describe, expect, it } from 'vitest'
import { classifyType, extractFeatures } from '../src/core/classify/type'
import { compileLesson } from '../src/core/compile/compile'
import { segmentMkus } from '../src/core/model/mku'
import { parseDoc } from '../src/core/parse/parse'

/** 真实笔记样式 A：编号小节 + 加粗术语定义列表（3-1/3-2 风格） */
const BOLD_TERM_NOTE = [
  '# §1 矩阵的初等变换',
  '',
  '## 1. 初等变换的定义',
  '',
  '- **方程组的同解变换**：消元法中的三种变换转换到增广矩阵上，即为矩阵的初等行变换。',
  '- **三种初等行变换**：',
  '  - **对换两行**：对换第 $i, j$ 两行，记作 $r_i \\leftrightarrow r_j$。',
  '  - **数乘某行**：以非零数 $k$ 乘某一行，记作 $r_i \\times k$。',
  '- **统称**：初等行变换与初等列变换统称为初等变换。',
  '',
  '## 3. 矩阵的等价',
  '',
  '- **定义**：如果矩阵 $A$ 经有限次初等变换变成 $B$，称 $A$ 与 $B$ 等价。',
  '- **等价关系的性质**：',
  '  - **反身性**：$A \\sim A$。',
  '  - **对称性**：若 $A \\sim B$，则 $B \\sim A$。',
  '- **定理1**：$A \\sim B$ 的充要条件是存在可逆矩阵 $P, Q$ 使 $PAQ = B$。',
].join('\n')

/** 真实笔记样式 B：性质表格 + ⚠️ 引用块（1-3 风格） */
const TABLE_NOTE = [
  '# 核心性质梳理',
  '',
  '## 5 大核心性质',
  '',
  '| 性质 | 记号 | 含义 |',
  '| :-- | :-- | :-- |',
  '| **性质 1** | $D = D^T$ | 行列式与转置行列式相等。 |',
  '| **性质 2** | $r_i \\leftrightarrow r_j$ | 互换两行，行列式变号。 |',
  '',
  '> ⚠️ **【课堂规范提醒】**',
  '> 记号必须严格写作 $r_i + k r_j$，不能颠倒。',
].join('\n')

/** 真实笔记样式 C：解题模型 + 例题标题 + 加粗步骤段（1-5 风格） */
const MODEL_NOTE = [
  '# 四大解题模型',
  '',
  '## 模型一：三角化法',
  '',
  '**核心思想**：将行列式化为上三角形后求解。',
  '',
  '### 【例题1】计算二阶行列式',
  '',
  '$$D = \\begin{vmatrix} 1 & 2 \\\\ 3 & 4 \\end{vmatrix}$$',
  '',
  '**第一步**：对换两行使首元为 1。',
  '',
  '**第二步**：消去第 1 列其余元素，化为上三角。',
  '',
  '**第三步**：主对角线相乘得到结果。',
].join('\n')

describe('K2 校准：加粗术语列表（真实笔记样式 A）', () => {
  const doc = parseDoc(BOLD_TERM_NOTE)
  const mkus = segmentMkus(doc, 'a.md')

  it('定义小节下的加粗术语项 → definition（core）', () => {
    const defs = mkus.filter((m) => m.kind === 'definition')
    expect(defs.length).toBeGreaterThanOrEqual(3)
    expect(defs.every((d) => d.tier === 'core')).toBe(true)
    // 子列表被父项文本覆盖（容器吞并），父项整体入列
    const umbrella = defs.find((d) => d.text.includes('三种初等行变换'))
    expect(umbrella).toBeDefined()
    expect(umbrella!.text).toContain('对换两行') // 子项原文在内
  })

  it('统称/记作/称为句式 → definition', () => {
    expect(mkus.find((m) => m.text.includes('统称为初等变换'))?.kind).toBe('definition')
    expect(mkus.find((m) => m.text.includes('记作 $r_i'))?.kind).toBe('definition')
  })

  it('定理/性质引导项 → property（related）', () => {
    expect(mkus.find((m) => m.text.includes('定理1'))?.kind).toBe('property')
    expect(mkus.find((m) => m.text.includes('反身性'))?.kind).toBe('property')
  })

  it('课型 → concept；编译产出核心定义环节', () => {
    const type = classifyType(extractFeatures(doc))
    expect(type.type).toBe('concept')
    const plan = compileLesson({
      lessonId: 'l',
      lessonTitle: 'a',
      lessonPath: 'a.md',
      doc,
      mkus,
      type,
    })
    expect(plan.sections.filter((s) => s.role === '核心定义').length).toBeGreaterThanOrEqual(3)
    expect(plan.coverage.coreTotal).toBeGreaterThanOrEqual(3)
    expect(plan.promptText).not.toContain('原文无可识别')
  })
})

describe('K2 校准：性质表格与提醒引用块（真实笔记样式 B）', () => {
  const doc = parseDoc(TABLE_NOTE)
  const mkus = segmentMkus(doc, 'b.md')

  it('性质标题下的表格 → property；⚠️ 引用块 → caution', () => {
    expect(mkus.find((m) => m.text.includes('性质 1'))?.kind).toBe('property')
    expect(mkus.find((m) => m.text.includes('课堂规范提醒'))?.kind).toBe('caution')
  })

  it('generic 兜底纳入相关知识块，不再误入转写模式', () => {
    const type = classifyType(extractFeatures(doc))
    expect(type.type).toBe('generic')
    const plan = compileLesson({
      lessonId: 'l',
      lessonTitle: 'b',
      lessonPath: 'b.md',
      doc,
      mkus,
      type,
    })
    const lectures = plan.sections.filter((s) => s.role === '讲解')
    expect(lectures.length).toBeGreaterThanOrEqual(2) // 表格 + 提醒
    expect(lectures.some((s) => s.content.includes('D = D^T'))).toBe(true)
    expect(lectures.some((s) => s.content.includes('课堂规范提醒'))).toBe(true)
    expect(plan.promptText).not.toContain('原文无可识别')
  })
})

describe('K2 校准：例题标题与加粗步骤（真实笔记样式 C）', () => {
  const doc = parseDoc(MODEL_NOTE)
  const mkus = segmentMkus(doc, 'c.md')

  it('例题标题开启例题区；**第N步** → exampleSolution；公式块 → formula', () => {
    expect(mkus.filter((m) => m.kind === 'exampleSolution').length).toBeGreaterThanOrEqual(3)
    expect(mkus.filter((m) => m.kind === 'formula').length).toBeGreaterThanOrEqual(1)
    expect(mkus.find((m) => m.kind === 'exampleProblem')).toBeDefined()
  })

  it('课型 → example；编译产出分步解答', () => {
    const type = classifyType(extractFeatures(doc))
    expect(type.type).toBe('example')
    const plan = compileLesson({
      lessonId: 'l',
      lessonTitle: 'c',
      lessonPath: 'c.md',
      doc,
      mkus,
      type,
    })
    expect(plan.sections.filter((s) => s.role === '分步解答').length).toBeGreaterThanOrEqual(3)
  })
})

describe('K2 校准：列表推导链前缀不再被列表标记遮挡', () => {
  it('- 因为/所以 开头的列表项 → derivationStep', () => {
    const doc = parseDoc('## 推导\n\n因为 $a > b$。\n\n- 所以 $b < a$\n- 从而得证')
    const mkus = segmentMkus(doc, 'd.md')
    expect(mkus.find((m) => m.text.includes('所以'))?.kind).toBe('derivationStep')
    expect(mkus.find((m) => m.text.includes('从而'))?.kind).toBe('derivationStep')
  })
})

describe('K2 校准：例题区有序列表 = 解答步骤链（真实笔记样式 D）', () => {
  const text = [
    '## 【例题2】（求方阵的幂）',
    '',
    '已知 $A = \\alpha \\beta^T$，求 $A^{100}$。',
    '',
    '**【详细解题步骤】**：',
    '',
    '1. **分析结构**：$A$ 是 $3 \\times 3$ 矩阵。',
    '2. **计算 $A^2$**：利用结合律化简。',
    '3. **代回归纳**：递推得到 $A^{100} = A$。',
  ].join('\n')

  it('例题区内的有序步骤项 → exampleSolution；正文已知条件 → exampleProblem', () => {
    const doc = parseDoc(text)
    const mkus = segmentMkus(doc, 'e.md')
    expect(mkus.filter((m) => m.kind === 'exampleSolution').length).toBeGreaterThanOrEqual(3)
    expect(mkus.find((m) => m.text.includes('已知'))?.kind).toBe('exampleProblem')
    const type = classifyType(extractFeatures(doc))
    expect(type.type).toBe('example')
    const plan = compileLesson({
      lessonId: 'l',
      lessonTitle: 'e',
      lessonPath: 'e.md',
      doc,
      mkus,
      type,
    })
    expect(plan.sections.filter((s) => s.role === '分步解答').length).toBeGreaterThanOrEqual(3)
  })
})

describe('K2 校准：章末考点总结表格页（真实笔记样式 E）', () => {
  const text = [
    '# 本章常见考点与典型题型总结',
    '',
    '| 考点与题型 | 核心解题策略 |',
    '| :-- | :-- |',
    '| **1. 求逆矩阵** | 构造 $(A, E)$ 作初等行变换。 |',
    '| **2. 求秩** | 化为行阶梯形数非零行。 |',
  ].join('\n')

  it('H1「本章」开头 → 导学/总结页 → generic，表格进讲解不进转写', () => {
    const doc = parseDoc(text)
    const type = classifyType(extractFeatures(doc))
    expect(type.type).toBe('generic')
    const mkus = segmentMkus(doc, 'f.md')
    const plan = compileLesson({
      lessonId: 'l',
      lessonTitle: 'f',
      lessonPath: 'f.md',
      doc,
      mkus,
      type,
    })
    const lectures = plan.sections.filter((s) => s.role === '讲解')
    expect(lectures.length).toBeGreaterThanOrEqual(1)
    expect(lectures.some((s) => s.content.includes('求逆矩阵'))).toBe(true)
    expect(plan.promptText).not.toContain('原文无可识别')
  })
})
