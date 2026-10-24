# STATUS LEDGER —— 项目状态账本（跨会话交接的唯一权威）

> 每个工作会话开始时读本文件 + `docs/ARCHITECTURE-BASELINE.md` + `git log`；
> 结束时（自验收通过、提交完成后）**先更新本账本**，再执行链式交接。

最后更新：2026-10-24（会话 E：AI 转化功能——用户点名的 OpenRouter 免费模型提示词转化）

## 项目现状

Obsidian → 豆包爱学互动课堂提示词编译器。**P0–P5 + P6-lite + K2 首轮校准 + K3 二轮修复 + AI 转化完成**。
K3：对用户真实库全管线诊断出 10 类问题（占位/未纳入/静默丢弃/UI 静默失败）并全部修复，
真实库核心覆盖 99/208(48%) → **210/210(100%)**，详见 docs/ACCEPTANCE-K3-CALIBRATION.md。
AI 转化：工作台面板把编译稿/原文笔记交给 OpenRouter 免费模型生成「建议稿」（不写回编译稿），
多模型回退 + 显式触发省额度，CSP 唯一例外域 openrouter.ai，详见 docs/ACCEPTANCE-AI-TRANSFORM.md。

- 测试：**234/234 全绿**（含新增 ai-openrouter 21 个，全 mock 零真实网络）；`npm run check`（typecheck+lint+format+test）退出码 0。
- 真实数据验收：20 文件只读复刻管线复测——转写 0、硬失败 0、核心未纳入 0、related 未纳入 0；
  2-1 定义占位与 2-4 推导占位消失；2-2 标记 ambiguous（新 UI 提示人工确认课型）。
- 应用内真实验收（会话 E）：生产构建下真实调用成功（nemotron-3-ultra 75s 一次成功，920 字产出），
  编译稿未被动、缓存落 localStorage、设置对话框/回退明细 UI 正常。
- 提交：80b52ad(P0) → ae3d57f(P1) → c630b92(P2) → 09c6470(P3) → 62be249(P4) → e0f67f3(P5) → b51ea3f(P6-lite) → [K2/K3/AI 见 git log]。

## 工作方式（必读）

1. 运行 `npm run check` 必须**退出码 0** 才允许提交（不要用管道 tail 掩盖退出码——曾因此把类型错误提交进库）。
2. 架构唯一权威：`docs/ARCHITECTURE-BASELINE.md`（不变量 B/P/T/K/U 系列）。任何实现不得违反；发现基线与实践矛盾时，改基线并记录原因。
3. 纪律：原始笔记只读；默认零上传（CSP+断言）；用户编辑永不静默覆盖；测试未执行/未通过必须如实标记；不得伪造覆盖率或用户样本。
4. 每个工作包一个提交，信息写清楚做了什么+测试状态。

## 已完成（勿重做）

- ZIP 四类别名称解码/守卫式解压（spike 分支 A，定律见 docs/spike-p1.md）/目录导入/custody 字节保管
- Obsidian 语法（wikilink/embed/highlight/callout/tags/comments/math/frontmatter）+ 全源平铺（黄金集 100% + 变异测试）+ 预览渲染器
- 结构推断/课型分类/MKU 切分/提示词编译器（三类课型差异化 + A/B/C + T1 溯源硬校验）
- 持久化六场景/冲突裁决（U1/U2）/审批门禁（K2 试验期）/JSON 备份往返（B1 字节全等）
- 导出（剪贴板降级/单课 MD/批量 ZIP）/完整 UI/生产 CSP
- 人工补入（未纳入 MKU → A 段 + 溯源 + overlay）/批量编译
- 真实工具矩阵：PowerShell Compress-Archive 样本 PASS（UTF-8 标志路径）
- **K2 首轮真实笔记校准**（2026-10-24）：cues.ts 线索集中管理；列表项/加粗引导语/
  章节上下文/例题区有序步骤链/性质与考点表格/⚠️ 提醒块；分类器净化文本统计 +
  导航页检测；generic 兜底纳入 related；COMPILER_VERSION=2。真实库 19/19 转写清零。
- **K3 二轮修复**（2026-10-24）：「例如」不再误开例题区；defCue 补「定义了」；
  新增 derivLead（**【推导】**/证明）与「求法」标题；defLead/propLead 锚定首词；
  混合课型核心 MKU 以「补充·kind」环节兜底纳入（真实库核心覆盖 100%）；
  related 未纳入显式报告（uncoveredRelated + 覆盖面板）；推导课纳入性质与运算律、
  概念课纳入易错提醒、例题课纳入相关知识；变量说明列表前缀 bug 修复；
  批量编译点名报告失败课时；课型人工覆盖下拉 + ambiguous 警告（偏离基线 §7 硬阻断，
  见 ACCEPTANCE-K3 偏离记录）；COMPILER_VERSION=3。测试 213/213。
- **AI 转化功能**（2026-10-24，用户点名）：`src/ai/**` 边界层（settings/openrouter/transform）
  - AiPanel/AiSettingsDialog；免费模型按实测序列回退（仅 401 终止）；建议稿不写回编译稿（U1）；
    localStorage 按课时缓存 + 材料指纹过期提示；CSP 唯一例外 openrouter.ai（基线 §13 修订 8）；
    `.env.local`（gitignored）预置 Key + `.env.example` 模板。测试 234/234。

## 待办池（按优先级；会话 B 从这里领任务）

