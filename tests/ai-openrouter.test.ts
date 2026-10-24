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
  listModels,
  pingOpenRouter,
} from '../src/ai/openrouter'
import {
  ENV_API_KEY,
  ENV_NVIDIA_API_KEY,
  loadAiSettings,
  saveAiSettings,
  isAiConfigured,
} from '../src/ai/settings'
import {
  MAX_INPUT_CHARS,
  aiTransformLesson,
  buildTransformMessages,
  capInput,
  fingerprint,
  loadAiCache,
  resolveModels,
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

describe('listModels：拉取模型列表', () => {
  it('GET /models 并解析 id；非 2xx 报错', async () => {
    const f = fetchSeq([
      () =>
        Promise.resolve(res(200, { data: [{ id: 'nvidia/a' }, { id: 'nvidia/b' }, { no: 'x' }] })),
      () => Promise.resolve(res(403, { error: { message: 'denied' } })),
    ])
    const ids = await listModels({ apiKey: 'k', baseUrl: '/nim', fetchImpl: f })
    expect(ids).toEqual(['nvidia/a', 'nvidia/b'])
    const url = (f.mock.calls[0]![0] as string).endsWith('/models') ? 'ok' : 'bad'
    expect(url).toBe('ok')
    await expect(listModels({ apiKey: 'k', baseUrl: '/nim', fetchImpl: f })).rejects.toThrow('403')
  })
})

describe('AI 设置 v2：多供应商 + env 兜底 + v1 迁移', () => {
  it('从未保存时：默认 openrouter，Key 用 env；nvidia 用 env；custom 空', () => {
    stubLs()
    const s = loadAiSettings()
    expect(s.provider).toBe('openrouter')
    expect(s.providers.openrouter.apiKey).toBe(ENV_API_KEY)
    expect(s.providers.openrouter.model).toBe('auto')
    expect(s.providers.nvidia.apiKey).toBe(ENV_NVIDIA_API_KEY)
    expect(s.providers.nvidia.baseUrl).toBe('/nim')
    expect(s.providers.nvidia.modelList.length).toBeGreaterThan(0)
    expect(s.providers.custom.apiKey).toBe('')
  })
  it('保存往返一致；各供应商独立（切换不丢）', () => {
    stubLs()
    const s = loadAiSettings()
    s.providers.openrouter.apiKey = 'sk-or-v1-x'
    s.providers.custom = {
      apiKey: 'dk-1',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com/v1',
      modelList: ['deepseek-chat'],
    }
    s.provider = 'custom'
    saveAiSettings(s)
    const back = loadAiSettings()
    expect(back.provider).toBe('custom')
    expect(back.providers.custom.baseUrl).toBe('https://api.deepseek.com/v1')
    expect(back.providers.openrouter.apiKey).toBe('sk-or-v1-x') // 未被 custom 覆盖
    expect(isAiConfigured(back)).toBe(true)
  })
  it('显式清空当前供应商 Key：不再回退 env', () => {
    stubLs()
    const s = loadAiSettings()
    s.providers.openrouter.apiKey = ''
    saveAiSettings(s)
    expect(isAiConfigured(loadAiSettings())).toBe(false)
  })
  it('v1 旧记录（单供应商字段）迁移为 openrouter 配置', () => {
    const ls = stubLs()
    ls.set(
      'cc-ai-settings',
      JSON.stringify({ apiKey: 'sk-or-v1-old', model: 'm/x', baseUrl: 'https://old/v1' }),
    )
    const s = loadAiSettings()
    expect(s.provider).toBe('openrouter')
    expect(s.providers.openrouter).toEqual({
      apiKey: 'sk-or-v1-old',
      model: 'm/x',
      baseUrl: 'https://old/v1',
      modelList: s.providers.openrouter.modelList,
    })
    expect(s.providers.nvidia.apiKey).toBe(ENV_NVIDIA_API_KEY)
  })
})

describe('resolveModels：供应商感知的模型解析', () => {
  it('openrouter auto/空 → builtin；指定模型 → 单元素', () => {
    expect(resolveModels('openrouter', { model: 'auto', modelList: [] })).toBe('builtin')
    expect(resolveModels('openrouter', { model: '', modelList: [] })).toBe('builtin')
    expect(resolveModels('openrouter', { model: 'm/a', modelList: ['m/b'] })).toEqual(['m/a'])
  })
  it('nvidia/custom：指定模型优先，否则 modelList 顺序回退', () => {
    expect(resolveModels('nvidia', { model: 'n/1', modelList: ['n/2'] })).toEqual(['n/1'])
    expect(resolveModels('custom', { model: '', modelList: ['c/1', 'c/2'] })).toEqual([
      'c/1',
      'c/2',
    ])
    expect(resolveModels('custom', { model: '', modelList: [] })).toEqual([])
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
    const s = loadAiSettings()
    s.providers.openrouter.apiKey = ''
    saveAiSettings(s)
    const f = fetchSeq([])
    await expect(aiTransformLesson(input, { fetchImpl: f })).rejects.toThrow('API Key')
  })
  it('nvidia 供应商：走 /nim 代理与预设模型序列；指定模型时只试该模型', async () => {
    stubLs()
    const s = loadAiSettings()
    s.provider = 'nvidia'
    s.providers.nvidia.model = 'nvidia/llama-3.1-nemotron-70b-instruct'
    saveAiSettings(s)
    const f = fetchSeq([() => Promise.resolve(ok('NIM 结果'))])
    const r = await aiTransformLesson(input, { fetchImpl: f })
    expect(r.text).toBe('NIM 结果')
    expect(r.model).toBe('nvidia/llama-3.1-nemotron-70b-instruct')
    expect(f.mock.calls[0]![0]).toBe('/nim/chat/completions')
  })
  it('custom 供应商无模型且列表空：明确报错', async () => {
    stubLs()
    const s = loadAiSettings()
    s.provider = 'custom'
    s.providers.custom = { apiKey: 'k', model: '', baseUrl: 'https://x/v1', modelList: [] }
    saveAiSettings(s)
    const f = fetchSeq([])
    await expect(aiTransformLesson(input, { fetchImpl: f })).rejects.toThrow('未选择模型')
  })
  it('openrouter 指定单模型时只试该模型', async () => {
    stubLs()
    const s = loadAiSettings()
    s.providers.openrouter.apiKey = 'sk-or-v1-y'
    s.providers.openrouter.model = 'xingchen-agi/xing4.0-29b-a4b:free'
    saveAiSettings(s)
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
