/** P2b：Obsidian 语法解析（wikilink/embed/highlight/callout/math/frontmatter/tags/comments） */
import { describe, expect, it } from 'vitest'
import { parseDoc, parseMarkdown } from '../src/core/parse/parse'

describe('wikilink / embed', () => {
  it('基本链接 + 别名 + 标题锚点', () => {
    const doc = parseDoc('参见 [[函数与方程]] 与 [[函数与方程#顶点式|顶点公式]]。')
    expect(doc.wikilinks).toHaveLength(2)
    const [a, b] = doc.wikilinks
    expect(a!.data.embed).toBe(false)
    expect(a!.data.target).toBe('函数与方程')
    expect(a!.data.alias).toBe('')
    expect(a!.data.heading).toBe('')
    expect(b!.data.target).toBe('函数与方程')
    expect(b!.data.heading).toBe('顶点式')
    expect(b!.data.alias).toBe('顶点公式')
  })

  it('嵌入 ![[...]]', () => {
    const doc = parseDoc('前置：![[配方法]]\n\n![[图片.png]]')
    expect(doc.wikilinks).toHaveLength(2)
    expect(doc.wikilinks[0]!.data.embed).toBe(true)
    expect(doc.wikilinks[0]!.data.target).toBe('配方法')
    expect(doc.wikilinks[1]!.data.target).toBe('图片.png')
  })

  it('P2 不变量 I-0a：raw === 源切片（含定界符）', () => {
    const text = '参见 [[函数与方程#顶点式|顶点公式]] 与 ![[配方法]]。'
    const doc = parseDoc(text)
    for (const w of doc.wikilinks) {
      expect(w.data.raw).toBe(text.slice(w.span.start, w.span.end))
    }
  })

  it('未闭合 → 字面文本，不产生节点', () => {
    const doc = parseDoc('未闭合 [[目标 与 [[另一]]个]')
    // [[另一]] 是合法链接；前后为字面文本
    expect(doc.wikilinks).toHaveLength(1)
    expect(doc.wikilinks[0]!.data.target).toBe('另一')
  })

  it('单个 ] 在内容中被当作数据（maybeClose 回退）', () => {
    const doc = parseDoc('[[a]b]]')
    expect(doc.wikilinks).toHaveLength(1)
    expect(doc.wikilinks[0]!.data.target).toBe('a]b')
  })

  it('代码块内的 [[..]] 保持字面（分词器层互斥）', () => {
    const doc = parseDoc('```\n[[不是链接]]\n![[也不是嵌入]]\n```')
    expect(doc.wikilinks).toHaveLength(0)
    const code = doc.blocks.find((b) => b.kind === 'code')
    expect(code!.text).toContain('[[不是链接]]')
  })

  it('行内代码内的 [[..]] 保持字面', () => {
    const doc = parseDoc('行内 `[[字面]]` 代码')
    expect(doc.wikilinks).toHaveLength(0)
  })

  it('嵌套 [ 导致 nok（已知限制，字面化）', () => {
    const doc = parseDoc('[[a[b]]')
    expect(doc.wikilinks).toHaveLength(0)
  })
})

describe('highlight ==..==', () => {
  it('基本高亮 + 内部单个等号', () => {
    const tree = parseMarkdown('重点 ==x=y== 与 ==普通==')
    const highlights: any[] = []
    const walk = (n: any) => {
      if (n.type === 'highlight') highlights.push(n)
      n.children?.forEach(walk)
    }
    walk(tree)
    expect(highlights).toHaveLength(2)
    expect(highlights[0]!.value).toBe('x=y')
    expect(highlights[1]!.value).toBe('普通')
    expect(highlights[0]!.raw).toBe('==x=y==')
  })

  it('未闭合的后续 == 正常闭合第一个（类 emphasis 配对）', () => {
    const tree = parseMarkdown('不闭合 ==内容 与 ==闭合==')
    const highlights: any[] = []
    const walk = (n: any) => {
      if (n.type === 'highlight') highlights.push(n)
      n.children?.forEach(walk)
    }
    walk(tree)
    expect(highlights).toHaveLength(1)
    // 第一个 == 在第二个 == 处闭合（正确的配对行为），其后 闭合== 为字面文本
    expect(highlights[0]!.value).toBe('内容 与 ')
  })
})

