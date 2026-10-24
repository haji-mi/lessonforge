/**
 * AI 边界层单测：消息构建 / 响应清洗 / 多模型回退 / 设置与缓存。
 * 全程注入 mock fetch——测试零真实网络（对应用「默认零上传」约束）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AiAllFailedError,
  FREE_MODELS,
  chatWithFallback,
  cleanContent,
  pingOpenRouter,
} from '../src/ai/openrouter'
import { ENV_API_KEY, loadAiSettings, saveAiSettings, isAiConfigured } from '../src/ai/settings'
import {
  MAX_INPUT_CHARS,
  aiTransformLesson,
  buildTransformMessages,
  capInput,
  fingerprint,
  loadAiCache,
  saveAiCache,
} from '../src/ai/transform'

// ── 工具：Response 形状 mock ──
function res(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}
function ok(content: string) {
  return res(200, { choices: [{ message: { content } }] })
}
/** 按序返回响应；越界抛错（防意外多打网络） */
function fetchSeq(reply: Array<() => Promise<Response>>) {
  let i = 0
  const impl = vi.fn(async () => {
    if (i >= reply.length) throw new Error('mock fetch 越界：发生了预期外的额外请求')
    return reply[i++]!()
  })
  return impl as unknown as typeof fetch & { mock: { calls: unknown[][] } }
}

// ── 工具：localStorage stub ──
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

describe('cleanContent：模型输出清洗', () => {
  it('剥离推理型 <think> 段', () => {
    expect(cleanContent('<think>内心独白</think>正文')).toBe('正文')
  })
  it('剥离 markdown 代码围栏包装', () => {
    expect(cleanContent('```markdown\n提示词正文\n```')).toBe('提示词正文')
  })
  it('普通文本原样（仅去首尾空白）', () => {
    expect(cleanContent('  提示词\n正文 ')).toBe('提示词\n正文')
  })
})

describe('buildTransformMessages：消息构建（纯函数）', () => {
  const base = {
    lessonTitle: '勾股定理',
    typeLabel: '公式推导',
    subject: '数学',
    level: '高中',
  }
  it('system 含硬约束（不编造/公式逐字/不遗漏/只输出正文）', () => {
    const [sys] = buildTransformMessages({ ...base, mode: 'polish', sourceText: 'x' })
    expect(sys!.role).toBe('system')
    for (const key of ['不得编造', '逐字', '不得遗漏', '不要 Markdown 代码围栏']) {
      expect(sys!.content).toContain(key)
    }
  })
  it('polish 与 rewrite 的任务描述不同', () => {
    const p = buildTransformMessages({ ...base, mode: 'polish', sourceText: 'x' })
    const r = buildTransformMessages({ ...base, mode: 'rewrite', sourceText: 'x' })
    expect(p[0]!.content).toContain('编译稿')
    expect(r[0]!.content).toContain('原始课堂笔记')
  })
  it('user 消息嵌入课题与材料全文', () => {
    const [, user] = buildTransformMessages({
      ...base,
      mode: 'rewrite',
      sourceText: '笔记内容ABC',
    })
    expect(user!.content).toContain('【课题】勾股定理')
    expect(user!.content).toContain('笔记内容ABC')
  })
  it('超长材料截断并标注', () => {
    const long = 'a'.repeat(MAX_INPUT_CHARS + 500)
    const [, user] = buildTransformMessages({ ...base, mode: 'rewrite', sourceText: long })
    expect(user!.content).toContain('已截断')
    expect(user!.content.length).toBeLessThan(long.length)
  })
})

describe('capInput', () => {
  it('不超上限原样返回', () => {
    expect(capInput('short')).toBe('short')
  })
})

