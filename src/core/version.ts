/** 存储层数据模型版本（IndexedDB schema 迁移用） */
export const APP_MODEL_VERSION = 1

/** 解析器版本（影响 ParsedDoc 缓存有效性） */
export const PARSER_VERSION = 1

/** 提示词编译器版本（影响草稿 staleness 判定）
 * v2（2026-10-24）：MKU 切分/课型分类按真实笔记首轮校准（K2）——
 * 列表项与加粗引导语纳入线索解析、章节上下文、generic 兜底纳入相关知识块。
 * v3（2026-10-24）：二轮修复（K3）——「例如」不再误开例题区；「定义了/
 * 【推导】/证明/求法」等真实笔记写法纳入线索；混合课型核心 MKU 以「补充·」
 * 环节兜底纳入；related 层未纳入显式报告。
 */
export const COMPILER_VERSION = 3

/** 提示词脚手架结构版本（固定部分格式演进用） */
export const PROMPT_SCHEMA_VERSION = 1
