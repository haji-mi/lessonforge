/** P2d：数学渲染封装（成功/失败回退） */
import { describe, expect, it } from 'vitest'
import { renderMath } from '../src/core/render/mathRender'

describe('renderMath', () => {
  it('合法 LaTeX 渲染为 HTML', () => {
    const r = renderMath('x^2 + y^2 = z^2', false)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.html).toContain('katex')
  })

  it('中文与常见符号', () => {
    const r = renderMath('\\frac{a}{b} > 0', true)
    expect(r.ok).toBe(true)
  })

  it('非法 LaTeX → 返回错误（不抛出），预览回退显示源码', () => {
    const r = renderMath('\\notacommand{', false)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toBeTruthy()
      expect(r.latex).toBe('\\notacommand{')
    }
  })
})