describe('chatWithFallback：多模型回退', () => {
  const opts = { apiKey: 'sk-test', messages: [{ role: 'user' as const, content: 'hi' }] }

  it('首选模型成功直接返回', async () => {
    const f = fetchSeq([() => Promise.resolve(ok('答案'))])
    const r = await chatWithFallback({ ...opts, fetchImpl: f })
    expect(r.content).toBe('答案')
    expect(r.model).toBe(FREE_MODELS[0])
    expect(r.attempts).toHaveLength(1)
    expect(r.attempts[0]!.ok).toBe(true)
  })
  it('429/空内容依次回退到下一个模型', async () => {
    const f = fetchSeq([
      () => Promise.resolve(res(429, { error: { message: 'rate limited', code: 429 } })),
      () => Promise.resolve(ok('   ')), // 空内容 → 视为失败（实测 nemotron-3.5-lightning 行为）
      () => Promise.resolve(ok('第三个模型的输出')),
    ])
    const r = await chatWithFallback({ ...opts, fetchImpl: f })
    expect(r.model).toBe(FREE_MODELS[2])
    expect(r.attempts.map((a) => a.ok)).toEqual([false, false, true])
    expect(r.attempts[0]!.detail).toContain('429')
    expect(r.attempts[1]!.detail).toContain('空内容')
  })
  it('401 密钥无效为致命错误：立即终止，不再尝试后续模型', async () => {
    const f = fetchSeq([() => Promise.resolve(res(401, { error: { message: 'invalid key' } }))])
    await expect(chatWithFallback({ ...opts, fetchImpl: f })).rejects.toThrow(AiAllFailedError)
    expect(f.mock.calls).toHaveLength(1) // 未继续打第二个模型
  })
  it('全部失败：抛 AiAllFailedError 并带逐次明细', async () => {
    const f = fetchSeq([
      () => Promise.resolve(res(429, { error: { message: 'a' } })),
      () => Promise.resolve(res(404, { error: { message: 'b' } })),
      () => Promise.resolve(res(500, { error: { message: 'c' } })),
      () => Promise.resolve(res(500, { error: { message: 'd' } })),
      () => Promise.resolve(res(500, { error: { message: 'e' } })),
    ])
    try {
      await chatWithFallback({ ...opts, fetchImpl: f })
      expect.unreachable('应当抛错')
    } catch (e) {
      expect(e).toBeInstanceOf(AiAllFailedError)
      expect((e as AiAllFailedError).attempts).toHaveLength(FREE_MODELS.length)
      expect((e as Error).message).toContain(FREE_MODELS[0]!)
    }
  })
  it('指定 models 覆盖内置序列', async () => {
    const f = fetchSeq([() => Promise.resolve(ok('指定模型输出'))])
    const r = await chatWithFallback({ ...opts, models: ['my/model'], fetchImpl: f })
    expect(r.model).toBe('my/model')
  })
  it('请求头携带 Bearer 与 X-Title；<think> 输出被清洗', async () => {
    const f = fetchSeq([() => Promise.resolve(ok('<think>t</think>干净输出'))])
    const r = await chatWithFallback({ ...opts, fetchImpl: f })
    expect(r.content).toBe('干净输出')
    const init = f.mock.calls[0]![1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-test')
    expect(headers['X-Title']).toBe('Classroom Compiler')
    const body = JSON.parse(init.body as string) as { model: string }
    expect(body.model).toBe(FREE_MODELS[0])
  })
})

describe('pingOpenRouter：连通测试', () => {
  it('使用极小 max_tokens=8 且单条消息', async () => {
    const f = fetchSeq([() => Promise.resolve(ok('OK'))])
    const r = await pingOpenRouter({ apiKey: 'k', fetchImpl: f })
    expect(r.content).toBe('OK')
    const init = f.mock.calls[0]![1] as RequestInit
    const body = JSON.parse(init.body as string) as { max_tokens: number; messages: unknown[] }
    expect(body.max_tokens).toBe(8)
    expect(body.messages).toHaveLength(1)
  })
})

describe('AI 设置：localStorage + env 兜底', () => {
  it('从未保存时回退 env 预置值；model 默认 auto', () => {
    stubLs()
    const s = loadAiSettings()
    expect(s.apiKey).toBe(ENV_API_KEY)
    expect(s.model).toBe('auto')
    expect(s.baseUrl).toBe('https://openrouter.ai/api/v1')
  })
  it('保存后读取一致；显式清空不再回退 env', () => {
    stubLs()
    saveAiSettings({ apiKey: 'sk-or-v1-x', model: 'm/a', baseUrl: 'https://x/api/v1' })
    expect(loadAiSettings()).toEqual({
      apiKey: 'sk-or-v1-x',
      model: 'm/a',
      baseUrl: 'https://x/api/v1',
    })
    saveAiSettings({ apiKey: '', model: 'auto', baseUrl: 'https://openrouter.ai/api/v1' })
    const cleared = loadAiSettings()
    expect(cleared.apiKey).toBe('')
    expect(isAiConfigured(cleared)).toBe(false)
  })
})

describe('aiTransformLesson 编排', () => {
  const input = {
    mode: 'polish' as const,
    lessonTitle: '勾股定理',
    typeLabel: '公式推导',
    subject: '数学',
    level: '高中',
    sourceText: '【角色】……编译稿正文',
  }
  it('未配置 Key：显式报错且零网络请求', async () => {
    stubLs()
    saveAiSettings({ apiKey: '', model: 'auto', baseUrl: 'https://openrouter.ai/api/v1' })
    const f = fetchSeq([])
    await expect(aiTransformLesson(input, { fetchImpl: f })).rejects.toThrow('API Key')
  })
  it('配置后走回退调用并返回结果；settings 指定单模型时只试该模型', async () => {
    stubLs()
    saveAiSettings({
      apiKey: 'sk-or-v1-y',
      model: 'xingchen-agi/xing4.0-29b-a4b:free',
      baseUrl: 'https://openrouter.ai/api/v1',
    })
    const f = fetchSeq([() => Promise.resolve(ok('AI 转化结果'))])
    const r = await aiTransformLesson(input, { fetchImpl: f })
    expect(r.text).toBe('AI 转化结果')
    expect(r.model).toBe('xingchen-agi/xing4.0-29b-a4b:free')
    const init = f.mock.calls[0]![1] as RequestInit
    const body = JSON.parse(init.body as string) as {
      messages: { role: string; content: string }[]
    }
    expect(body.messages[1]!.content).toContain('编译稿正文')
  })
})

describe('每课时缓存与指纹', () => {
  it('fingerprint：同文同值、变文变值', () => {
    expect(fingerprint('abc')).toBe(fingerprint('abc'))
    expect(fingerprint('abc')).not.toBe(fingerprint('abd'))
  })
  it('缓存保存/读取往返；损坏数据返回 null', () => {
    const ls = stubLs()
    saveAiCache('lesson-1', {
      text: 'AI 结果',
      model: 'm',
      mode: 'rewrite',
      at: 123,
      sourceFingerprint: fingerprint('笔记'),
    })
    const got = loadAiCache('lesson-1')
    expect(got?.text).toBe('AI 结果')
    expect(got?.sourceFingerprint).toBe(fingerprint('笔记'))
    ls.set('cc-ai-transform:lesson-2', '{bad json')
    expect(loadAiCache('lesson-2')).toBeNull()
    expect(loadAiCache('lesson-3')).toBeNull()
  })
})
