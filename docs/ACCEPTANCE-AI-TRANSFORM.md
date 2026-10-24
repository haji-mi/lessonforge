# ACCEPTANCE — AI 转化功能（OpenRouter 免费模型）

日期：2026-10-24。功能：工作台「AI 转化」面板 +「⚙ AI 设置」，`src/ai/**` 边界层。
性质：用户点名的可选功能；不改变确定性编译链（compile 仍无 LLM），AI 输出恒为建议稿。

## 1. 可行性实测（OpenRouter 免费模型，2026-10-24）

密钥：用户提供（OpenRouter Key），`/api/v1/key` 验证有效（free tier）。

| 模型                                   | 结果                              |
| -------------------------------------- | --------------------------------- |
| nvidia/nemotron-3-ultra-550b-a55b:free | ✅ 中文质量最好（采用为首选）     |
| dots-studio/dots-3-note-preview:free   | ✅ 可用                           |
| xingchen-agi/xing4.0-29b-a4b:free      | ✅ 可用（英文思维链开头，需清洗） |
| google/gemma-4-31b-it:free / 26b       | ❌ 429 上游限流（当日）           |
| nvidia/nemotron-3-super-120b-a12b:free | ❌ 上游 404                       |
| thinkingmachines/inkling:free          | ❌ 403 仅限 agentic harness       |
| nemotron-3.5-lightning:free            | ❌ 200 但空内容                   |
| cohere/north-mini-code 等              | ❌ 输出乱码/质量不可用            |

结论：**通路可行，但免费模型可用性逐日波动** → 功能必须按序回退（实现见 `FREE_MODELS`，
仅 401 终止；429/404/空回复/网络错误自动换下一个）。用户提醒「别测那么多」（额度有限），
可行性实测共 11 次小请求后停止；功能侧配套省额度设计（显式触发 + 极小测试请求 + 缓存）。

## 2. 自动化测试（新增 tests/ai-openrouter.test.ts，21 个，全 mock 零真实网络）

- cleanContent：剥离 `<think>` 段 / 代码围栏 / 普通文本原样。
- buildTransformMessages：system 硬约束（不得编造/公式逐字/不得遗漏/无围栏）；polish 与
  rewrite 任务描述区分；user 嵌入课题与材料；超长截断标注（12k 上限）。
- chatWithFallback：首选成功直返；429+空内容依次回退并留逐次明细；**401 立即终止不再打后续模型**；
  全败抛 AiAllFailedError 带全部明细；models 覆盖内置序列；请求头 Bearer/X-Title 断言。
- pingOpenRouter：max_tokens=8、单条消息（省额度）。
- 设置：env 兜底 / 保存读取 / 显式清空不回退 env。
- aiTransformLesson：未配置 Key 零网络报错；指定单模型只试该模型。
- 缓存/指纹：往返、损坏数据返回 null。

`npm run check`（typecheck + lint + format:check + test 234/234）退出码 0。

## 3. 应用内真实验收（生产构建 + preview + Chromium 内核浏览器）

用早前 E2E 留存的 IndexedDB 项目（「函数的概念」，编译稿 454 字），生产构建 CSP 生效：

- ✅ 「⚙ AI 设置」对话框：Key 密码态预置（env 注入，73 字符）、模型默认「自动」。
- ✅ 「AI 转化」面板：默认「润色编译稿（454 字）」，可切「由原文笔记重写（96 字）」；
  结果为空前复制按钮禁用。
- ✅ **真实调用成功**：点击「运行 AI 转化」→ 75 秒后 nemotron-3-ultra 一次成功，产出 920 字
  互动课堂提示词；环节齐全、每个设问后带「等待学生回答」、未发现编造内容；回退明细 UI 显示
  「一次成功」。
- ✅ **U1 用户主权**：AI 输出不写回——编译稿五个 section 内容逐字未变；复制 AI 版后计入
  markExported（与人工复制同语义）。
- ✅ 缓存：localStorage 出现 `cc-ai-transform:<lessonId>`（920 字 + 模型名）。
- ✅ CSP：`dist/index.html` 含 `connect-src 'self' https://openrouter.ai`（唯一例外域）。

## 4. 诚实边界

