/** P3d：提示词编译器（A/B/C 分级、溯源强制、三类课型策略、护栏、无 C 段） */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classifyType, extractFeatures } from '../src/core/classify/type'
import { compileLesson } from '../src/core/compile/compile'
import { segmentMkus } from '../src/core/model/mku'
import { parseDoc } from '../src/core/parse/parse'

const COURSE_DIR = join(__dirname, 'fixtures', 'synthetic-course', '高中数学', '第1章-集合与函数')

function compileFile(name: string, lessonId: string, extra: Record<string, unknown> = {}) {
  const path = `${name}.md`
  const text = readFileSync(join(COURSE_DIR, path), 'utf-8')
  const doc = parseDoc(text)
  const features = extractFeatures(doc)
  const type = classifyType(features)
  const mkus = segmentMkus(doc, path)
  const plan = compileLesson({
    lessonId,
    lessonTitle: name,
    lessonPath: path,
    doc,
    mkus,
    type,
    ...(extra as any),
  })
  return { doc, features, type, mkus, plan }
}

describe('T1 溯源与 T2 无 C 段（跨三类课型）', () => {
  for (const [name, id] of [
    ['L01-函数的概念', 'lesson-1'],
    ['L02-二次函数顶点公式的推导', 'lesson-2'],
    ['L03-二次函数例题', 'lesson-3'],
  ] as const) {
    it(`${name}：A 段全部可解析、零 C 段、覆盖三态报告`, () => {
      const { plan, mkus } = compileFile(name, id)
      // T2：默认零 C 段
      expect(plan.sections.filter((s) => s.contentType === 'C')).toHaveLength(0)
      // T1：A 段 trace 全部落在该文件的 MKU 区间内
      for (const s of plan.sections) {
        if (s.contentType !== 'A') continue
        expect(s.traces.length).toBeGreaterThan(0)
        for (const tr of s.traces) {
          const hit = mkus.find((m) => m.span.start <= tr.start && tr.end <= m.span.end)
          expect(hit, `A 段 ${s.sectionId} trace [${tr.start},${tr.end}) 无法解析`).toBeDefined()
        }
      }
      // 覆盖报告结构（K1）
      expect(plan.coverage.coreTotal).toBeGreaterThan(0)
      expect(plan.coverage.coreHandled).toBeLessThanOrEqual(plan.coverage.coreTotal)
      expect(plan.coverage.uncovered.length).toBe(
        plan.coverage.coreTotal - plan.coverage.coreHandled,
      )
      // 提示词文本：脚手架固定部分
      expect(plan.promptText).toContain('【角色】')
      expect(plan.promptText).toContain('【课题】')
      expect(plan.promptText).toContain('【课堂流程】')
      expect(plan.promptText).toContain('【输出要求】')
    })
  }
})

