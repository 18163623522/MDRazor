/**
 * MDRazor — Callout 源码解析（纯函数层）
 *
 * callout-enhancer 用到的「行文本级」判定与剥离，不依赖 EditorView /
 * Obsidian，可被离线回归脚本直接打包测试（scripts/verify-callout-parse.mjs）。
 *
 * ── 行首零宽字符宽容化（触屏用户报告，2026-10）──
 *
 * 从网页复制的正文常携带不可见的格式字符（ZWSP / ZWNJ / ZWJ / word
 * joiner / 软连字符等）。它们**不在 JS `\s` 字符类里**（`\s` 含
 * U+2000–U+200A 与 U+FEFF，但不含 U+200B–U+200D 与 U+2060），正文行行首
 * 混入后 `^\s*>` 不再匹配——该行被逐出「引用行」范围，编辑面板的正文
 * 收集提前终止，**静默打开成空正文**；而 Obsidian 的渲染管线对这些字符
 * 的处理不同，块仍渲染为带正文的 callout，两边不一致。故行首匹配统一
 * 放行这组字符（识别为引用行 / 剥前缀 / 头部正则三处同步），正文内容
 * 本身原样保留，不增删任何可见字符。
 *
 * 技术实现用 Unicode 属性转义 `\p{Cf}`（General_Category=Format，u 标志）：
 * 上述零宽字符全部属于 Cf，且它天然覆盖同一性质的其他不可见格式字符
 * （LRM/RLM、双向隔离符等，同样是 `\s` 之外的「隐形污染」）。不用
 * `[\u200b\u200c\u200d…]` 枚举——裸 ZWJ 在字符类里会触发 eslint
 * no-misleading-character-class（那条规则防的是 emoji 组合误配，此处
 * 语义恰恰是要匹配裸字符，用属性转义既准确又无误报）。
 */

/** callout 首行：可选缩进（含格式字符）+ `>` + `[!type]` + 可选折叠标记 + 可选标题 */
export const CALLOUT_HEADER_RE =
	/^([\s\p{Cf}]*>\s?)\[!([^\]]+)\]([+-]?)\s?(.*)$/u;

/** 引用行（用于确定 callout 源码区间边界） */
export const QUOTE_LINE_RE = /^[\s\p{Cf}]*>/u;

/** 该行是否为引用行（容忍行首不可见格式字符，见模块注释） */
export function isQuoteLine(text: string): boolean {
	return QUOTE_LINE_RE.test(text);
}

/**
 * 剥掉一行中的引用前缀：缩进（含格式字符）+ `>` + 至多一个空白/格式字符。
 *
 * 与原 `^\s*>\s?` 语义一致（`>` 后只剥一个字符，`>   foo` 保留两个空格的
 * 缩进对齐），只是缩进与「第一个空白位」同时容忍不可见格式字符。
 */
export function stripQuotePrefix(text: string): string {
	return text.replace(/^[\s\p{Cf}]*>[\s\p{Cf}]?/u, '');
}
