# LessonForge（Obsidian → 豆包爱学互动课堂编译器）

本地优先的 Markdown 课程解析与互动课堂提示词编译工具。把 Obsidian 课程资料转换为按课时组织的互动课堂提示词，可预览、编辑、复制后粘贴到豆包爱学。

- **本地优先**：纯前端 SPA，零后端；原始笔记只读，默认零第三方上传（生产 CSP + 测试断言锁定）。
- **确定性编译**：核心编译管线不含 LLM——给定输入与配置，输出唯一、可复现，每段内容带原文溯源。
- **用户编辑主权**：用户编辑永不静默覆盖；AI 产出恒为「建议稿」，只在面板内审阅，不写回编译稿。

## 功能

### 确定性编译管线

导入（目录 / 拖拽 / ZIP）→ 解析 Obsidian 方言 → 结构推断（课程/章节/课时）→ 课型分类与最小知识单元切分（MKU）→ 提示词编译（A/B/C 分级 + 全段溯源）→ 审阅编辑 → 批准 → 复制 / 导出（单课 MD / 批量 ZIP / 项目 JSON 备份）。

- Obsidian 语法支持：wikilink、嵌入、高亮、callout、标签、注释、数学公式（KaTeX）、frontmatter 等；不支持的原样保留并显式标注，绝不静默丢弃。
- ZIP 导入带名称解码四类别（UTF-8 / 损坏 / Unicode 路径扩展 / 聚合判定）与守卫式解压（分片限内存、解压炸弹预算、CRC 校验、路径安全）。
- 课程/章节/课时自动识别，识别结果可人工确认；课型（概念/推导/例题）差异化编译，可人工覆盖。

### AI 转化（可选）

工作台点「AI 转化」打开面板：输入材料可选「润色编译稿」或「由原文笔记重写」，输出为**建议稿**——只在面板内审阅/编辑/复制，绝不自动写入编译稿。侧栏课时树可**勾选多篇**，点「AI 一键生成（N）」逐篇批量转化（顺序执行 + 篇间限流间隔，单篇失败不阻断，结果按课时缓存）。

- **供应商（AI 设置中切换，各供应商 Key 独立保存）**：
  - **OpenRouter**（默认）：免费模型池；
  - **英伟达 NIM**：build.nvidia.com 免费申请（nvapi- 开头）；浏览器直连被 CORS 拦截，走 vite dev/preview 的同源代理 `/nim` 转发；
  - **自定义**：任何 OpenAI 兼容端点（OpenAI / DeepSeek / 本地 Ollama 等），可拉取模型列表。
- **额度友好**：仅在用户显式点击「运行 AI 转化 / 测试连接」时才发起请求；「测试连接」是 max_tokens=8 的极小请求；结果按课时缓存，材料变化时提示重跑。
- 免费模型有平台侧每日次数限制（按账号计），可用性逐日波动；多模型自动回退（仅鉴权失败终止）。

### 按章整合

实际使用中常把**一整章**一次性喂给豆包爱学，逐节复制过于繁琐。顶栏「📑 按章整合」打开对话框：

- **取材**：每课时自动采用「AI 稿优先、编译稿兜底」（可切换为只用编译稿 / 只用 AI 稿）。
- **整合**：各课时提示词**按课时顺序原样合并**（聚合而非重写，不丢知识点），外加外层协调说明；未生成提示词的课时保留占位说明并禁止模型虚构该节。
- **缓存**：整合稿按（项目, 章节）缓存，刷新不丢；课时材料变化时提示「已过期」，一键重新整合。
- **使用**：整合稿可手动编辑（只影响缓存与本次复制/导出）；「复制整合稿」整段粘贴，「导出 MD」落盘备份。

## 快速开始

要求：Node.js 22+，Chrome / Edge（本地 `localhost` 运行）。

```bash
npm install        # 安装依赖
npm run dev        # 开发服务器
```

可选：如需使用 AI 转化，复制 `.env.example` 为 `.env.local` 并填入 API Key（也可在应用「AI 设置」中填写，后者优先）。

```bash
npm run build      # 生产构建（含类型检查）
npm run preview    # 预览生产构建
```

## 开发

```bash
npm run check      # typecheck + lint + format:check + test
npm run test       # vitest（单次）
npm run test:watch # vitest（监听）
npm run lint       # eslint
npm run format     # prettier
```

### 工程约定

- `src/core/**` 为纯函数（禁浏览器 IO），IO 收敛在 `import / persist / export / ai` 边界层。
- 保真不变量（B/P/T/K/U 系列）见 [docs/ARCHITECTURE-BASELINE.md](docs/ARCHITECTURE-BASELINE.md)，全部有自动化测试锁定。
- 项目状态与路线图见 [docs/STATUS-LEDGER.md](docs/STATUS-LEDGER.md)；各阶段验收记录见 [docs/ACCEPTANCE-*.md](docs/)。
- 用户的真实课程笔记放 `fixtures-real/`（已 gitignore，不入库）。
- `.env.local`（gitignored）存放本机私密配置（如 API Key），模式参考 `.env.example`。

## 隐私与安全

- 原始笔记只读导入；编译与解析全部在本地完成，默认零第三方上传。
- 唯一网络外联是 AI 转化，且仅在你显式点击时、仅向你在「AI 设置」中选择的供应商发请求；生产 CSP 限制其余资源零外联。
- AI 请求内容为该课时的编译稿或原文笔记文本，请自行评估是否包含敏感信息。

## License

[MIT](LICENSE)
