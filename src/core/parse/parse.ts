/**
 * Obsidian 方言解析管线（架构基线 §5/§6）。
 *
 * 解析（D）：fromMarkdown + GFM + math + frontmatter + 自研 Obsidian 扩展。
 * 后处理（D）：Callout 变换（只改类型/数据，不改位置）、标签与注释的模型级提取
 * （切片级正则，AST 不动——规避位置手术，P3 value 规则因此恒成立）、
 * 数学节点 raw 捕获（P2：raw === 源切片）。
 * 全源平铺（P1）：mdast 位置残差推导。
 */
import { fromMarkdown } from 'mdast-util-from-markdown'
import { frontmatter } from 'micromark-extension-frontmatter'
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter'
import { gfm } from 'micromark-extension-gfm'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { math } from 'micromark-extension-math'
import { mathFromMarkdown } from 'mdast-util-math'
import { parse as parseYaml } from 'yaml'
import type { ImportDiagnostic, Span } from '../types'
import { obsidianFromMarkdown, obsidianSyntax, type ObsidianData } from './obsidian'
import { buildTiling, type TilingResult } from './tiling'

export type MathNode = { type: 'math' | 'inlineMath'; value: string; position?: any; raw?: string }
export type ObsidianNode = {
  type: 'wikiLink' | 'wikiEmbed'
  data?: ObsidianData
  position?: any
}

interface MdNode {
  type: string
  value?: string
  depth?: number
  lang?: string
  meta?: string
  ordered?: boolean
  start?: number | null
  checked?: boolean | null
  align?: any
  data?: any
  children?: MdNode[]
  position?: { start: { offset?: number }; end: { offset?: number } }
}

export interface Block {
  id: string
  span: Span
  kind:
    | 'frontmatter'
    | 'heading'
    | 'paragraph'
    | 'code'
    | 'math'
    | 'list'
    | 'listItem'
    | 'table'
    | 'callout'
    | 'blockquote'
    | 'html'
    | 'thematicBreak'
  text: string
  meta: {
    depth?: number
    lang?: string
    ordered?: boolean
    checked?: boolean | null
    calloutType?: string
    calloutTitle?: string
    calloutFold?: string
  }
}

export interface WikiLinkRef {
  span: Span
  data: ObsidianData
}

export interface TagRef {
  span: Span
  name: string
}

export interface ParsedDoc {
  tree: any
  tiling: TilingResult
  blocks: Block[]
  wikilinks: WikiLinkRef[]
  mathNodes: { span: Span; display: boolean; latex: string; raw: string }[]
  tags: TagRef[]
  comments: { span: Span; text: string }[]
  frontmatter: { present: boolean; ok: boolean; data: Record<string, any> | null; raw: string }
  diagnostics: ImportDiagnostic[]
}

export function parseMarkdown(text: string): any {
  return fromMarkdown(text, {
    extensions: [frontmatter(['yaml']), gfm(), math(), obsidianSyntax()],
    mdastExtensions: [
      frontmatterFromMarkdown(['yaml']),
      gfmFromMarkdown(),
      mathFromMarkdown(),
      obsidianFromMarkdown(),
    ],
  })
}

function offsets(node: MdNode): [number, number] | null {
  const p = node.position
  if (!p || p.start?.offset === undefined || p.end?.offset === undefined) return null
  return [p.start.offset, p.end.offset]
}

/** Callout 变换：`> [!type] 标题` 的 blockquote → callout 节点（位置不变，子树不动） */
function transformCallouts(node: MdNode): void {
  if (!node.children) return
  for (const child of node.children) {
    if (child.type === 'blockquote') {
      const first = child.children?.[0]
      if (first && first.type === 'paragraph') {
        const firstText = first.children?.find((c) => c.type === 'text')
        if (firstText && typeof firstText.value === 'string') {
          const m = /^\[!([\w-]+)\]([+-])?[ \t]*(.*)/.exec(firstText.value)
          if (m) {
            child.type = 'callout'
            child.data = {
              ...(child.data ?? {}),
              calloutType: m[1],
              calloutFold: m[2] ?? null,
              calloutTitle: m[3] ?? '',
            }
          }
        }
      }
    }
    transformCallouts(child)
  }
}

/** 切片级标签提取：#tag（AST 不动，span 由切片索引 1:1 映射；前置须为行首或非词/非反斜杠/非#字符） */
const TAG_RE = /(^|[^\w\\#])(#[\w\u4e00-\u9fff][\w\u4e00-\u9fff/-]*)/g

function extractTags(nodes: MdNode[], text: string, out: TagRef[], diags: ImportDiagnostic[]) {
  for (const node of nodes) {
    if (node.type === 'text' && typeof node.value === 'string') {
      const span = offsets(node)
      if (!span) continue
      const slice = text.slice(span[0], span[1])
      TAG_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = TAG_RE.exec(slice))) {
        const tagName = m[2]!
        if (tagName.length < 2) continue
        const rel = m.index + m[1]!.length
        out.push({
          span: { start: span[0] + rel, end: span[0] + rel + tagName.length },
          name: tagName,
        })
      }
    }
    if (node.children) extractTags(node.children, text, out, diags)
  }
}

