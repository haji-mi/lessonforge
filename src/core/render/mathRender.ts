/** KaTeX 渲染封装（纯函数，可测）：失败时返回错误而非抛出，供预览回退显示源码 */
import katex from 'katex'

export interface MathRenderOk {
  ok: true
  html: string
}
export interface MathRenderFail {
  ok: false
  error: string
  latex: string
}
export type MathRenderResult = MathRenderOk | MathRenderFail

export function renderMath(latex: string, display: boolean): MathRenderResult {
  try {
    const html = katex.renderToString(latex, {
      displayMode: display,
      throwOnError: true,
      trust: false,
      strict: 'ignore',
    })
    return { ok: true, html }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), latex }
  }
}
