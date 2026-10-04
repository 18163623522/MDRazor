/**
 * MDRazor — 列一体化「原子区间构建」离线回归
 *
 * 用法：`node scripts/verify-list-integration.mjs`（或 `npm run verify:list`）
 *
 * 为什么需要它：列一体化的全部行为（光标纠正、退格扩展、提升链、勾选框
 * 手势）都以 buildAtomicRanges 产出的原子区间为唯一依据。它对 HyperMD
 * `formatting-list` 节点的两个处理——「尾随空白收缩到标记 + 1 个空格」
 * 与「勾选框仅在紧邻列表标记时合并」——决定着标记后的多余空白是普通文本
 * （← 可逐格左移、退格逐格删除）还是被误判为格式的一部分（← 卡死、
 * 退格连删，2.6.7 及之前的实站 bug）。
 *
 * Obsidian 的语法树来自其内置 HyperMD 流式解析器，离线不可得；这里按
 * asar 实证的节点形态（formatting-list 从标记字符起、吞全部尾随空白；
 * formatting-task 为 `[·]` 三字符）手工构造等价语法树，把
 * buildAtomicRanges 打成 CJS 后在 Node 里直接跑断言。夹具的期望值以
 * 原生任务行正则（`^([>\s]*)(([*+-] |(\d+)([.)] ))(?:\[(.)\] )?)?`）的
 * 「格式 = 标记 + 恰好一个空格」语义为准，不从实现反推。
 */

import esbuild from 'esbuild';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const outfile = join(tmpdir(), 'mdrazor-list-atomic-ranges.cjs');

// shared.ts 依赖 @codemirror/language 的 syntaxTree 与 @codemirror/view 的
// EditorView（仅类型）。打包含真实依赖的包会拖进整条 CM6 运行时，这里用
// esbuild 插件把两者替换为可注入语法树的桩模块。
const mockPlugin = {
	name: 'mock-cm6',
	setup(build) {
		build.onResolve({ filter: /^@codemirror\/language$/ }, (args) => ({ path: args.path, namespace: 'mock' }));
		build.onResolve({ filter: /^@codemirror\/view$/ }, (args) => ({ path: args.path, namespace: 'mock' }));
		build.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => {
			if (args.path === '@codemirror/language') {
				return {
					contents: `
						let currentTree = null;
						export const syntaxTree = () => currentTree;
						// 经 globalThis 传递：esbuild 会摇掉 shared.ts 未引用的具名导出
						globalThis.__mdrazorTestSetTree = (t) => { currentTree = t; };
					`,
				};
			}
			return { contents: 'export class EditorView {}' };
		});
	},
};

await esbuild.build({
	entryPoints: [join(root, 'src/model/shared.ts')],
	outfile,
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node18',
	logLevel: 'warning',
	plugins: [mockPlugin],
});

const { buildAtomicRanges, listEnhancerConfig } = await import(pathToFileURL(outfile).href);
const __setSyntaxTree = globalThis.__mdrazorTestSetTree;

// ── 夹具构造 ─────────────────────────────────────────────────────────────

/** 按文档文本构造 buildAtomicRanges 用到的 doc 子集。 */
function makeDoc(text) {
	const lines = text.split('\n');
	const starts = [];
	let off = 0;
	for (const l of lines) {
		starts.push(off);
		off += l.length + 1;
	}
	const lineAt = (pos) => {
		let i = lines.length - 1;
		for (let j = 0; j < starts.length; j++) {
			const end = j + 1 < starts.length ? starts[j + 1] - 1 : text.length;
			if (pos >= starts[j] && pos <= end) {
				i = j;
				break;
			}
		}
		return { from: starts[i], to: starts[i] + lines[i].length, number: i + 1, text: lines[i] };
	};
	return {
		length: text.length,
		sliceString: (from, to) => text.slice(from, to),
		lineAt,
		line: (n) => lineAt(starts[n - 1]),
	};
}

/** 构造仅支持 iterate({enter}) 的最小语法树桩。 */
function makeTree(nodes) {
	return {
		iterate({ enter }) {
			for (const n of nodes) enter({ type: { name: n.name }, from: n.from, to: n.to });
		},
	};
}

const view = (text, nodes) => {
	const doc = makeDoc(text);
	__setSyntaxTree(makeTree(nodes));
	return { state: { doc } };
};

// ── 断言 ─────────────────────────────────────────────────────────────────

const failures = [];
const check = (label, actual, expected) => {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) {
		console.log(`  PASS  ${label}`);
	} else {
		console.log(`  FAIL  ${label}\n        期望 ${e}\n        实得 ${a}`);
		failures.push(label);
	}
};
const rangesOf = (v) => buildAtomicRanges(v).map((r) => [r.from, r.to]);