**可自主推进：**

1. **嵌入内容纳入编译上下文**（基线 §6 规则 2 的编译侧半边）：`expandEmbeds`（src/core/model/embeds.ts）已做解析/循环/缺失诊断，但编译器只把嵌入目标列进"前置回顾"，未拉取被嵌入文件的 MKU 作为课时上下文（A 段带跨文件 trace）。
2. **A 段原文净化呈现**：A 段内容保留 `* **术语**：` 等 Markdown 标记（保真优先），
   编译输出时可做只删标记不改字的净化（需保持 T1 trace 对应关系）。
3. **导航页的产品决策**：索引页/总览页（4 个）仍作为 generic 课时编译（K2/K3 决策）；
   是否在 UI 标记「导航页」或排除出课时列表，需用户拍板后实现。
4. **MKU 人工合并/拆分 UI**（基线 §3 K1 承诺"用户可合并/拆分单元，调整持久化"；当前只有排除与补入）。
5. **ensureLessons 性能**：当前每次加载对全部文件 parseDoc 提取信号（O(N) 解析）；应缓存信号或懒解析（大库 1000 文件场景）。
6. **E2E 硬化**：控制台错误监听（IAB 无 addInitScript，可考虑 evaluate 注入 window.onerror 采集器）；剪贴板自动化；K3 的课型下拉/覆盖面板新 UI 过一遍浏览器实测。
7. **用户使用文档**（面向教师：docs/USER-GUIDE.md）。
8. **大库性能测试**（1000 文件合成库导入→编译全程计时，基线 §11 有验收标准 <5s 导入）。

**被用户阻塞（不可自主完成，最终报告时向用户请求）：**

- **K2 校准第二轮输入**：用户在 UI 中核对 19 个课时的切分/课型结果，指出错误的
  课时与期望（第一轮已按真实笔记样式 A–E 修复，见 docs/ACCEPTANCE-K2-CALIBRATION.md）
- 豆包爱学真实粘贴测试（用户账号手动操作）
- Edge 环境验收（本机未装 Edge）
- 真实 ZIP 工具矩阵扩充（WinRAR/7-Zip/Bandizip 样本）

## 链式交接协议（用户指令，逐会话执行）

1. 从待办池领一个工作包（按优先级），完成开发 + 测试 + `npm run check` 退出码 0 → 提交。
2. **自验收**：对照基线 §11 与本账本逐项核对，结果如实写入 `docs/ACCEPTANCE-*.md`（通过/未通过/部分，禁止美化）。
3. 更新本账本（移除已完成项，记录新发现）。
4. **用 computer-use 插件在 ZCode 中开新会话**（同一项目 D:\Development\Classroom-compiler），输入交接指令：内容必须包含 (a) 本文件路径与"先读账本与基线"；(b) 下一工作包；(c) **同样的链式交接协议（含本条自身，使链条延续）**；(d) 终止条件。
5. **终止条件**：当待办池"可自主推进"为空、仅剩用户阻塞项时，**停止开新会话**，向用户提交最终报告，请求提供：三篇真实课程笔记、豆包爱学粘贴测试、Edge 环境、（可选）更多真实 ZIP 样本。
6. 交接后本会话即可结束；新会话从头执行本协议。

## 交接尝试记录（2026-10-24 会话 A → 会话 B）

- Computer Use 已成功：绑定 ZCode 窗口（pid 15968）、经"后退"导航找到主页视图、点击"新建任务"**成功打开新会话视图**（含输入框/发送按钮/项目选择器，项目已选定）。
- **硬阻塞**：电脑处于锁屏状态（前台=Windows 锁屏界面）→ 截图不可用、窗口无法激活、键盘输入被拒、React 输入框不处理合成文本（setValue/type 均未落地，发送后无新会话数据产生）。
- 已备好：docs/NEXT-SESSION-INSTRUCTION.md（可直接粘贴的完整交接指令）。
- **恢复方式（用户解锁电脑后任选其一）**：
  1. 直接把 NEXT-SESSION-INSTRUCTION.md 的指令段粘贴进已打开的新任务输入框发送（最快）；
  2. 让任一会话重试 Computer Use 交接（屏幕解锁后输入/键盘/截图恢复可用）。
- 后续会话执行链式交接时的注意：若再遇锁屏/隐藏窗口，勿反复重试输入——记录阻塞、留好 NEXT-SESSION-INSTRUCTION.md、向用户报告。

## 交接指令模板（开新会话时粘贴）

```
继续项目「Obsidian → 豆包爱学互动课堂编译器」（D:\Development\Classroom-compiler）。

先读 docs/STATUS-LEDGER.md（状态账本·唯一权威）与 docs/ARCHITECTURE-BASELINE.md（架构基线），再 git log 了解进度。

你的工作包：<从待办池领取的具体任务>

纪律：npm run check 退出码 0 才提交；遵守基线不变量（B/P/T/K/U）；原始笔记只读；零上传；用户编辑永不静默覆盖；测试状态如实标记。

完成后：自验收并写入 docs/ACCEPTANCE-*.md → 更新 STATUS-LEDGER.md → 用 computer-use 插件开下一个新会话（本项目），交接指令中包含同样的链式协议与终止条件。若待办池仅剩用户阻塞项，则停止链条，向用户提交最终报告并请求：三篇真实课程笔记、豆包爱学粘贴测试、Edge 环境、真实 ZIP 样本。
```
