/**
 * MDRazor — 通用：当前行高亮（Controller）
 *
 * 需求：高亮编辑光标所在的行（CM6 自动给光标行挂 .cm-active，随光标
 * 移动自动更新），与鼠标位置无关；不启用 Custom.css 的
 * activeline-highlight（snippet）也能独立生效。默认关闭——避免与
 * Custom.css 同款效果两边叠加。
 *
 * 实现：纯 CSS body 开关类，无需事件监听与空闲计时器——「高亮哪一行」
 * 由 CodeMirror 的 .cm-active 类维护，插件只负责「是否开启」：
 *   - onload / 设置同步（syncConfig）时在活动窗口 body 上挂/摘
 *     `mdrazor-current-line-highlight` 常驻类（activeDocument：跟随当前
 *     活动窗口，popout / 悬浮编辑器窗口同样生效）；
 *   - styles.css 以 `body.mdrazor-current-line-highlight` 为前缀限定规则
 *     （与 Custom.css 的 activeline-highlight 同步：仅编辑器聚焦
 *     .cm-editor.cm-focused 时显示，失焦自动清除；双类名 .cm-active /
 *     .cm-activeLine 兼容 Obsidian 当前行装饰，含 CM5 旧版变体）；
 *   - 卸载时摘除 JS 添加的类。
 * 与「鼠标移动时行高亮」的区别：后者是活动瞬时效果（活动中挂、静止
 * 300ms 后消失），当前行高亮是跟随光标的常驻效果，只随设置开关变化。
 */

import { Plugin, type App } from 'obsidian';
import { forEachDocument } from './window-scope';

/** body 上的「当前行高亮」开关类：随设置常驻（styles.css 以此限定高亮规则生效） */
export const CURRENT_LINE_HIGHLIGHT_CLASS = 'mdrazor-current-line-highlight';

/** 设置读取器（registerCurrentLineHighlight 传入；null = 尚未注册） */
let isEnabledRef: (() => boolean) | null = null;

/**
 * 注册当前行高亮（onload 调用）：设置开启时立即挂类。
 * 无 DOM 事件监听——.cm-active 光标行状态由 CodeMirror 维护，
 * CSS 规则随 body 类常驻即时生效。
 *
 * @param plugin    Plugin 实例（取 app 以覆盖所有窗口的 document）
 * @param isEnabled 设置读取器：设置切换无需重注册
 */
export function registerCurrentLineHighlight(plugin: Plugin, isEnabled: () => boolean): void {
	isEnabledRef = isEnabled;
	applyCurrentLineHighlightClass(plugin.app);
}

/**
 * 设置变化后同步状态（saveSettings → syncConfig 调用）：
 * 开启挂类、关闭摘类。纯 classList 切换，即时生效，无需重绘编辑器。
 *
 * @param app App 实例：类挂到**所有已打开窗口**的 document（主窗口 + popout），
 *            只挂 activeDocument 会让 popout 里的编辑器拿不到样式
 */
export function applyCurrentLineHighlightClass(app: App): void {
	const enabled = isEnabledRef?.() ?? false;
	forEachDocument(app, (doc) => doc.body.classList.toggle(CURRENT_LINE_HIGHLIGHT_CLASS, enabled));
}

/** 插件卸载时清理（body 类由 JS 添加，需手动摘除） */
export function removeCurrentLineHighlightClass(app: App): void {
	forEachDocument(app, (doc) => doc.body.classList.remove(CURRENT_LINE_HIGHLIGHT_CLASS));
}
