# 下一会话交接指令（可直接粘贴）

> 由会话 A（P0–P5 + P6-lite 完成后）于 2026-10-24 准备。
> 因电脑锁屏，Computer Use 无法将文本送入新会话输入框（详见 STATUS-LEDGER「交接尝试记录」）。
> 用户解锁后：新任务视图已打开，把下面整段粘贴进输入框并发送即可继续链条。

---

继续项目「Obsidian → 豆包爱学互动课堂编译器」（工作区 D:\Development\Classroom-compiler）。

先读 docs/STATUS-LEDGER.md（状态账本·唯一权威）与 docs/ARCHITECTURE-BASELINE.md（架构基线），再 git log 了解进度。若当前工作区不是该项目，请先切换/选择该项目。

你的工作包：从 STATUS-LEDGER.md「待办池」按优先级领取（首选：嵌入内容纳入编译上下文）。

纪律：npm run check 退出码 0 才允许提交；遵守基线不变量（B/P/T/K/U 系列）；原始笔记只读；默认零上传；用户编辑永不静默覆盖；测试状态如实标记；不要用管道 tail 掩盖 check 退出码。

完成后：自验收并写入 docs/ACCEPTANCE-*.md → 更新 STATUS-LEDGER.md → 用 computer-use 插件在 ZCode 中开下一个新会话（本项目），交接指令包含同样的链式协议与终止条件；若开新会话失败（如窗口隐藏/锁屏），如实记录并改用可行的延续方式。

终止条件：待办池仅剩用户阻塞项时停止链条，向用户提交最终报告，请求提供：三篇真实课程笔记、豆包爱学粘贴测试、Edge 环境验收、真实 ZIP 工具样本。
