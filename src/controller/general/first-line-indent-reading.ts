/**
 * MDRazor — 通用：首行缩进 / 阅读视图逐行缩进（DOM 后处理）
 *
 * ── 为什么需要这个模块 ──
 *
 * 非严格换行（Obsidian 默认）下，单个回车在阅读视图里只是 `<p>` 内的一个
 * `<br>`（Obsidian 用 markdown-it 的 `breaks: !strictLineBreaks`），而
 * `<br>` 之后的文本**拿不到 `text-indent`** —— 以下做法全部实测无效：
 *   ① `br { display: block }`；
 *   ② `br::after { content: "\\3000\\3000" }`（两个全角空格；`<br>` 上的伪元素根本不渲染）；
 *   ③ 把 `<p>` 改成纵向 flex 容器让 `<br>` 成为独立 flex 项；
 *   ④ 用 `<span style="display:block">` 切出匿名块盒（匿名块盒不应用 `text-indent`）。
 * 所以「每个单回车行都缩进」在阅读视图里只能靠 DOM：在正文段落里每个 `<br>`
 * 之后插入一个**空的 inline-block 占位元素**把后续文本撑出缩进。
 *
 * ── 为什么用占位元素，而不是改写结构 ──
 *
 * 占位元素是**空节点**：不进文本内容（选中复制不受影响）、不搬动任何原有节点、
 * 不改变段落高度（实测 `display:inline-block; width:<n>em; height:0` 时段落高度与
 * 插入前逐像素一致），撤销只需删掉带类名的节点。
 *
 * ── 插入位置：必须在 `<br>` 之后那个换行符的**后面**（踩过的坑）──
 *
 * markdown-it 渲染软换行输出的是 `'<br>\n'`，这个换行符会被 HTML 解析器并进紧随
 * 其后的文本节点开头（`"\n乙段内容"`）。若把占位元素直接插在 `<br>` 与该文本节点
 * 之间，这段前导空白就不再位于行首、不会被「行首空白丢弃」规则吃掉，而是塌缩成
 * **一个空格**，把该行多推一个空格宽 —— 表现就是「阅读视图后续行的缩进比第一行多
 * 了一点点」（实测：1em 缩进下后续行左边界 44.73px vs 首行 40px，差值 4.73px 正是
 * 一个空格的宽度）。所以要把前导空白留在 `<br>` 之后、占位元素插在空白之后：
 * 遇到以空白开头的文本节点就 `splitText` 切开，锚点取切开后的内容那一半。
 *
 * ── 触发与幂等 ──
 *
 * 阅读视图的 DOM 由 Obsidian 每次渲染重建，故对每个 `.markdown-reading-view`
 * 挂一个 MutationObserver（rAF 合并），渲染完自动补；`apply()` 只在「需要补而
 * 没补 / 需要摘而没摘」时动 DOM，因此不会自激循环。
 *
 * 生效条件：功能开启 **且** Obsidian 处于非严格换行。严格换行下 `<br>` 只可能来自
 * 显式硬换行（行尾两空格 / `\`），那在 CommonMark 里仍属同一段落，不缩进 ——
 * 与实时预览侧「同段续行不缩进」的判定一致。
 */

import { type App, type Plugin } from 'obsidian';
import { forEachDocument } from './window-scope';
import { isNonStrictLineBreaks } from './first-line-indent';

/** 占位元素类名（styles.css 据它给宽度，撤销时据它查找） */
export const FIRST_LINE_INDENT_SPACER_CLASS = 'mdrazor-indent-spacer';

/**
 * 与 styles.css 的排除项保持一致：这些容器内的段落不缩进
 * （列表 / 引用 / callout / 表格单元格 / 图注 / 嵌入笔记）。
 */
const EXCLUDED_ANCESTOR =
	'li, blockquote, .callout, td, th, figcaption, .markdown-embed, .markdown-embed-content';

let appRef: App | null = null;
let enabledRef: (() => boolean) | null = null;
/** 已挂观察器的阅读视图容器（WeakSet：容器被丢弃后自动回收，不阻止 GC） */
const observedContainers = new WeakSet<Element>();
let observers: MutationObserver[] = [];
/** 本帧是否已排好一次重新应用（同一帧内多次 DOM 变更合并为一次） */
let applyScheduled = false;

/** 该节点是否是本模块插入的占位元素 */
function isSpacer(node: Node): boolean {
	return (node as Element).classList?.contains(FIRST_LINE_INDENT_SPACER_CLASS) === true;
}

/**
 * 是否是「阅读视图里的正文段落」：要求 `.markdown-reading-view` 祖先（排除
 * 第三方视图借类复用的容器），且不在列表 / 引用 / callout / 表格 / 嵌入等
 * 非正文容器内。
 */