describe('三类课型差异化', () => {
  it('概念课：定义逐字引用 + 即时检测（B 段引用定义 trace）', () => {
    const { plan, type } = compileFile('L01-函数的概念', 'lesson-1')
    expect(type.type).toBe('concept')
    expect(plan.type).toBe('concept')
    const defSections = plan.sections.filter((s) => s.role === '核心定义')
    expect(defSections.length).toBeGreaterThanOrEqual(1)
    // A 级定义段内容为原文（逐字）
    expect(defSections[0]!.content).toContain('非空的数集')
    expect(defSections[0]!.contentType).toBe('A')
    // B 级即时检测引用定义
    const check = plan.sections.find((s) => s.role === '即时检测')
    expect(check).toBeDefined()
    expect(check!.contentType).toBe('B')
    expect(check!.basis).toContain('quickcheck')
    expect(check!.traces.length).toBeGreaterThan(0)
  })

  it('推导课：分步 + 预测设问（选项为原文后续步骤）+ 公式逐字', () => {
    const { plan } = compileFile('L02-二次函数顶点公式的推导', 'lesson-2')
    expect(plan.type).toBe('derivation')
    const steps = plan.sections.filter(
      (s) => s.role.startsWith('分步推导·第') && s.contentType === 'A',
    )
    expect(steps.length).toBeGreaterThanOrEqual(3)
    const predicts = plan.sections.filter((s) => s.role.includes('预测'))
    expect(predicts.length).toBeGreaterThanOrEqual(1)
    expect(predicts[0]!.contentType).toBe('B')
    // 目标命题含公式 LaTeX 原文
    const goal = plan.sections.find((s) => s.role === '目标命题')
    expect(goal).toBeDefined()
    expect(goal!.content).toContain('4a')
    // 前置回顾来自双链（B 段，trace 指向链接 span）
    const prereq = plan.sections.find((s) => s.role === '前置回顾')
    expect(prereq).toBeDefined()
    expect(prereq!.content).toContain('配方法')
    // 易错提醒来自原文注意段（A 级）
    const caution = plan.sections.find((s) => s.role === '易错提醒')
    expect(caution).toBeDefined()
    expect(caution!.content).toContain('遗漏除以')
  })

  it('例题课：先试一试 + 分步解答 + 练习不足注记（不虚构）', () => {
    const { plan } = compileFile('L03-二次函数例题', 'lesson-3')
    expect(plan.type).toBe('example')
    expect(plan.sections.some((s) => s.role === '先自己试一试')).toBe(true)
    const solutions = plan.sections.filter((s) => s.role === '分步解答')
    expect(solutions.length).toBeGreaterThanOrEqual(2)
    // 原文有练习 → 同类练习为 A 级逐字
    const practices = plan.sections.filter((s) => s.role === '同类练习')
    expect(practices.length).toBeGreaterThanOrEqual(1)
    expect(practices[0]!.contentType).toBe('A')
    expect(practices[0]!.content).toContain('练习 1')
    // 易错点来自原文
    const pitfall = plan.sections.find((s) => s.role === '易错点')
    expect(pitfall!.content).toContain('配方时忘记二次项系数')
  })

  it('练习不足时注记而非编造（负向）', () => {
    const text = '# 例题\n\n例 1 求 $y=x^2$ 的顶点。\n\n解：配方得 $(x-1)^2$，顶点 $(1,0)$。'
    const doc = parseDoc(text)
    const type = classifyType(extractFeatures(doc))
    const mkus = segmentMkus(doc, 'x.md')
    const plan = compileLesson({
      lessonId: 'l',
      lessonTitle: 'x',
      lessonPath: 'x.md',
      doc,
      mkus,
      type,
    })
    const practice = plan.sections.find((s) => s.role === '同类练习')!
    expect(practice.note ?? practice.content).toContain('练习不足')
  })

  it('generic 兜底：核心 MKU 依序讲解', () => {
    const text = '第一段要点。\n\n第二段要点。'
    const doc = parseDoc(text)
    const type = classifyType(extractFeatures(doc))
    expect(type.type).toBe('generic')
    const mkus = segmentMkus(doc, 'g.md')
    const plan = compileLesson({
      lessonId: 'l',
      lessonTitle: 'g',
      lessonPath: 'g.md',
      doc,
      mkus,
      type,
    })
    expect(plan.type).toBe('generic')
    expect(plan.sections.some((s) => s.role === '课堂小结')).toBe(true)
  })
})

describe('护栏', () => {
  it('用户排除：进入覆盖报告 excluded 且不计入未纳入', () => {
    const { plan, mkus } = compileFile('L01-函数的概念', 'lesson-1')
    const target = mkus.find((m) => m.kind === 'definition')!
    const { plan: plan2 } = compileFile('L01-函数的概念', 'lesson-1', {
      exclusions: [{ mkuId: target.id, reason: '教师决定略讲' }],
    })
    expect(plan2.coverage.excluded).toHaveLength(1)
    expect(plan2.coverage.excluded[0]!.reason).toBe('教师决定略讲')
    // 排除后 coreHandled 计算不包含它
    expect(plan2.coverage.coreTotal).toBe(plan.coverage.coreTotal)
    expect(plan.coverage.excluded).toHaveLength(0)
  })

  it('长度软预算：超预算产生警告但不截断', () => {
    const { plan } = compileFile('L02-二次函数顶点公式的推导', 'lesson-2', {
      settings: { lengthBudget: 100 },
    })
    expect(plan.warnings.some((w) => w.includes('软预算'))).toBe(true)
    expect(plan.promptText.length).toBeGreaterThan(100)
  })

  it('编译器版本与提示词结构版本随计划记录', () => {
    const { plan } = compileFile('L01-函数的概念', 'lesson-1')
    expect(plan.compilerVersion).toBeGreaterThan(0)
    expect(plan.promptSchemaVersion).toBeGreaterThan(0)
  })
})
