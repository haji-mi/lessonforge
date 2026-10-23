# Classroom Compiler（Obsidian → 豆包爱学互动课堂编译器）

本地优先的 Markdown 课程解析与互动课堂提示词编译工具。将 Obsidian 课程资料转换为按课时组织的互动课堂提示词，可预览、编辑、复制后粘贴到豆包爱学。

- 架构权威参考：[docs/ARCHITECTURE-BASELINE.md](docs/ARCHITECTURE-BASELINE.md)
- 约束：本地运行（Chrome/Edge + localhost），默认零第三方上传，原始笔记只读，用户编辑永不静默覆盖。

## 开发

```bash
npm install        # 安装依赖
npm run dev        # 开发服务器
npm run check      # typecheck + lint + format:check + test
npm run build      # 生产构建（含类型检查）
npm run preview    # 预览生产构建
```

## 工程约定

- 核心规则：`src/core/**` 为纯函数（禁浏览器 IO），IO 收敛在 `import/persist/export` 边界层。
- 保真不变量（B/P/T/K/U 系列）见架构基线 §3，全部有自动化测试锁定。
- 用户提供的三篇真实课程笔记放 `fixtures-real/`（已 gitignore，不入库）。
