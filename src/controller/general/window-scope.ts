/**
 * MDRazor — 通用：多窗口 document 遍历
 *
 * 背景：本插件的「body 开关类 + CSS 变量」运行态是挂在 `document.body` 上的
 * （styles.css 以 `body.<类>` 限定规则）。原先一律只挂 `activeDocument.body`，
 * 即**只覆盖「当前活动窗口」**：popout / 悬浮编辑器窗口里的编辑器拿不到这些类，
 * 表现为「那些窗口里开关不生效」，要等焦点换过去（或重启）才可能恢复。
 * 正确做法是把运行态挂到**所有已打开窗口**的 document 上。
 *
 * 为什么不用 `instanceof Document` 判定：popout 的 document 来自另一个
 * realm（独立 JS 上下文），跨 realm 的 `instanceof` 会失败。这里统一走
 * `node.ownerDocument ?? node`（Document 的 ownerDocument 为 null，故回落到自身）。
 */

import type { App } from 'obsidian';

/**
 * 遍历当前所有 Obsidian 窗口的 document（主窗口 + 各 popout / 悬浮编辑器窗口），
 * 按 document 去重后依次回调。
 *
 * @param app App 实例（借 workspace.iterateAllLeaves 覆盖各窗口的视图容器）
 * @param fn  对每个 document 执行的回调（应幂等）
 */
export function forEachDocument(app: App, fn: (doc: Document) => void): void {
	const seen = new Set<Document>();
	const visit = (node: HTMLElement | Document | null | undefined): void => {
		if (!node) return;
		const doc = node.ownerDocument ?? node;
		if (!doc.body || seen.has(doc)) return;
		seen.add(doc);
		fn(doc);
	};

	visit(document);
	// activeDocument 是 Obsidian 注入的全局（跟随当前活动窗口）；单独 visit 一次，
	// 保证「活动窗口」一定被覆盖（该窗口此刻可能还没有任何 leaf）。
	// typeof 守卫让本模块在无 Obsidian 全局的宿主里也能跑（离线测试台）。
	if (typeof activeDocument !== 'undefined') visit(activeDocument);
	app.workspace.iterateAllLeaves((leaf) => visit(leaf.view.containerEl));
}
