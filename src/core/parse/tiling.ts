/**
 * 全源平铺（架构基线 P1 不变量）：语义叶 ∪ 语法 token ∪ 空白 token = 整个 T 空间，两两不交。
 *
 * 实现路线（基线 §13 路线修订 1）：由 mdast 位置残差推导——
 * mdast position 是构造包含式的（容器节点 span 覆盖其标记），
 * 节点的"直接跨度" = 节点 span 减去子节点 span，即该节点自身的标记/空白。
 * 每个字符属于恰好一个最内层包含它的节点的直接跨度 ⇒ 平铺由构造保证，
 * 测试断言完备性（任何缺口/重叠/越界 = 解析器 bug，不得伪造覆盖率）。
 */
export interface TileSegment {
  start: number
  end: number
  kind: 'semantic' | 'marker' | 'whitespace'
  nodeType: string
}

export interface TilingViolation {
  kind:
    | 'child-outside-parent'
    | 'sibling-overlap'
    | 'gap'
    | 'overlap'
    | 'missing-position'
    | 'unclassified'
    | 'unexpected-direct-content'
  detail: string
}

export interface TilingResult {
  tiles: TileSegment[]
  violations: TilingViolation[]
  /** true ⇔ 零违规且铺满 [0, text.length) */
  complete: boolean
  counts: {
    semantic: number
    marker: number
    whitespace: number
    semanticChars: number
    markerChars: number
    whitespaceChars: number
  }
}

interface AnyNode {
  type: string
  position?: { start: { offset?: number }; end: { offset?: number } }
  children?: AnyNode[]
}

/**
 * 直接跨度永远只允许空白的容器类型（黄金集验证）。
 * 其余容器类型合法携带语法标记于直接跨度（heading 的 "# "、strong/emphasis 的 "*"、
 * link 的 "[](...)"、blockquote 的 "> "、listItem 的 "- "、table 的 "|" 等）。
 * 这三类是"语义内容掉落"检测器：root/paragraph/list 的直接跨度一旦出现非空白，
 * 即内容从语义层掉落（如被删除的子节点），判为违规——不以此为覆盖率造假手段。
 */
const WHITESPACE_ONLY_CONTAINERS = new Set(['root', 'paragraph', 'list'])

export function buildTiling(root: AnyNode, text: string): TilingResult {
  const violations: TilingViolation[] = []
  const tiles: TileSegment[] = []

  function classify(node: AnyNode, s: number, e: number): TileSegment['kind'] {
    if (!node.children || node.children.length === 0) return 'semantic'
    const seg = text.slice(s, e)
    return /^\s*$/.test(seg) ? 'whitespace' : 'marker'
  }

  function visit(node: AnyNode) {
    const pos = node.position
    if (!pos || pos.start?.offset === undefined || pos.end?.offset === undefined) {
      violations.push({ kind: 'missing-position', detail: `节点 ${node.type} 缺少 position` })
      return
    }
    const start = pos.start.offset
    const end = pos.end.offset
    if (end < start) {
      violations.push({
        kind: 'unclassified',
        detail: `节点 ${node.type} 空区间倒置 [${start},${end})`,
      })
      return
    }
    const children = node.children ?? []
    const whitespaceOnly = WHITESPACE_ONLY_CONTAINERS.has(node.type)
    const checkDirect = (s: number, e: number) => {
      const kind = classify(node, s, e)
      tiles.push({ start: s, end: e, kind, nodeType: node.type })
      if (kind === 'marker' && whitespaceOnly) {
        violations.push({
          kind: 'unexpected-direct-content',
          detail: `${node.type} 的直接跨度含非空白内容 "${text.slice(s, e).slice(0, 30)}"（语义内容掉落）`,
        })
      }
    }
    let cursor = start
    for (const child of children) {
      const cp = child.position
      if (!cp || cp.start?.offset === undefined || cp.end?.offset === undefined) {
        violations.push({ kind: 'missing-position', detail: `子节点 ${child.type} 缺少 position` })
        continue
      }
      const cs = cp.start.offset
      const ce = cp.end.offset
      if (cs < start || ce > end) {
        violations.push({
          kind: 'child-outside-parent',
          detail: `${child.type}[${cs},${ce}) 越出 ${node.type}[${start},${end})`,
        })
      }
      if (cs < cursor) {
        violations.push({
          kind: 'sibling-overlap',
          detail: `${child.type}[${cs},${ce}) 与前兄弟重叠（游标 ${cursor}）`,
        })
      }
      if (cs > cursor) {
        checkDirect(cursor, cs)
      }
      cursor = Math.max(cursor, ce)
      visit(child)
    }
    if (end > cursor) {
      checkDirect(cursor, end)
    }
  }

  visit(root)

  // 完备性检查：排序后铺满 [0, len)，无缺口无重叠
  tiles.sort((a, b) => a.start - b.start)
  let pos = 0
  for (const t of tiles) {
    if (t.start < pos)
      violations.push({
        kind: 'overlap',
        detail: `瓦片 [${t.start},${t.end}) 与前一瓦片重叠（游标 ${pos}）`,
      })
    else if (t.start > pos) violations.push({ kind: 'gap', detail: `缺口 (${pos}, ${t.start})` })
    pos = Math.max(pos, t.end)
  }
  if (pos !== text.length) {
    violations.push({ kind: 'gap', detail: `末端缺口 (${pos}, ${text.length})` })
  }

  const counts = {
    semantic: 0,
    marker: 0,
    whitespace: 0,
    semanticChars: 0,
    markerChars: 0,
    whitespaceChars: 0,
  }
  for (const t of tiles) {
    counts[t.kind]++
    counts[`${t.kind}Chars` as 'semanticChars'] += t.end - t.start
  }
  return { tiles, violations, complete: violations.length === 0, counts }
}
