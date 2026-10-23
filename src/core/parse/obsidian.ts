/**
 * Obsidian 语法扩展：[[wikilink]]、![[embed]]、==highlight==（架构基线 §5 矩阵 ✅ 行）。
 *
 * - 分词器工作在 micromark text 层，与代码块处理天然互斥（代码块内的 [[..]] 保持字面）。
 * - 单个 ] / = 在内容中被当作普通数据消费（maybeClose 回退状态），
 *   仅连续 ]] / == 终止；无法配对时整个构造 nok 回退为字面文本（P2 raw 节点零例外）。
 * - mdast 侧从容器 token 的 sliceSerialize 取原文并剥离定界符（P2：raw === 源切片）。
 */
import type { Extension, Tokenizer } from 'micromark-util-types'

/* ------------------------- micromark 语法层 ------------------------- */

function makeDoubleBracket(kind: 'wikiLink' | 'wikiEmbed'): Tokenizer {
  const container = kind
  return function (effects: any, ok: any, nok: any) {
    return start

    function start(code: number | null) {
      if (kind === 'wikiEmbed') {
        if (code !== 33) return nok(code) // '!'
        effects.enter(container)
        effects.enter(`${container}Marker`)
        effects.consume(code)
        return afterBang
      }
      if (code !== 91) return nok(code) // '['
      effects.enter(container)
      effects.enter(`${container}Marker`)
      effects.consume(code)
      return afterBracket1
    }
    function afterBang(code: number | null) {
      if (code !== 91) return nok(code)
      effects.consume(code)
      return afterBracket1
    }
    function afterBracket1(code: number | null) {
      if (code !== 91) return nok(code)
      effects.consume(code)
      effects.exit(`${container}Marker`)
      effects.enter(`${container}Data`)
      return data
    }
    function data(code: number | null) {
      if (code === null || code === 10 || code === 13 || code === 91) return nok(code)
      if (code === 93) {
        // ']'：可能是闭合开始，也可能是数据（maybeClose 回退处理）
        effects.consume(code)
        return maybeClose
      }
      effects.consume(code)
      return data
    }
    function maybeClose(code: number | null) {
      if (code === 93) {
        effects.consume(code)
        effects.exit(`${container}Data`)
        effects.exit(container)
        return ok(code)
      }
      if (code === null || code === 10 || code === 13 || code === 91) return nok(code)
      effects.consume(code) // 单个 ']' 是数据
      return data
    }
  }
}

const tokenizeWikiLink = makeDoubleBracket('wikiLink')
const tokenizeWikiEmbed = makeDoubleBracket('wikiEmbed')

const tokenizeHighlight: Tokenizer = function (effects: any, ok: any, nok: any) {
  return start
  function start(code: number | null) {
    if (code !== 61) return nok(code) // '='
    effects.enter('highlight')
    effects.enter('highlightMarker')
    effects.consume(code)
    return second
  }
  function second(code: number | null) {
    if (code !== 61) return nok(code)
    effects.consume(code)
    effects.exit('highlightMarker')
    effects.enter('highlightData')
    return data
  }
  function data(code: number | null) {
    if (code === null || code === 10 || code === 13) return nok(code)
    if (code === 61) {
      effects.consume(code)
      return maybeClose
    }
    effects.consume(code)
    return data
  }
  function maybeClose(code: number | null) {
    if (code === 61) {
      effects.consume(code)
      effects.exit('highlightData')
      effects.exit('highlight')
      return ok(code)
    }
    if (code === null || code === 10 || code === 13) return nok(code)
    effects.consume(code) // 单个 '=' 是数据
    return data
  }
}

export function obsidianSyntax(): Extension {
  return {
    text: {
      91: { tokenize: tokenizeWikiLink }, // '['
      33: { tokenize: tokenizeWikiEmbed }, // '!'
      61: { tokenize: tokenizeHighlight }, // '='
    },
  }
}

/* ------------------------- mdast 语义层 ------------------------- */

export interface ObsidianData {
  embed: boolean
  target: string
  heading: string
  alias: string
  raw: string
}

export interface WikiLinkNode {
  type: 'wikiLink' | 'wikiEmbed'
  data?: ObsidianData
  position?: any
}

export interface HighlightNode {
  type: 'highlight'
  value?: string
  position?: any
}

function parseInner(inner: string, embed: boolean): ObsidianData {
  const [beforeAlias = '', alias = ''] = inner.split('|')
  const [target = '', heading = ''] = beforeAlias.split('#')
  return {
    embed,
    target: target.trim(),
    heading: heading.trim(),
    alias: alias.trim(),
    raw: '',
  }
}

export function obsidianFromMarkdown(): any {
  return {
    enter: {
      wikiLink: function (this: any, token: any) {
        this.enter({ type: 'wikiLink', data: { embed: false } }, token)
      },
      wikiEmbed: function (this: any, token: any) {
        this.enter({ type: 'wikiEmbed', data: { embed: true } }, token)
      },
      highlight: function (this: any, token: any) {
        this.enter({ type: 'highlight', value: '' }, token)
      },
    },
    exit: {
      wikiLink: function (this: any, token: any) {
        const node = this.stack[this.stack.length - 1]
        const raw: string = this.sliceSerialize(token)
        const inner = raw.slice(2, -2) // 剥离 [[ ]]
        node.data = { ...parseInner(inner, false), raw }
        this.exit(token)
      },
      wikiEmbed: function (this: any, token: any) {
        const node = this.stack[this.stack.length - 1]
        const raw: string = this.sliceSerialize(token)
        const inner = raw.slice(3, -2) // 剥离 ![[ ]]
        node.data = { ...parseInner(inner, true), raw }
        this.exit(token)
      },
      highlight: function (this: any, token: any) {
        const node = this.stack[this.stack.length - 1]
        const raw: string = this.sliceSerialize(token)
        node.value = raw.slice(2, -2)
        ;(node as any).raw = raw
        this.exit(token)
      },
    },
  }
}