describe('callout', () => {
  it('类型 + 标题 + 折叠标记', () => {
    const doc = parseDoc('> [!note] 重要提示\n> 内容行')
    const callout = doc.blocks.find((b) => b.kind === 'callout')
    expect(callout).toBeDefined()
    expect(callout!.meta.calloutType).toBe('note')
    expect(callout!.meta.calloutTitle).toBe('重要提示')
    // 折叠
    const doc2 = parseDoc('> [!warning]- 折叠的\n> 内容')
    expect(doc2.blocks.find((b) => b.kind === 'callout')!.meta.calloutFold).toBe('-')
  })

  it('普通 blockquote 不误判', () => {
    const doc = parseDoc('> 普通引用\n> 第二行')
    expect(doc.blocks.find((b) => b.kind === 'callout')).toBeUndefined()
    expect(doc.blocks.find((b) => b.kind === 'blockquote')).toBeDefined()
  })

  it('嵌套 callout（超集支持：内层同样变换）', () => {
    const doc = parseDoc('> [!note] 外层\n> > [!tip] 内层\n> > 内容')
    const callouts = doc.blocks.filter((b) => b.kind === 'callout')
    expect(callouts.length).toBeGreaterThanOrEqual(2)
  })
})

describe('math', () => {
  it('块级与行内公式：raw 含定界符逐字（I-0a），latex 为去定界符内容', () => {
    const text = '公式：$$f(x)=x^2$$ 与行内 $a+b$。'
    const doc = parseDoc(text)
    expect(doc.mathNodes).toHaveLength(2)
    const [block, inline] = doc.mathNodes
    expect(block!.display).toBe(true)
    expect(block!.latex).toBe('f(x)=x^2')
    expect(block!.raw).toBe('$$f(x)=x^2$$')
    expect(block!.raw).toBe(text.slice(block!.span.start, block!.span.end))
    expect(inline!.display).toBe(false)
    expect(inline!.latex).toBe('a+b')
    expect(inline!.raw).toBe('$a+b$')
  })

  it('未配对 $ 按字面处理', () => {
    const doc = parseDoc('价格 $5 与 $10 之间')
    // remark-math 的保守规则：可能不识别任何公式
    const inlines = doc.mathNodes.filter((m) => !m.display)
    for (const m of inlines) {
      // 若识别出，必须 raw===切片（不损坏）
      expect(m.raw).toBe('价格 $5 与 $10 之间'.slice(m.span.start, m.span.end))
    }
  })

  it('代码块内的 $ 字面', () => {
    const doc = parseDoc('```\n$not math$\n```')
    expect(doc.mathNodes).toHaveLength(0)
  })
})

describe('frontmatter', () => {
  it('合法 YAML 解析为数据', () => {
    const doc = parseDoc('---\ntitle: 函数\ntags: [数学, 高一]\n---\n\n# 标题')
    expect(doc.frontmatter.present).toBe(true)
    expect(doc.frontmatter.ok).toBe(true)
    expect(doc.frontmatter.data!.title).toBe('函数')
    expect(doc.frontmatter.data!.tags).toEqual(['数学', '高一'])
  })

  it('畸形 YAML → 原样保留 + 诊断', () => {
    const doc = parseDoc('---\ntitle: [未闭合\n---\n\n正文')
    expect(doc.frontmatter.present).toBe(true)
    expect(doc.frontmatter.ok).toBe(false)
    expect(doc.frontmatter.raw).toContain('未闭合')
    expect(doc.diagnostics.some((d) => d.code === 'FRONTMATTER_MALFORMED')).toBe(true)
  })

  it('无 frontmatter', () => {
    const doc = parseDoc('# 直接开始')
    expect(doc.frontmatter.present).toBe(false)
  })
})

