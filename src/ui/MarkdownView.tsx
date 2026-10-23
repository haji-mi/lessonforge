/**
 * Markdown 预览渲染器（P2d）：
 * - 自建 React 组件树，无 dangerouslySetInnerHTML（KaTeX 输出除外，trust:false + 转义由 KaTeX 保证）
 * - 行内 HTML 不渲染（⚠ 级：源码显示）
 * - 标签/注释按模型级 span 渲染（标签高亮、注释隐藏）
 * - 任何渲染失败回退显示原文（等宽），不崩溃、不丢内容
 */
import { type ReactNode } from 'react'
import { renderMath } from '../core/render/mathRender'

interface PNode {
  type: string
  value?: string
  depth?: number
  lang?: string
  ordered?: boolean
  start?: number | null
  checked?: boolean | null
  alt?: string | null
  url?: string
  label?: string
  title?: string | null
  align?: any
  data?: any
  children?: PNode[]
  position?: any
}

export interface PreviewModel {
  tags: { span: { start: number; end: number }; name: string }[]
  comments: { span: { start: number; end: number }; text: string }[]
  resolvedWikiTargets: Map<number, string | null> // offset → 解析结果（null=未解析）
}

const NO_RENDER_HTML = true // 策略：行内 HTML 源码显示

function TextWithExtras({ text, node, model }: { text: string; node: PNode; model: PreviewModel }) {
  const off = node.position?.start?.offset ?? -1
  const inComment = model.comments.some((c) => c.span.start <= off && off < c.span.end)
  if (inComment) return null // 注释隐藏（模型保留，见基线矩阵）
  // 标签高亮（模型级 span 不在 text 内重算，简化为值级正则渲染）
  const parts = text.split(/(#[\w\u4e00-\u9fff][\w\u4e00-\u9fff/-]*)/g)
  return (
    <>
      {parts.map((p, i) =>
        /^#[\w\u4e00-\u9fff]/.test(p) ? (
          <span key={i} className="md-tag">
            {p}
          </span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  )
}

function MathBlock({ latex, display }: { latex: string; display: boolean }) {
  const r = renderMath(latex, display)
  if (!r.ok) {
    return (
      <span className="md-math-fallback" title={r.error}>
        {display ? `$$${latex}$$` : `$${latex}$`}
      </span>
    )
  }
  return (
    <span
      className={display ? 'md-math-display' : 'md-math-inline'}
      dangerouslySetInnerHTML={{ __html: r.html }}
    />
  )
}

function renderNodes(nodes: PNode[] | undefined, model: PreviewModel): ReactNode {
  if (!nodes) return null
  return nodes.map((n, i) => <RenderNode key={i} node={n} model={model} />)
}

function RenderNode({ node, model }: { node: PNode; model: PreviewModel }) {
  const kids = () => renderNodes(node.children, model)
  switch (node.type) {
    case 'root':
      return <div className="md-root">{kids()}</div>
    case 'yaml':
      return <pre className="md-frontmatter">{node.value}</pre>
    case 'heading': {
      const Tag = `h${Math.min(6, node.depth ?? 1)}` as 'h1'
      return <Tag className="md-heading">{kids()}</Tag>
    }
    case 'paragraph':
      return <p className="md-paragraph">{kids()}</p>
    case 'text':
      return <TextWithExtras text={node.value ?? ''} node={node} model={model} />
    case 'emphasis':
      return <em>{kids()}</em>
    case 'strong':
      return <strong>{kids()}</strong>
    case 'delete':
      return <del>{kids()}</del>
    case 'highlight':
      return <mark>{node.value}</mark>
    case 'inlineCode':
      return <code className="md-inlinecode">{node.value}</code>
    case 'code':
      return (
        <pre className="md-code">
          {node.lang ? <div className="md-code-lang">{node.lang}</div> : null}
          <code>{node.value}</code>
        </pre>
      )
    case 'math':
    case 'inlineMath':
      return <MathBlock latex={node.value ?? ''} display={node.type === 'math'} />
    case 'wikiLink':
    case 'wikiEmbed': {
      const d = node.data ?? {}
      const label = d.alias || (d.heading ? `${d.target}#${d.heading}` : d.target)
      return (
        <span
          className={`md-wikilink ${node.type === 'wikiEmbed' ? 'md-wikilink-embed' : ''}`}
          title={d.raw ?? ''}
        >
          {node.type === 'wikiEmbed' ? '嵌入·' : ''}
          {label}
        </span>
      )
    }
    case 'link':
      return (
        <a
          className="md-link"
          href={node.url}
          onClick={(e) => e.preventDefault()}
          title={`${node.url}（不自动外访）`}
        >
          {kids()}
        </a>
      )
    case 'image':
      return (
        <span className="md-image-placeholder" title={node.url}>
          [图片：{node.alt ?? node.url}]
        </span>
      )
    case 'list': {
      if (node.ordered) {
        return (
          <ol className="md-list" start={node.start ?? undefined}>
            {kids()}
          </ol>
        )
      }
      return <ul className="md-list">{kids()}</ul>
    }
    case 'listItem':
      return (
        <li className="md-listitem">
          {node.checked === null || node.checked === undefined ? null : (
            <input type="checkbox" checked={node.checked} disabled readOnly />
          )}
          {kids()}
        </li>
      )
    case 'blockquote':
      return <blockquote className="md-quote">{kids()}</blockquote>
    case 'callout': {
      const t = node.data?.calloutType ?? 'note'
      return (
        <div className={`md-callout md-callout-${t}`}>
          <div className="md-callout-title">
            {t.toUpperCase()}
            {node.data?.calloutTitle ? `：${node.data.calloutTitle}` : ''}
          </div>
          <div className="md-callout-body">{kids()}</div>
        </div>
      )
    }
    case 'table':
      return (
        <table className="md-table">
          <tbody>{kids()}</tbody>
        </table>
      )
    case 'tableRow':
      return <tr>{kids()}</tr>
    case 'tableCell': {
      const firstRow = node.position?.start?.line === node.position?.end?.line
      return <td className={firstRow ? 'md-th' : ''}>{kids()}</td>
    }
    case 'thematicBreak':
      return <hr />
    case 'html':
      return NO_RENDER_HTML ? (
        <code className="md-html-raw" title="行内 HTML 不渲染（安全策略）">
          {node.value}
        </code>
      ) : (
        <span />
      )
    case 'footnoteReference':
      return <sup className="md-footnote-ref">{node.label ? `[${node.label}]` : '[^]'}</sup>
    case 'footnoteDefinition':
      return (
        <div className="md-footnote-def">
          <sup>{node.label}</sup> {kids()}
        </div>
      )
    case 'break':
      return <br />
    default: {
      // 未知类型：回退为等宽源码显示（不丢内容）
      const raw =
        node.value ?? JSON.stringify(node.children?.map((c) => c.value ?? c.type) ?? node.type)
      return (
        <span className="md-unknown" title={`未支持节点类型：${node.type}`}>
          {raw}
        </span>
      )
    }
  }
}

export function MarkdownView({ tree, model }: { tree: any; model?: Partial<PreviewModel> }) {
  const m: PreviewModel = {
    tags: model?.tags ?? [],
    comments: model?.comments ?? [],
    resolvedWikiTargets: model?.resolvedWikiTargets ?? new Map(),
  }
  try {
    return <RenderNode node={tree} model={m} />
  } catch (e) {
    return (
      <pre className="md-render-fallback" title={`渲染失败：${String(e)}`}>
        {JSON.stringify(tree, null, 2)}
      </pre>
    )
  }
}
