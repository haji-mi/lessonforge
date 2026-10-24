/**
 * 真实笔记线索常量与文本净化（K2 试验期）。
 * 2026-10-24 首轮校准：依据用户真实线性代数笔记（NotebookLM 风格：
 * 「**加粗术语**：解释」列表、性质表格、⚠️ 提醒引用块、加粗步骤段）。
 *
 * 全部确定性正则；行首线索一律在净化文本上匹配——先去列表/引用前缀，
 * 再去强调标记，使 `**定义**：` 与 `定义：`、`- 因为…` 与 `因为…`
 * 命中同一线索。
 */

/** 行首线索用净化：去强调/代码/标题标记 */
export function stripMarkers(text: string): string {
  return text.replace(/[*_`~#]/g, '')
}

/** 去列表项/引用行前缀（缩进、>、- 、* 、+ 、1. ；标记后须跟空白，避免吞掉加粗 `**`） */
export function stripListPrefix(text: string): string {
  return text.replace(/^[\s>]*(?:[-*+]|\d+[.)])\s+/, '')
}

export interface BoldLead {
  /** 加粗引导语（如 定义 / 性质 1 / 第一步） */
  lead: string
  /** 引导语之后的正文（含子项原文） */
  body: string
}

/** 识别 `**术语**：内容` 形式（冒号可在加粗内部 `**第一步：**` 或外部 `**统称**：`；
 * 须在去前缀、未去标记的文本上调用；无冒号的强调句不算引导语） */
export function boldLeadOf(afterPrefix: string): BoldLead | null {
  const m = /^\*\*(.+?)[:：]?\*\*\s*[:：]?\s*([\s\S]*)$/.exec(afterPrefix)
  return m ? { lead: m[1]!.replace(/[:：]\s*$/, ''), body: m[2]! } : null
}

/** 线索正则（K2 试验期；修改须同步 tests/p3-infer-classify-mku.test.ts 校准用例） */
export const CUES = {
  exerciseStart: /^\s*(练习|习题|思考|作业|巩固)/,
  exampleStart: /^\s*(例\s*\d*|例题|【例)/,
  solutionStart: /^\s*解\s*[:：]/,
  cautionStart: /^\s*(注意|易错|常见错误|小心|警示|避坑)/,
  propStart: /^\s*(其中|记|设|令|性质|特点|特征)/,
  /** 推导链行首词（列表项为主） */
  derivStart: /^(由|因为|所以|因此|两式|化简|代入)/,
  /** 标题 → 推导区 */
  derivHeading: /证明|推导|引理/,
  /** 标题 → 例题区（真实笔记的「## 模型一」「### 【例题4】」） */
  exampleHeading: /例题|【例|例\s*\d|题型|模型/,
  /** 标题 → 定义区 */
  defHeading: /定义|概念|什么是/,
  /** 标题 → 性质/定理区（性质表格归属依据） */
  propHeading: /性质|定理|推论|法则|公式|判别|充要/,
  /** 文中定义线索（统称/记号类句式为真实笔记高频模式） */
  defCue: /定义为|是指|称之为|统称为|称为|叫做|所谓|简称|记作|记为|即为|定义\s*[:：]|【定义】/,
  /** 易错/提醒线索（⚠️ 引用块、避坑总结） */
  cautionCue: /注意|易错|常见错误|小心|警示|避坑|提醒|警告|⚠️|❗/,
  /** 加粗步骤引导（**第一步**：） */
  stepLead: /^第[一二三四五六七八九十百\d]+\s*步/,
  /** 加粗引导语 → 定义 */
  defLead: /定义|概念|含义|意义|什么是|统称/,
  /** 加粗引导语 → 性质/定理/方法类 */
  propLead:
    /性质|定理|推论|引理|法则|公式|结论|判别|充要|条件|特征|方法|思想|技巧|策略|思路|口诀|要点|关键|核心|标准|应用|记号/,
} as const
