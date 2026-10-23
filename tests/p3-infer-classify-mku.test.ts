/** P3：结构推断 / 课型分类 / MKU 切分 */
import { describe, expect, it } from 'vitest'
import { classifyType, extractFeatures } from '../src/core/classify/type'
import { computeCoverage, segmentMkus } from '../src/core/model/mku'
import { parseDoc } from '../src/core/parse/parse'
import { inferStructure, type FileSignal } from '../src/core/structure/infer'

function signalsOf(paths: string[]): FileSignal[] {
  // 不提供 H1（走文件名回退路径，验证课时编号前缀剥离）
  return paths.map((p) => ({ normPath: p, headings: [] }))
}

describe('P3a 结构推断', () => {
  it('目录即章节 + 课时编号前缀剥离', () => {
    const files = signalsOf([
      '高中数学/第1章-集合与函数/L01-函数的概念.md',
      '高中数学/第1章-集合与函数/L02-单调性.md',
      '高中数学/第2章-基本初等函数/L01-指数函数.md',
    ])
    const s = inferStructure(files, '导入根')
    // 单一根目录含 3 个 md → 该目录为课程
    expect(s.name).toBe('高中数学')
    expect(s.chapters).toHaveLength(2)
    const ch1 = s.chapters[0]!
    expect(ch1.name).toBe('第1章-集合与函数')
    expect(ch1.lessons.map((l) => l.title)).toEqual(['函数的概念', '单调性'])
    expect(ch1.evidence.some((e) => e.includes('章节模式'))).toBe(true)
  })

  it('单一根目录 <3 文件时不提升为课程', () => {
    const files = signalsOf(['课程A/x.md', '课程A/y.md'])
    const s = inferStructure(files, '我的导入')
    expect(s.name).toBe('我的导入')
    expect(s.chapters[0]!.name).toBe('课程A')
  })

  it('根目录散落文件 → rootLessons + 证据', () => {
    const files = signalsOf(['a.md', 'b.md', '第1章/c.md'])
    const s = inferStructure(files, '根')
    expect(s.rootLessons).toHaveLength(2)
    expect(s.chapters).toHaveLength(1)
    expect(s.evidence.some((e) => e.includes('散落'))).toBe(true)
  })

  it('frontmatter title 优先于文件名/H1', () => {
    const files: FileSignal[] = [
      {
        normPath: 'x/n1.md',
        headings: [{ depth: 1, text: 'H1标题' }],
        frontmatter: { title: 'FM标题' },
      },
    ]
    const s = inferStructure(files, 'r')
    expect(s.chapters[0]!.lessons[0]!.title).toBe('FM标题')
  })

  it('嵌套目录为嵌套章节', () => {
    const files = signalsOf(['课程/第1章/1.1-小节/a.md'])
    const s = inferStructure(files, 'r')
    const sub = s.chapters[0]!.subChapters[0]!.subChapters[0]!
    expect(sub.name).toBe('1.1-小节')
    expect(sub.lessons[0]!.title).toBe('a')
  })
})

describe('P3b 课型分类', () => {
  it('概念课', () => {
    const doc = parseDoc(
      '函数的定义：设 A、B 是非空数集……称之为函数。\n\n其中 x 叫做自变量。\n\n例如 f(x)=x。',
    )
    const d = classifyType(extractFeatures(doc))
    expect(d.type).toBe('concept')
    expect(d.evidence.join()).toContain('定义信号')
  })

  it('推导课：步骤链 + 证明 + 公式块', () => {
    const text = [
      '## 推导',
      '',
      '证明：',
      '',
      '1. 第一步，即得 $a$',
      '2. 第二步，从而 $b$',
      '3. 第三步，故结论成立',
      '',
      '$$',
      'x = y',
      '$$',
    ].join('\n')
    const doc = parseDoc(text)
    const d = classifyType(extractFeatures(doc))
    expect(d.type).toBe('derivation')
  })

  it('例题课', () => {
    const doc = parseDoc(
      '例 1 求 $y=x^2$ 的顶点。\n\n解：配方得 $(x-1)^2$。\n\n例 2 求 $y=2x$ 的对称轴。\n\n解：代入公式。',
    )
    const d = classifyType(extractFeatures(doc))
    expect(d.type).toBe('example')
  })

  it('信号全弱 → generic 兜底（不阻断）', () => {
    const doc = parseDoc('这是一段普通文字，没有任何课型信号。')
    const d = classifyType(extractFeatures(doc))
    expect(d.type).toBe('generic')
    expect(d.ambiguous).toBe(false)
  })

  it('分差过小 → ambiguous 阻断标记', () => {
    const doc = parseDoc('例 1 求 x。') // example 3 分，其余 0——构造接近场景需两项并列
    const f = extractFeatures(doc)
    const d = classifyType({ ...f, conceptSignals: 1.5 }) // 人为并列
    expect(d.ambiguous).toBe(true)
  })
})