listEnhancerConfig.listIntegration = true;
listEnhancerConfig.checkboxIntegration = true;

console.log('① 列表标记尾随空白收缩（格式 = 标记 + 恰好一个空格）');
check('-   foo（节点吞 3 空格）→ 收缩到 `- `', rangesOf(view('-   foo', [{ name: 'formatting-list', from: 0, to: 4 }])), [[0, 2]]);
check('- foo（单空格）→ 原样', rangesOf(view('- foo', [{ name: 'formatting-list', from: 0, to: 2 }])), [[0, 2]]);
check('1.   foo（节点吞 3 空格）→ 收缩到 `1. `', rangesOf(view('1.   foo', [{ name: 'formatting-list', from: 0, to: 5 }])), [[0, 3]]);
check('10.  foo（两位序号）→ 收缩到 `10. `', rangesOf(view('10.  foo', [{ name: 'formatting-list', from: 0, to: 5 }])), [[0, 4]]);
check('-（无尾随空格的空项）→ 原样', rangesOf(view('-', [{ name: 'formatting-list', from: 0, to: 1 }])), [[0, 1]]);
check('-\t\tfoo（tab）→ 收缩保留一个空白', rangesOf(view('-\t\tfoo', [{ name: 'formatting-list', from: 0, to: 3 }])), [[0, 2]]);
check('嵌套缩进不进节点：`  -   foo` → `[2,4)`', rangesOf(view('  -   foo', [{ name: 'formatting-list', from: 2, to: 6 }])), [[2, 4]]);

console.log('② 勾选框合并（仅紧邻列表标记时）');
check('- [ ] foo 规范合并 `- [ ] `', rangesOf(view('- [ ] foo', [
	{ name: 'formatting-list', from: 0, to: 2 },
	{ name: 'formatting-task', from: 2, to: 5 },
])), [[0, 6]]);
check('-   [ ] foo 多空格不合并（复选框本就不渲染）', rangesOf(view('-   [ ] foo', [
	{ name: 'formatting-list', from: 0, to: 4 },
	{ name: 'formatting-task', from: 4, to: 7 },
])), [[0, 2], [4, 8]]);
check('- [x] 已完成任务同样合并', rangesOf(view('- [x] foo', [
	{ name: 'formatting-list', from: 0, to: 2 },
	{ name: 'formatting-task', from: 2, to: 5 },
])), [[0, 6]]);
check('- [ ] 行尾勾选框（无后随空格）合并到 `]`', rangesOf(view('- [ ]', [
	{ name: 'formatting-list', from: 0, to: 2 },
	{ name: 'formatting-task', from: 2, to: 5 },
])), [[0, 5]]);
check('1. [ ] 有序任务项合并', rangesOf(view('1. [ ] foo', [
	{ name: 'formatting-list', from: 0, to: 3 },
	{ name: 'formatting-task', from: 3, to: 6 },
])), [[0, 7]]);
check('task 文本非法（防御校验）→ 不产出勾选框区间', rangesOf(view('- [[] foo', [
	{ name: 'formatting-list', from: 0, to: 2 },
	{ name: 'formatting-task', from: 2, to: 5 },
])), [[0, 2]]);

console.log('③ 勾选框吸收规则（合并后列表标记不重复输出）');
check('- [ ] 吸收列表标记后不重复输出 [0,2)', rangesOf(view('- [ ] foo', [
	{ name: 'formatting-list', from: 0, to: 2 },
	{ name: 'formatting-task', from: 2, to: 5 },
])), [[0, 6]]);

console.log('④ 开关组合');
listEnhancerConfig.listIntegration = false;
listEnhancerConfig.checkboxIntegration = true;
check('仅勾选框一体化：独立勾选框照常产出并吞后一空格', rangesOf(view('- [ ] foo', [
	{ name: 'formatting-list', from: 0, to: 2 },
	{ name: 'formatting-task', from: 2, to: 5 },
])), [[2, 6]]);
listEnhancerConfig.listIntegration = true;
listEnhancerConfig.checkboxIntegration = false;
check('仅列一体化：只有收缩后的列表区间', rangesOf(view('-   [ ] foo', [
	{ name: 'formatting-list', from: 0, to: 4 },
	{ name: 'formatting-task', from: 4, to: 7 },
])), [[0, 2]]);
listEnhancerConfig.listIntegration = false;
listEnhancerConfig.checkboxIntegration = false;
check('双关 → 空数组', rangesOf(view('- foo', [{ name: 'formatting-list', from: 0, to: 2 }])), []);

console.log(failures.length === 0
	? '\n全部通过。'
	: `\n${failures.length} 项失败：\n  - ${failures.join('\n  - ')}`);
process.exitCode = failures.length === 0 ? 0 : 1;