- AI 产出质量只能人工判定（同基线 §8 诚实边界）；面板明示「仅供审阅」。
- 免费模型有平台侧每日限额（按账号），额度耗尽/限流时依赖回退序列或次日重试。
- 「AI 设置」的「测试连接」会消耗 1 次免费请求——对话框已注明。
- E2E 断言（基线 §10「非 localhost 请求数 = 0」）按修订记录 8 调整口径为
  「除 openrouter.ai 外 = 0」；本次未重跑该 E2E（旧断言脚本针对无 AI 时代构建）。

## 5. 批量转化（同日追加：勾选 + 一键生成）

功能：课时树每行勾选框 + 侧栏工具栏（全选/清空、已勾选数、「AI 一键生成（N）」）；
批量 = 逐篇**顺序**转化（篇间 2.5s 间隔，免费档 ~20 请求/分钟保险），单篇失败不阻断
（B4 隔离语义），结束逐篇点名报告；启动前 confirm 明示额度消耗（免费档每日约 50 次）。
已编译课时走润色编译稿，未编译走由原文重写（pickBatchMode，单测锁定）。

- 自动化：tests/ai-batch.test.ts（模式选择/顺序执行/进度回调序列/失败隔离/无材料跳过/
  失败不写缓存/缓存指纹），全 mock 零真实网络。`npm run check` 239/239 退出码 0。
- 真实验收（用户真实线性代数题库，localhost:4173 生产构建）：勾选 1 篇未编译课时
  「2-4 逆矩阵」→ confirm 文案正确 → 进度「AI 批量中 0/1 · 当前《2-4 逆矩阵》」→
  40s 完成，toast「1 篇全部成功」；缓存落盘（mode=rewrite，nemotron-3-ultra，1706 字）；
  打开该课时 AI 面板即见缓存结果。**保真抽查**：产出开头的「倒数→逆矩阵」类比经核对
  确为原文内容（非编造）。

## 6. 多供应商（同日第二次追加：自定义 API / 英伟达 NIM / OpenCode 探测）

需求：用户要能自接 API、或用英伟达免费 API、或借用本机 OpenCode 额度。

- **英伟达 NIM**：Key（用户提供）实测有效（GET /models 85 个模型）；
  chat 实测 200。**浏览器直连被 CORS 拦截**（响应无 Access-Control-Allow-Origin）→
  vite dev/preview 增加 `/nim` 同源代理转发 integrate.api.nvidia.com（vite.config.ts nimProxy）。
  预设模型 3 个（nemotron-3-ultra/super/llama-70b），按序回退。
- **自定义供应商**：OpenAI 兼容端点（baseUrl+Key+拉取模型列表），支持本地 Ollama 等；
  未真实验证（用户未提供端点），单测覆盖解析/回退路径。
- **OpenCode（如实结论：暂不可用）**：本机 OpenCode 1.19.3 的 credential 表仅有两份
  GitHub Copilot OAuth（device 流，非静态 Key，无法直接填入）；`opencode serve` 启动失败
  （「Database is not empty and has no session table」，库 schema 冲突）。设置对话框内
  如实说明，未提供假通路。
- **settings v2**：`{provider, providers: {openrouter|nvidia|custom: {apiKey, model, baseUrl, modelList}}}`；
  各供应商独立保存（切换不丢）；v1 单供应商记录自动迁移为 openrouter 配置；
  env 预置 `VITE_OPENROUTER_API_KEY` / `VITE_NVIDIA_API_KEY`（.env.local，gitignored）。
- **CSP 调整**：connect-src 放宽为 `'self' https: http://localhost:* http://127.0.0.1:*`
  （供应商自选与本地 LLM 所需，基线 §13 修订 8 补记）；其余资源仍零外联。
- 自动化：246/246 全绿（+listModels、多供应商设置/迁移、resolveModels、nvidia 代理路径断言）。
- **真实验收**（浏览器 + 生产构建 + /nim 代理）：设置对话框切英伟达 → Key 自动预置 →
  测试连接 4s 返回「连通正常」→ 保存 → 批量勾选「2-5 分块矩阵」（未编译，rewrite）→
  28s 成功 2917 字，缓存 model=nvidia/nemotron-3-ultra-550b-a55b（NIM 端点，非 OpenRouter）。