function isBodyParagraph(p: Element): boolean {
	if (p.closest('.markdown-reading-view .markdown-preview-view') === null) return false;
	return p.closest(EXCLUDED_ANCESTOR) === null;
}

/** 该节点是否是「整段都是可折叠空白」的文本节点 */
function isWhitespaceText(node: Node): boolean {
	return node.nodeType === Node.TEXT_NODE && (node as Text).data.trim() === '';
}

/**
 * 给容器内所有正文段落的 `<br>` 之后补占位元素（已存在的跳过）。
 *
 * 插入位置见 spacerAnchorAfter 的注释：必须让 markdown-it 输出的那个换行符
 * 留在 `<br>` 之后（行首），否则它会塌缩成一个空格、把该行多推一个空格宽。
 */
function addSpacers(container: ParentNode): void {
	for (const br of container.querySelectorAll('p > br')) {
		const p = br.parentElement;
		if (!p || !isBodyParagraph(p)) continue;

		// 从 `<br>` 往右扫：跳过空白与已插入的占位元素。扫到占位元素 = 已处理；
		// 扫到有内容的节点 = 未处理（它就是插入锚点）；扫到末尾 = 段尾换行，无需缩进。
		let node: Node | null = br.nextSibling;
		let handled = false;
		while (node !== null && (isWhitespaceText(node) || isSpacer(node))) {
			if (isSpacer(node)) {
				handled = true;
				break;
			}
			node = node.nextSibling;
		}
		if (handled || node === null) continue;

		// 以空白开头的文本节点：切开，让前导空白留在 `<br>` 之后（行首空白会被丢弃）
		let anchor: Node = node;
		if (node.nodeType === Node.TEXT_NODE) {
			const text = node as Text;
			const lead = text.data.length - text.data.trimStart().length;
			if (lead > 0) anchor = text.splitText(lead);
		}
		// anchor 与 `<br>` 是兄弟，故同为 p 的直接子节点
		p.insertBefore(
			createSpan({ cls: FIRST_LINE_INDENT_SPACER_CLASS, attr: { 'aria-hidden': 'true' } }),
			anchor,
		);
	}
}

/** 摘掉容器内所有占位元素 */
function removeSpacers(container: ParentNode): void {
	for (const el of container.querySelectorAll('.' + FIRST_LINE_INDENT_SPACER_CLASS)) el.remove();
}

/** 单个窗口：按当前设置补或摘占位元素 */
function applyToDocument(doc: Document): void {
	const want = (enabledRef?.() ?? false) && appRef !== null && isNonStrictLineBreaks(appRef);
	for (const container of doc.querySelectorAll('.markdown-reading-view .markdown-preview-view')) {
		if (want) addSpacers(container);
		else removeSpacers(container);
	}
}

/** 给新出现的阅读视图容器挂观察器（已挂的跳过） */
function observeReadingViews(): void {
	if (appRef === null) return;
	forEachDocument(appRef, (doc) => {
		for (const view of doc.querySelectorAll('.markdown-reading-view')) {
			if (observedContainers.has(view)) continue;
			observedContainers.add(view);
			const observer = new MutationObserver(scheduleApply);
			observer.observe(view, { childList: true, subtree: true });
			observers.push(observer);
		}
	});
}

/** 同一帧内合并多次 DOM 变更，延迟到 rAF 再重新应用 */
function scheduleApply(): void {
	if (applyScheduled) return;
	applyScheduled = true;
	window.requestAnimationFrame(() => {
		applyScheduled = false;
		applyFirstLineIndentReading();
	});
}

/**
 * 重新应用阅读视图的逐行缩进（幂等）。
 *
 * 由 controller/main.ts 的 applyRuntimeClasses() 统一调用 —— 即 saveSettings
 * （设置开关 / 宽度变化）、workspace layout-change（新开窗口）、设置面板 display()
 * 三处；此外 `strictLineBreaks` 配置变化时也会调一次。同时顺带给新出现的
 * 阅读视图补挂观察器。
 */
export function applyFirstLineIndentReading(): void {
	if (appRef === null) return;
	observeReadingViews();
	forEachDocument(appRef, applyToDocument);
}

/**
 * 注册阅读视图逐行缩进（onload 调用）。
 *
 * @param plugin    Plugin 实例（取 app 覆盖所有窗口）
 * @param isEnabled 设置读取器：设置切换无需重注册
 */
export function registerFirstLineIndentReading(plugin: Plugin, isEnabled: () => boolean): void {
	appRef = plugin.app;
	enabledRef = isEnabled;
	applyFirstLineIndentReading();
}

/** 插件卸载时清理：断开观察器并摘掉所有占位元素 */
export function removeFirstLineIndentReading(): void {
	for (const observer of observers) observer.disconnect();
	observers = [];
	if (appRef !== null) forEachDocument(appRef, removeSpacers);
}
