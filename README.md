# Classroom Compiler（Obsidian → 豆包爱学互动课堂编译器）

本地优先的 Markdown 课程解析与互动课堂提示词编译工具。将 Obsidian 课程资料转换为按课时组织的互动课堂提示词，可预览、编辑、复制后粘贴到豆包爱学。

- 架构权威参考：[docs/ARCHITECTURE-BASELINE.md](docs/ARCHITECTURE-BASELINE.md)
- 约束：本地运行（Chrome/Edge + localhost），默认零第三方上传，原始笔记只读，用户编辑永不静默覆盖。

## 功能

- **确定性编译管线**：导入 → 解析 → 结构/课型推断 → 提示词编译（A/B/C 分级 + 全段溯源）→ 审阅编辑 → 批准 → 复制/导出。
- **AI 转化（可选，2026-10-24 新增）**：把编译稿交给 OpenRouter 免费模型润色，或由原始笔记直接重写为互动课堂提示词。详见下方「AI 转化」。

## AI 转化（OpenRouter 免费模型）

工作台点「AI 转化」打开面板：输入材料可选「润色编译稿」或「由原文笔记重写」，输出为**建议稿**——只在面板内审阅/编辑/复制，绝不自动写入编译稿（用户编辑主权不变）。侧栏课时树可**勾选多篇**（全选/清空），点「AI 一键生成（N）」逐篇批量转化（顺序执行 + 篇间限流间隔，单篇失败不阻断，结果按课时缓存）。

- **供应商（AI 设置中切换，各供应商 Key 独立保存）**：
  - **OpenRouter**（默认）：免费模型池，env 预置 `VITE_OPENROUTER_API_KEY`；
  - **英伟达 NIM**：env 预置 `VITE_NVIDIA_API_KEY`（build.nvidia.com 免费申请，nvapi- 开头）；浏览器直连被 CORS 拦截（实测），故走 vite dev/preview 的同源代理 `/nim` 转发；
  - **自定义**：任何 OpenAI 兼容端点（OpenAI/DeepSeek/本地 Ollama 等），可「拉取模型列表」。
- **模型**：OpenRouter 默认「自动」按实测序列回退（仅 401 终止，429/上游故障/空回复自动换下一个）；英伟达/自定义按列表顺序回退或指定单模型。
- **额度友好**：仅在用户显式点击「运行 AI 转化 / 测试连接」时才发起请求；「测试连接」是 max_tokens=8 的极小请求；结果按课时缓存于 localStorage，材料变化时提示重跑。
- **外联范围**：仅 ai 边界层代码且仅在用户显式触发时外联；生产 CSP `connect-src` 放行 https 与本机 http（供应商自选所需），其余资源仍零外联。
- 免费模型有平台侧每日次数限制（按账号计），可用性逐日波动。

## 开发

```bash
npm install        # 安装依赖
npm run dev        # 开发服务器
npm run check      # typecheck + lint + format:check + test
npm run build      # 生产构建（含类型检查）
npm run preview    # 预览生产构建
```

## 工程约定

- 核心规则：`src/core/**` 为纯函数（禁浏览器 IO），IO 收敛在 `import/persist/export/ai` 边界层。
- 保真不变量（B/P/T/K/U 系列）见架构基线 §3，全部有自动化测试锁定。
- 用户提供的三篇真实课程笔记放 `fixtures-real/`（已 gitignore，不入库）。
- `.env.local`（gitignored）可存放本机私密配置（如 API Key），模式参考 `.env.example`。