describe('P3c MKU 切分', () => {
  it('合成概念课：定义/属性/背景分层', () => {
    const text = [
      '在初中我们学过变量关系。',
      '',
      '函数的定义：设 A、B 是非空数集，则称之为函数。',
      '',
      '其中 x 叫做自变量。',
      '',
      '例如 f(x)=x。',
    ].join('\n')
    const doc = parseDoc(text)
    const mkus = segmentMkus(doc, 'x.md')
    const kinds = mkus.map((m) => m.kind)
    expect(kinds).toContain('background')
    expect(kinds).toContain('definition')
    expect(kinds).toContain('property') // 其中
    const def = mkus.find((m) => m.kind === 'definition')!
    expect(def.tier).toBe('core')
    expect(def.text).toContain('称之为函数')
  })

  it('合成推导课：公式块/推导步骤/注意', () => {
    const text = [
      '## 推导过程',
      '',
      '证明：对一般二次函数求顶点。',
      '',
      '1. 提出二次项系数',
      '2. 配方',
      '3. 取最小值',
      '',
      '$$(-b/2a, (4ac-b^2)/4a)$$',
      '',
      '其中，a 决定开口方向。',
      '',
      '注意：配方时系数容易遗漏。',
    ].join('\n')
    const doc = parseDoc(text)
    const mkus = segmentMkus(doc, 'd.md')
    expect(mkus.filter((m) => m.kind === 'formula')).toHaveLength(1)
    expect(mkus.filter((m) => m.kind === 'derivationStep').length).toBeGreaterThanOrEqual(3)
    expect(mkus.find((m) => m.kind === 'caution')).toBeDefined()
    expect(mkus.find((m) => m.kind === 'property')).toBeDefined()
  })

  it('合成例题课：例题/解答/练习区域', () => {
    const text = [
      '## 例题',
      '',
      '例 1 求 $y = 2x^2$ 的顶点。',
      '',
      '解：配方得结果。',
      '',
      '法二：公式法说明。',
      '',
      '## 练习',
      '',
      '练习 1 求 $y = 3x^2$ 的顶点。',
    ].join('\n')
    const doc = parseDoc(text)
    const mkus = segmentMkus(doc, 'e.md')
    // 例 1 → exampleProblem；解： → exampleSolution；法二 → inExample 区域延续
    expect(mkus.filter((m) => m.kind === 'exampleProblem').length).toBeGreaterThanOrEqual(2)
    expect(mkus.filter((m) => m.kind === 'exampleSolution')).toHaveLength(1)
    expect(mkus.filter((m) => m.kind === 'exercise')).toHaveLength(1)
  })

  it('代码块 → 背景层；注释 → 作者注', () => {
    const text = ['```python', 'x = 1', '```', '', '可见 %%隐藏批注%% 内容'].join('\n')
    const doc = parseDoc(text)
    const mkus = segmentMkus(doc, 'c.md')
    expect(mkus.find((m) => m.kind === 'code')!.tier).toBe('background')
    expect(mkus.find((m) => m.kind === 'authorNote')).toBeDefined()
  })

  it('覆盖三态：included / excluded（用户+理由）/ uncovered', () => {
    const doc = parseDoc('定义：A 称之为 B。\n\n普通背景段。')
    const mkus = segmentMkus(doc, 'x.md')
    const def = mkus.find((m) => m.kind === 'definition')!
    const covered = computeCoverage(mkus, [{ file: 'x.md', span: def.span }], 'x.md', [])
    expect(covered.find((c) => c.mku.kind === 'definition')!.state).toBe('included')
    expect(covered.find((c) => c.mku.kind === 'background')!.state).toBe('uncovered')
    const withEx = computeCoverage(mkus, [], 'x.md', [
      { mkuId: mkus[0]!.id, reason: '教师决定略讲' },
    ])
    expect(withEx[0]!.state).toBe('excluded')
    expect(withEx[0]!.reason).toBe('教师决定略讲')
  })
})
