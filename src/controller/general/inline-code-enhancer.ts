/**
 * MDRazor — 行内代码增强（Controller）
 *
 * 需求：双击编辑器中的行内代码时，自动复制其完整内容（不含反引号）到
 * 剪贴板，弹出「已复制」提示；不改动光标与选区 —— 双击选词等原生行为
 * 完整保留，本模块只在原生行为之外补一次复制。
 *
 * 实现要点：
 *   - 挂 CM6 dblclick 事件（domEventHandlers，随视图生命周期自动清理），
 *     只读文档、不派发事务、不 preventDefault：原生双击选词先完成，随后
 *     按整段行内代码复制（内容可能比被双击选中的词更长）。
 *   - 触发条件：双击且无修饰键。Shift/Ctrl/Alt/Meta 双击（扩展选词等）、
 *     单击与拖选均交给原生行为。
 *   - 命中检测走 DOM（.cm-inline-code 是 Obsidian 行内代码的权威类，围栏
 *     代码块没有该类，天然排除）；内容区间走语法树（format-hider 同款
 *     「formatting-code + inline-code」标记配对，生产验证过的检测方式），
 *     不依赖具体 DOM 结构 —— 无论外层 span 覆盖反引号还是仅覆盖内容，
 *     配对出的 [开标记末, 闭标记首] 都准确指向反引号之间的代码。
 *   - 语法树未命中时（树尚未解析到该区域 / 节点命名变化）退回 DOM 边界
 *     估算：posAtDOM 取 span 文档区间后从两端剥离反引号，任何一步失败
 *     都直接放行原生行为（正确性优先，与 format-hider 的排除策略一致）。
 *
 * 范围：仅编辑器（实时预览 / 源码模式）。阅读模式没有本模块的挂载点，
 * 不做处理。
 */

import { Notice, Plugin } from 'obsidian';
import { EditorView } from '@codemirror/view';
import type { EditorState, Extension } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { tr } from '../../i18n';

/** 设置读取器（registerInlineCodeEnhancer 传入；null = 尚未注册） */
let isEnabledRef: (() => boolean) | null = null;

/**
 * 注册行内代码增强（onload 调用一次）。
 *
 * 扩展始终注册，每次双击即时探测设置开关 —— 设置切换无需重注册，
 * 与 mouse-line-highlight 的 reader 模式一致。
 *
 * @param plugin    Plugin 实例（registerEditorExtension 保证卸载时自动清理）
 * @param isEnabled 设置读取器
 */
export function registerInlineCodeEnhancer(plugin: Plugin, isEnabled: () => boolean): void {
	isEnabledRef = isEnabled;
	plugin.registerEditorExtension(createInlineCodeEnhancerExtension());
}

/**
 * 创建「行内代码增强」扩展。
 */
function createInlineCodeEnhancerExtension(): Extension {
	return EditorView.domEventHandlers({
		dblclick: (event, view) => {
			handleDoubleClick(event, view);
		},
	});
}

function handleDoubleClick(event: MouseEvent, view: EditorView): void {
	if (!isEnabledRef?.()) {
		return;
	}
	// 带修饰键的双击（Shift 扩展选词、Ctrl/Meta 组合操作等）交给原生行为
	if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
		return;
	}
	// 第二击落在文本节点上时 event.target 不是 Element，回退父元素后才能 closest
	const rawTarget: unknown = event.target;
	const target =
		rawTarget instanceof Element ? rawTarget : rawTarget instanceof Node ? rawTarget.parentElement : null;
	if (!target || typeof target.closest !== 'function' || !view.contentDOM.contains(target)) {
		return;
	}
	// DOM 闸门：行内代码（反引号标记 span 自身也带 cm-inline-code，一并命中；
	// 围栏代码块没有该类，天然排除）
	const codeEl = target.closest<HTMLElement>('.cm-inline-code');
	if (!codeEl || !view.contentDOM.contains(codeEl)) {
		return;
	}

	// 双击点 → 文档位置：仅用于定位命中的是哪一段行内代码（DOM 闸门已确认
	// 双击在代码上），故用非精确模式提高命中率；偶发 null（坐标在视图外等）
	// 时退回所在行行首
	const lineEl = codeEl.closest<HTMLElement>('.cm-line');
	let pos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
	if (pos === null && lineEl) {
		pos = view.posAtDOM(lineEl, 0);
	}
	if (pos === null) {
		return;
	}

	const range = inlineCodeContentRange(view.state, pos) ?? domContentRange(view, codeEl);
	if (!range || range.from >= range.to) {
		return; // 未命中区间 / 空行内代码（``）：无内容可复制，放行原生行为
	}

	// 光标与选区保持原生（双击选词不受影响），只复制整段行内代码内容
	const content = view.state.doc.sliceString(range.from, range.to);
	navigator.clipboard.writeText(content).then(
		() => new Notice(tr('已复制', 'Copied')),
		(e) => {
			console.error('MDRazor: 行内代码复制失败', e);
			new Notice(tr('复制失败，请手动复制', 'Copy failed; please copy manually'));
		},
	);
}

/**
 * 语法树求内容区间：收集「formatting-code + inline-code」标记（与
 * format-hider 同款检测 —— 围栏代码块标记名为 formatting-code-block，不含
 * inline-code，天然排除），按位置配对，命中 pos 的那一对即一段行内代码，
 * 内容 = [开标记末, 闭标记首]。
 *
 * @returns 内容区间；未命中（含空代码 ``）返回 null
 */
function inlineCodeContentRange(state: EditorState, pos: number): { from: number; to: number } | null {
	const marks: Array<{ from: number; to: number }> = [];
	syntaxTree(state).iterate({
		enter(node) {
			const name = node.type.name;
			if (name.includes('formatting-code') && name.includes('inline-code')) {
				marks.push({ from: node.from, to: node.to });
			}
		},
	});
	marks.sort((a, b) => a.from - b.from);
	// 标记两两配对（奇数个时末尾落单的忽略），命中 pos 的一对即目标
	for (let i = 0; i + 1 < marks.length; i += 2) {
		const open = marks[i]!;
		const close = marks[i + 1]!;
		if (open.from <= pos && pos <= close.to && open.to <= close.from) {
			return { from: open.to, to: close.from };
		}
	}
	return null;
}

/**
 * 兜底：语法树未命中时用行内代码 span 的 DOM 边界估算内容区间。
 * span 文档区间两端从源文本剥离反引号；剥不出（结构异常 / 未闭合）返回 null。
 * 反引号标记 span 自身也带 cm-inline-code，先向上找到不带 cm-formatting 的外层。
 */
function domContentRange(view: EditorView, codeEl: HTMLElement): { from: number; to: number } | null {
	let outer = codeEl;
	while (outer.classList.contains('cm-formatting')) {
		const parent = outer.parentElement?.closest<HTMLElement>('.cm-inline-code');
		if (!parent || parent === outer) {
			return null;
		}
		outer = parent;
	}
	try {
		const from = view.posAtDOM(outer, 0);
		const to = view.posAtDOM(outer, outer.childNodes.length);
		// 富文本/替换装饰可能拆散区间映射，边界倒挂即放弃（正确性优先）
		if (from >= to) {
			return null;
		}
		const m = /^(`+)([\s\S]*?)(`+)$/.exec(view.state.doc.sliceString(from, to));
		if (!m) {
			return null;
		}
		return { from: from + m[1]!.length, to: to - m[3]!.length };
	} catch {
		return null; // 视图失效等异常：放弃兜底，不扩散
	}
}