/** 切片级注释提取：%%...%%（仅单文本节点内，跨节点为已知限制） */
const COMMENT_RE = /%%([\s\S]*?)%%/g

function extractComments(nodes: MdNode[], text: string, out: { span: Span; text: string }[]) {
  for (const node of nodes) {
    if (node.type === 'text' && typeof node.value === 'string') {
      const span = offsets(node)
      if (!span) continue
      const slice = text.slice(span[0], span[1])
      COMMENT_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = COMMENT_RE.exec(slice))) {
        out.push({
          span: { start: span[0] + m.index, end: span[0] + m.index + m[0].length },
          text: m[1] ?? '',
        })
      }
    }
    if (node.children) extractComments(node.children, text, out)
  }
}

let blockSeq = 0

function collectBlocks(node: MdNode, text: string, out: Block[]): void {
  const span = offsets(node)
  const kindMap: Record<string, Block['kind']> = {
    yaml: 'frontmatter',
    heading: 'heading',
    paragraph: 'paragraph',
    code: 'code',
    math: 'math',
    list: 'list',
    listItem: 'listItem',
    table: 'table',
    callout: 'callout',
    blockquote: 'blockquote',
    html: 'html',
    thematicBreak: 'thematicBreak',
  }
  if (span && kindMap[node.type]) {
    out.push({
      id: `b${blockSeq++}`,
      span: { start: span[0], end: span[1] },
      kind: kindMap[node.type]!,
      text: text.slice(span[0], span[1]),
      meta: {
        depth: node.depth,
        lang: node.lang ?? undefined,
        ordered: node.ordered,
        checked: node.checked ?? null,
        calloutType: node.data?.calloutType,
        calloutTitle: node.data?.calloutTitle,
        calloutFold: node.data?.calloutFold,
      },
    })
  }
  // 下钻以收集容器内块（listItem 等）与段落内的 inline html（内联节点中仅 html 进入 kindMap）
  if (node.children) {
    for (const child of node.children) collectBlocks(child, text, out)
  }
}

export function parseDoc(text: string): ParsedDoc {
  blockSeq = 0
  const diagnostics: ImportDiagnostic[] = []
  const tree = parseMarkdown(text) as MdNode
  transformCallouts(tree)

  // 平铺（P1 不变量）
  const tiling = buildTiling(tree as any, text)
  if (!tiling.complete) {
    diagnostics.push({
      code: 'PARSE_TILING_INCOMPLETE',
      severity: 'error',
      message: `全源平铺未铺满：${tiling.violations.length} 处违规`,
      detail: tiling.violations
        .slice(0, 5)
        .map((v) => `${v.kind}: ${v.detail}`)
        .join('；'),
    })
  }

  // frontmatter
  let fm: ParsedDoc['frontmatter'] = { present: false, ok: false, data: null, raw: '' }
  const yamlNode = tree.children?.find((c) => c.type === 'yaml')
  if (yamlNode) {
    fm = { present: true, ok: false, data: null, raw: yamlNode.value ?? '' }
    try {
      const data = parseYaml(yamlNode.value ?? '')
      fm = { ...fm, ok: true, data: typeof data === 'object' && data !== null ? data : {} }
    } catch {
      diagnostics.push({
        code: 'FRONTMATTER_MALFORMED',
        severity: 'warn',
        message: 'YAML frontmatter 解析失败，已原样保留',
      })
    }
  }

  // wikilink / embed
  const wikilinks: WikiLinkRef[] = []
  // math
  const mathNodes: ParsedDoc['mathNodes'] = []
  const walk = (node: MdNode) => {
    if (node.type === 'wikiLink' || node.type === 'wikiEmbed') {
      const span = offsets(node)
      if (span && node.data) {
        wikilinks.push({
          span: { start: span[0], end: span[1] },
          data: { ...node.data, raw: node.data.raw },
        })
      }
    }
    if (node.type === 'math' || node.type === 'inlineMath') {
      const span = offsets(node)
      if (span) {
        const raw = text.slice(span[0], span[1])
        // micromark-extension-math 将 $$..$$ 也标为 inlineMath，display 依 raw 前缀判定（更稳健）
        mathNodes.push({
          span: { start: span[0], end: span[1] },
          display: raw.startsWith('$$'),
          latex: node.value ?? '',
          raw,
        })
      }
    }
    if (node.children) for (const child of node.children) walk(child)
  }
  walk(tree)

  // 标签 / 注释（模型级）
  const tags: TagRef[] = []
  extractTags(tree.children ?? [], text, tags, diagnostics)
  const comments: { span: Span; text: string }[] = []
  extractComments(tree.children ?? [], text, comments)

  // 块
  const blocks: Block[] = []
  collectBlocks(tree, text, blocks)

  return {
    tree,
    tiling,
    blocks,
    wikilinks,
    mathNodes,
    tags,
    comments,
    frontmatter: fm,
    diagnostics,
  }
}