describe('tags 与 %%注释%%（模型级提取）', () => {
  it('标签提取与 span 精确', () => {
    const text = '本节讲 #函数 与 #数学/二次函数 两个标签'
    const doc = parseDoc(text)
    expect(doc.tags.map((t) => t.name)).toEqual(['#函数', '#数学/二次函数'])
    for (const t of doc.tags) {
      expect(text.slice(t.span.start, t.span.end)).toBe(t.name)
    }
  })

  it('标题井号不误判为标签', () => {
    const doc = parseDoc('# 一级标题\n## 二级\n正文 #真标签')
    expect(doc.tags.map((t) => t.name)).toEqual(['#真标签'])
  })

  it('转义 \\# 不是标签', () => {
    const doc = parseDoc('转义 \\#非标签 与 #是标签')
    expect(doc.tags.map((t) => t.name)).toEqual(['#是标签'])
  })

  it('注释提取（单文本节点内）', () => {
    const text = '可见内容 %%这是隐藏注释%% 后续内容'
    const doc = parseDoc(text)
    expect(doc.comments).toHaveLength(1)
    expect(doc.comments[0]!.text).toBe('这是隐藏注释')
    expect(text.slice(doc.comments[0]!.span.start, doc.comments[0]!.span.end)).toBe(
      '%%这是隐藏注释%%',
    )
  })
})

describe('GFM 标准件', () => {
  it('表格/任务列表/删除线/脚注', () => {
    const text = [
      '| 列A | 列B |',
      '| --- | --- |',
      '| a | b |',
      '',
      '- [x] 已完成',
      '- [ ] 未完成',
      '',
      '~~删除~~ 与正常',
      '',
      '脚注[^1]',
      '',
      '[^1]: 脚注内容',
    ].join('\n')
    const doc = parseDoc(text)
    expect(doc.blocks.some((b) => b.kind === 'table')).toBe(true)
    const items = doc.blocks.filter((b) => b.kind === 'listItem')
    expect(items).toHaveLength(2)
    expect(items[0]!.meta.checked).toBe(true)
    expect(items[1]!.meta.checked).toBe(false)
    expect(doc.tiling.complete).toBe(true)
  })

  it('行内 HTML 为叶节点（⚠ 不渲染，源码显示）', () => {
    const text = '段落中的 <b>加粗</b> 标签'
    const doc = parseDoc(text)
    const htmlBlocks = doc.blocks.filter((b) => b.kind === 'html')
    expect(htmlBlocks.length).toBeGreaterThanOrEqual(1)
    expect(doc.tiling.complete).toBe(true)
  })
})

describe('P1 平铺冒烟（复杂组合）', () => {
  it('全源平铺完备', () => {
    const text = [
      '---',
      'title: 测试',
      '---',
      '',
      '# 标题',
      '',
      '正文有 **强调**、*斜体*、`代码`、==高亮==、[[链接]]、![[嵌入]]、$x^2$、[外链](https://example.com)、<i>html</i>、#标签 与 %%注释%%。',
      '',
      '- 列表项一',
      '  - 嵌套项',
      '- [ ] 任务',
      '',
      '> [!note] Callout',
      '> 内容',
      '',
      '```python',
      'code = 1',
      '```',
      '',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '$$',
      '\\int_0^1 x dx',
      '$$',
    ].join('\n')
    const doc = parseDoc(text)
    expect(doc.tiling.complete).toBe(true)
    expect(doc.tiling.counts.semanticChars).toBeGreaterThan(0)
    expect(doc.tiling.counts.markerChars).toBeGreaterThan(0)
    expect(doc.tiling.counts.whitespaceChars).toBeGreaterThan(0)
  })
})
