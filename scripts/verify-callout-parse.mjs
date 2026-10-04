/**
 * MDRazor — Callout 源码解析离线回归
 *
 * 用法：`node scripts/verify-callout-parse.mjs`（或 `npm run verify:callout`）
 *
 * 为什么需要它：callout 就地编辑面板的标题 / 正文全部来自对源码行的
 * 「引用行识别 + 前缀剥离」。触屏用户报告：从网页复制的正文行首带零宽
 * 字符（ZWSP 等，不在 JS `\s` 字符类里）时，`^\s*>` 不再匹配——行被逐出
 * 引用块，面板**静默打开成空正文**（Obsidian 的渲染不受影响，两边不一致）。
 * 宽容化后（callout-parse.ts）行首放行 ZWSP/ZWNJ/ZWJ/word-joiner/软连字符，
 * 本脚本锁定这些行为：既防回归，也防「宽容过头吞掉用户正文」。
 *
 * 期望值来自模块注释里的语义约定（`>` 后至多剥一个字符，与原 `^\s*>\s?`
 * 一致），不从实现反推。callout-parse.ts 是纯函数层（无 import），可直接打包。
 */

import esbuild from 'esbuild';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const outfile = join(tmpdir(), 'mdrazor-callout-parse.cjs');

await esbuild.build({
	entryPoints: [join(root, 'src/controller/general/callout-parse.ts')],
	outfile,
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: 'node18',
	logLevel: 'warning',
});

const { CALLOUT_HEADER_RE, isQuoteLine, stripQuotePrefix } = await import(pathToFileURL(outfile).href);

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

// 用户报告中的实际形态（正文行行首混入零宽空格，Obsidian 渲染不受影响）
const ZWSP = '\u200b';

console.log('① 引用行识别 isQuoteLine');
check('普通引用行 `> a`', isQuoteLine('> a'), true);
check('缩进引用行 `  > a`', isQuoteLine('  > a'), true);
check('紧凑引用行 `>a`', isQuoteLine('>a'), true);
check('行首零宽空格 `' + ZWSP + '> a`（报告的 bug 形态）', isQuoteLine(`${ZWSP}> a`), true);
check('行首空白+零宽 ` \\u200b> a`', isQuoteLine(' \u200b> a'), true);
check('行首软连字符 `\\u00ad> a`', isQuoteLine('\u00ad> a'), true);
check('正文中间的 `>` 不算（`a > b`）', isQuoteLine('a > b'), false);
check('空行不算', isQuoteLine(''), false);
check('纯空白行不算', isQuoteLine('   '), false);

console.log('② 引用前缀剥离 stripQuotePrefix');
check('`> body` → `body`', stripQuotePrefix('> body'), 'body');
check('`>  body` 只剥一个空格（保留缩进对齐）', stripQuotePrefix('>  body'), ' body');
check('`  > body` → `body`', stripQuotePrefix('  > body'), 'body');
check('`>body` → `body`', stripQuotePrefix('>body'), 'body');
check('`' + ZWSP + '> body` → `body`（宽容化核心）', stripQuotePrefix(`${ZWSP}> body`), 'body');
check('`' + ZWSP + '>` + ZWSP + `body`：`>` 后剥一个零宽', stripQuotePrefix(`${ZWSP}>\u200bbody`), 'body');
check('`> ` + ZWSP + `body`：`>` 后只剥一个字符，零宽留在正文（不吞内容）', stripQuotePrefix(`> ${ZWSP}body`), `${ZWSP}body`);
check('非引用行原样', stripQuotePrefix('no quote'), 'no quote');

console.log('③ callout 头部 CALLOUT_HEADER_RE');
const head = CALLOUT_HEADER_RE.exec('> [!note] Title');
check('规范头部匹配', Boolean(head), true);
check('prefix 捕获 `> `', head?.[1], '> ');
check('type 捕获 `note`', head?.[2], 'note');
check('fold 捕获空', head?.[3], '');
check('title 捕获 `Title`', head?.[4], 'Title');

const zwHead = CALLOUT_HEADER_RE.exec(`${ZWSP}> [!note] T`);
check('行首零宽的头部仍匹配（宽容化）', Boolean(zwHead), true);
check('prefix 捕获含零宽（提交时按原样写回）', zwHead?.[1], `${ZWSP}> `);

const metaHead = CALLOUT_HEADER_RE.exec('> [!tip|meta]- T');
check('type 捕获含元数据 `tip|meta`', metaHead?.[2], 'tip|meta');
check('fold 捕获 `-`', metaHead?.[3], '-');

check('非 callout 引用行不匹配（`> 普通引用`）', Boolean(CALLOUT_HEADER_RE.exec('> 普通引用')), false);
check('空标题头部匹配（`> [!note]`）', Boolean(CALLOUT_HEADER_RE.exec('> [!note]')), true);

console.log(failures.length === 0
	? '\n全部通过。'
	: `\n${failures.length} 项失败：\n  - ${failures.join('\n  - ')}`);
process.exitCode = failures.length === 0 ? 0 : 1;
