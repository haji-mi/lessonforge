/**
 * AI 批量转化编排单测：顺序/失败隔离/材料选择/进度/缓存（全 mock，零真实网络）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pickBatchMode, runBatchTransform, type BatchLessonInput } from '../src/ai/batch'
import type { TransformResult } from '../src/ai/transform'

function lesson(p: Partial<BatchLessonInput>): BatchLessonInput {
  return {
    lessonId: p.lessonId ?? 'L1',
    title: p.title ?? '课时',
    typeLabel: p.typeLabel ?? '概念理解',
    promptText: p.promptText ?? null,
    noteText: p.noteText ?? null,
  }
}

function fakeTransformResult(text: string): TransformResult {
  return { text, model: 'fake/model', attempts: [], mode: 'polish', at: 0 }
}

function stubLs() {
  const m = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  })
  return m
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('pickBatchMode：材料选择', () => {
  it('有编译稿→polish；只有原文→rewrite；都无→null', () => {
    expect(pickBatchMode(lesson({ promptText: '稿', noteText: '文' }))).toBe('polish')
    expect(pickBatchMode(lesson({ promptText: null, noteText: '文' }))).toBe('rewrite')
    expect(pickBatchMode(lesson({ promptText: null, noteText: null }))).toBeNull()
  })
})

describe('runBatchTransform', () => {
  it('顺序执行全部成功：模式正确、进度回调完整、缓存落盘', async () => {
    const ls = stubLs()
    const calls: string[] = []
    const modes: string[] = []
    const transform = vi.fn(
      async (input: Parameters<typeof import('../src/ai/transform').aiTransformLesson>[0]) => {
        calls.push(input.lessonTitle)
        modes.push(input.mode)
        return fakeTransformResult(`AI-${input.lessonTitle}`)
      },
    )
    const progress: { done: number; total: number; currentTitle: string | null }[] = []
    const r = await runBatchTransform(
      [
        lesson({ lessonId: 'a', title: 'A', promptText: '编译稿A' }),
        lesson({ lessonId: 'b', title: 'B', promptText: null, noteText: '笔记B' }),
      ],
      { transform: transform as never, gapMs: 0, onProgress: (p) => progress.push(p) },
    )
    expect(r.ok).toBe(2)
    expect(r.failed).toBe(0)
    expect(modes).toEqual(['polish', 'rewrite'])
    expect(calls.map((c) => c)).toEqual(['A', 'B'])
    // 每篇开始一次 + 结束一次（currentTitle=null, done=total）
    expect(progress).toEqual([
      { done: 0, total: 2, currentTitle: 'A' },
      { done: 1, total: 2, currentTitle: 'B' },
      { done: 2, total: 2, currentTitle: null },
    ])
    expect(JSON.parse(ls.get('cc-ai-transform:a')!).text).toBe('AI-A')
    expect(JSON.parse(ls.get('cc-ai-transform:b')!).mode).toBe('rewrite')
  })

  it('单篇失败不阻断（B4 语义）：其余成功，失败带原因点名', async () => {
    stubLs()
    const transform = vi.fn(async (input: { lessonTitle: string }) => {
      if (input.lessonTitle === 'B') throw new Error('全部模型尝试失败（1 次）：x→限流')
      return fakeTransformResult('ok')
    })
    const r = await runBatchTransform(
      [
        lesson({ lessonId: 'a', title: 'A', promptText: 'p' }),
        lesson({ lessonId: 'b', title: 'B', promptText: 'p' }),
        lesson({ lessonId: 'c', title: 'C', promptText: 'p' }),
      ],
      { transform: transform as never, gapMs: 0 },
    )
    expect(r.ok).toBe(2)
    expect(r.failed).toBe(1)
    const bad = r.outcomes.find((o) => !o.ok)!
    expect(bad.title).toBe('B')
    expect(bad.detail).toContain('限流')
    expect(r.outcomes.map((o) => o.lessonId)).toEqual(['a', 'b', 'c'])
  })

  it('无可用材料的课时直接标记失败，不发起转化', async () => {
    stubLs()
    const transform = vi.fn(async () => fakeTransformResult('ok'))
    const r = await runBatchTransform(
      [lesson({ lessonId: 'empty', title: '空', promptText: null, noteText: null })],
      { transform: transform as never, gapMs: 0 },
    )
    expect(r.failed).toBe(1)
    expect(r.outcomes[0]!.detail).toContain('无可用材料')
    expect(transform).not.toHaveBeenCalled()
  })

  it('失败课时不写缓存；成功课时缓存带材料指纹', async () => {
    const ls = stubLs()
    const transform = vi.fn(async (input: { lessonTitle: string }) => {
      if (input.lessonTitle === 'B') throw new Error('boom')
      return fakeTransformResult('文本')
    })
    await runBatchTransform(
      [
        lesson({ lessonId: 'a', title: 'A', promptText: '编译稿' }),
        lesson({ lessonId: 'b', title: 'B', promptText: '编译稿' }),
      ],
      { transform: transform as never, gapMs: 0 },
    )
    expect(ls.has('cc-ai-transform:a')).toBe(true)
    expect(ls.has('cc-ai-transform:b')).toBe(false)
    expect(JSON.parse(ls.get('cc-ai-transform:a')!).sourceFingerprint).toBeTruthy()
  })

  it('isCancelled 命中后停止：当前篇完成后不再继续，已完成保留且不发收尾进度', async () => {
    stubLs()
    let stop = false
    const transform = vi.fn(async (input: { lessonTitle: string }) => {
      if (input.lessonTitle === 'A') stop = true // A 完成后请求停止
      return fakeTransformResult('ok')
    })
    const progress: { done: number; total: number; currentTitle: string | null }[] = []
    const r = await runBatchTransform(
      [
        lesson({ lessonId: 'a', title: 'A', promptText: 'p' }),
        lesson({ lessonId: 'b', title: 'B', promptText: 'p' }),
        lesson({ lessonId: 'c', title: 'C', promptText: 'p' }),
      ],
      {
        transform: transform as never,
        gapMs: 0,
        isCancelled: () => stop,
        onProgress: (p) => progress.push(p),
      },
    )
    expect(r.cancelled).toBe(true)
    expect(r.ok).toBe(1)
    expect(r.outcomes.map((o) => o.lessonId)).toEqual(['a'])
    expect(transform).toHaveBeenCalledTimes(1)
    // 取消时不发收尾进度（done=total 会误导 UI）
    expect(progress).toEqual([{ done: 0, total: 3, currentTitle: 'A' }])
  })
})
