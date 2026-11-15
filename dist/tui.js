import { Plugin } from "@opencode/plugin/tui";
import { createSignal } from "solid-js";
import { Rpc } from "@opencode/plugin/rpc";
import * as ot from "@opentui/solid";
/** wf RPC 契约单点：state/list/read/exec 四方法 + updated/report 两事件（server 注册、TUI 调用同源）。 */
var Wf = Rpc.define({
	id: "wf",
	methods: {
		state: {
			input: {
				type: "object",
				properties: { sessionID: { type: "string" } },
				required: ["sessionID"],
				additionalProperties: false
			},
			output: {
				type: "object",
				properties: {
					sessionID: { type: ["string", "null"] },
					active: { type: "boolean" },
					slug: { type: "string" },
					phase: { type: ["string", "null"] },
					rounds: {
						type: "object",
						additionalProperties: true
					},
					testPlanWritten: { type: "boolean" },
					testReportVerdict: { type: ["string", "null"] },
					mode: { type: ["string", "null"] },
					size: { type: ["string", "null"] },
					planReviewVerdict: { type: ["string", "null"] },
					planConfirmedAt: { type: ["string", "null"] },
					artifacts: {
						type: "object",
						additionalProperties: true
					},
					tiers: {
						type: ["object", "null"],
						additionalProperties: true
					},
					updatedAt: { type: ["string", "null"] }
				},
				required: ["active"],
				additionalProperties: true
			}
		},
		list: {
			input: {
				type: "object",
				properties: {
					projectID: { type: "string" },
					directory: { type: "string" }
				},
				additionalProperties: false
			},
			output: {
				type: "object",
				properties: { sessions: {
					type: "array",
					items: {
						type: "object",
						properties: {
							sessionID: { type: "string" },
							slug: { type: "string" },
							phase: { type: ["string", "null"] },
							rounds: {
								type: "object",
								additionalProperties: true
							},
							testPlanWritten: { type: "boolean" },
							testReportVerdict: { type: ["string", "null"] },
							updatedAt: { type: ["string", "null"] }
						},
						required: ["sessionID"],
						additionalProperties: true
					}
				} },
				required: ["sessions"],
				additionalProperties: true
			}
		},
		read: {
			input: {
				type: "object",
				properties: {
					sessionID: { type: "string" },
					file: { type: "string" }
				},
				required: ["sessionID", "file"],
				additionalProperties: false
			},
			output: {
				type: "object",
				properties: {
					text: { type: "string" },
					bytes: { type: "integer" },
					path: { type: "string" },
					truncated: { type: "boolean" },
					error: { type: "string" }
				},
				required: ["text", "path"],
				additionalProperties: true
			}
		},
		exec: {
			input: {
				type: "object",
				properties: {
					sessionID: { type: "string" },
					name: { type: "string" },
					prompt: { type: "string" }
				},
				required: ["sessionID", "name"],
				additionalProperties: false
			},
			output: {
				type: "object",
				properties: {
					text: { type: "string" },
					at: { type: "string" },
					brief: { type: ["string", "null"] },
					level: { type: ["string", "null"] }
				},
				required: ["text"],
				additionalProperties: true
			}
		}
	},
	events: {
		updated: { schema: {
			type: "object",
			properties: {
				sessionID: { type: "string" },
				slug: { type: "string" },
				phase: { type: ["string", "null"] },
				rounds: {
					type: "object",
					additionalProperties: true
				}
			},
			required: ["sessionID"],
			additionalProperties: true
		} },
		report: { schema: {
			type: "object",
			properties: {
				sessionID: { type: "string" },
				text: { type: "string" },
				at: { type: "string" },
				brief: { type: ["string", "null"] },
				level: { type: ["string", "null"] }
			},
			required: [
				"sessionID",
				"text",
				"at"
			],
			additionalProperties: true
		} }
	}
});
/** RPC 事件 wire 名前缀（宿主桥路由字符串，禁各端散落字面量，rpc-drift 快照锁死）。 */
var RPC_EVENT_PREFIX = `rpc.${Wf.id}.`;
/** updated 事件完整 wire 名（流转/产物落盘广播）。 */
var RPC_EVENT_UPDATED = `${RPC_EVENT_PREFIX}updated`;
/** report 事件完整 wire 名（命令输出广播，机会性补充通道）。 */
var RPC_EVENT_REPORT = `${RPC_EVENT_PREFIX}report`;
// shared/version.ts
var VERSION = "M16-r47";
// shared/report.ts
/**
* 幂等消费键单一生成点：sessionID|at（TUI 去重/对账一致性的锚）。
* @param sessionID 会话 ID
* @param at 报告时刻（ISO）
* @returns 幂等消费键
*/
function reportId(sessionID, at) {
	return `${sessionID}|${at}`;
}
/**
* 去重器工厂（server/TUI 共用单实现，语义与原 TUI 行为逐字等价）：
* 过期跳过且不登记、重复跳过、首见登记（FIFO 淘汰最旧超 cap）并返回 true。
* @param opts ttlMs（默认 60s）/cap（默认 50）/now 时钟注入（测试用）
* @returns 携 seen(key, atMs?) 谓词的去重器
*/
function createDeduper(opts) {
	const ttlMs = opts?.ttlMs ?? 6e4;
	const cap = opts?.cap ?? 50;
	const now = opts?.now ?? Date.now;
	const map = /* @__PURE__ */ new Map();
	return { seen(key, atMs = Date.now()) {
		const t = now();
		if (Number.isFinite(atMs) && t - atMs > ttlMs) return false;
		if (map.has(key)) return false;
		map.set(key, atMs);
		if (map.size > cap) {
			const first = map.keys().next().value;
			if (first !== void 0) map.delete(first);
		}
		return true;
	} };
}
// tui/util.ts
/** 空值安全转字符串：null/undefined 归一为空串，其余 String()。
* @param v 任意输入值。
* @returns 字符串形式（null/undefined 归一为空串）。 */
var str = (v) => v === null || v === void 0 ? "" : String(v);
/** 任意抛出值转错误消息串（优先 Error.message，兜底 String(e)）。
* @param e 任意抛出值（catch 入参）。
* @returns 错误消息串。 */
var errMsg = (e) => String(e?.message ?? e);
/**
* 创建 TUI 调试探针：WF_DEBUG=1 时把诊断事件追加写入 .workflow/_debug/tui-refresh.log，默认关闭。
* @param context 宿主注入的插件上下文（取 location.directory 定位仓库根）。
* @param opts 选项对象。
* @param opts.build 当前构建版本号（随日志行落盘，便于跨重启对账）。
* @returns REPO（解析出的仓库根目录）与 probe（异步追加写日志的探针函数，失败静默不影响 UI）。
*/
function setupProbe(context, opts) {
	const REPO = String(context?.location?.directory ?? "") || decodeURIComponent(new URL(
		/* @vite-ignore */
		"../../",
		import.meta.url
	).pathname).replace(/\/$/, "");
	const LOADED_AT = (/* @__PURE__ */ new Date()).toISOString();
	let seq = 0;
	const PROBE_ON = process.env.WF_DEBUG === "1";
	const probe = (data) => {
		if (!PROBE_ON) return;
		(async () => {
			try {
				const fs = await import("node:fs");
				const dir = `${REPO}/.workflow/_debug`;
				fs.mkdirSync(dir, { recursive: true });
				fs.appendFileSync(`${dir}/tui-refresh.log`, JSON.stringify({
					at: (/* @__PURE__ */ new Date()).toISOString(),
					build: opts.build,
					loadedAt: LOADED_AT,
					seq: ++seq,
					...data
				}) + "\n");
			} catch {}
		})();
	};
	return {
		REPO,
		probe
	};
}
// shared/phases.ts
var PHASE_ORDER = [
	"intake",
	"planning",
	"review",
	"test_design",
	"building",
	"build_review",
	"testing",
	"fixing",
	"done"
];
/** 折叠映射：进度条上并入宿主阶段的阶段（reconcile→building、retrospect→done）。 */
var FOLD = {
	reconcile: "building",
	retrospect: "done"
};
/** canonical 产物名清单（三份核心 md，磁盘对账用）。 */
var CANON = [
	"plan.md",
	"test-plan.md",
	"test-report.md"
];
/** TUI 进度条阶段顺序（独立导出规避宿主 import-as 校验问题）。 */
var STAGE_ORDER = PHASE_ORDER;
/** daily 模式进度条 6 格阶段顺序（与 FLOWS_DAILY 可达 to 集一致，phases.test.js 守卫）。 */
var DAILY_STAGE_ORDER = [
	"intake",
	"planning",
	"review",
	"building",
	"testing",
	"done"
];
// shared/redact.ts
/**
* 会话 ID 零回显脱敏：ses_* 替换为「〔已隐去〕」（token 必不含 ses_ 子串，G-1 不变量）。
* @param text 任意文本
* @returns 脱敏后的文本
*/
function redactIds(text) {
	return String(text ?? "").replace(/ses_[A-Za-z0-9]+/g, "〔已隐去〕");
}
// tui/panel.tsx
var { createElement, insert, setProp } = ot;
/** 侧边栏恒定行数（表格化布局的行几何基准）。 */
var ROWS = 20;
/**
* 选择 toast/通知文案：brief 非空直接用；否则旧行降级（text 前两行各截 100 码点 + redactIds 脱敏）。
* @param d 报告负载（含 brief/text 字段）。
* @returns 呈现文案（无内容时返回空串）。
*/
function briefOf(d) {
	const b = str(d?.brief);
	if (b) return b;
	const text = str(d?.text);
	if (!text) return "";
	return text.split("\n").slice(0, 2).map((l) => {
		const cps = Array.from(l);
		return redactIds(cps.length > 100 ? cps.slice(0, 100).join("") + "…" : l);
	}).join("\n");
}
/** 行内文本消毒：折叠换行为空格并截前 200 字符（保证 textEl 插入文本恒非空）。
* @param s 原始文本。
* @returns 消毒后的单行文本（恒非空）。 */
var sanitize = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").slice(0, 200) || " ";
/**
* 计算字符串的终端显示宽度（CJK/全角/韩文按 2 cell，其余按 1）。
* @param s 待测量字符串。
* @returns 显示宽度（cell 数）。
*/
var dispW = (s) => {
	let w = 0;
	for (const ch of String(s ?? "")) {
		const c = ch.codePointAt(0) ?? 0;
		w += c >= 11904 && c <= 40959 || c >= 65280 && c <= 65376 || c >= 44032 && c <= 55215 ? 2 : 1;
	}
	return w;
};
/** 右侧补空格到目标显示宽度。
* @param s 原始字符串。
* @param w 目标显示宽度（cell 数）。
* @returns 右侧补空格后的字符串。 */
var padE = (s, w) => s + " ".repeat(Math.max(0, w - dispW(s)));
/** 左侧补空格到目标显示宽度（右对齐）。
* @param s 原始字符串。
* @param w 目标显示宽度（cell 数）。
* @returns 左侧补空格后的字符串。 */
var padS = (s, w) => " ".repeat(Math.max(0, w - dispW(s))) + s;
/** 按显示宽度截断并补齐（不切断 CJK 双宽字符）。
* @param s 原始字符串。
* @param w 目标显示宽度（cell 数）。
* @returns 截断并右补齐到目标宽度的字符串。 */
var fit = (s, w) => {
	let out = "";
	let acc = 0;
	for (const ch of String(s ?? "")) {
		const cw = dispW(ch);
		if (acc + cw > w) break;
		out += ch;
		acc += cw;
	}
	return padE(out, w);
};
/** 秒数格式化为 m:ss（负数钳 0，>16.6h 极端场景接受截断）。
* @param sec 秒数。
* @returns m:ss 格式串。 */
var fmtElapsed = (sec) => {
	const s2 = Math.max(0, Math.floor(sec));
	return `${Math.floor(s2 / 60)}:${String(s2 % 60).padStart(2, "0")}`;
};
var ZH = {
	intake: "需求录入",
	planning: "计划",
	review: "计划审核",
	test_design: "测试设计",
	building: "执行",
	reconcile: "合并",
	build_review: "执行审核",
	testing: "测试",
	fixing: "修复",
	done: "交付",
	retrospect: "交付",
	assign: "测试设计"
};
/** 阶段名转中文显示名（经 FOLD 归一；未知值回退原串或 ?）。
* @param phase 阶段名（任意值）。
* @returns 中文显示名。 */
var zhOf = (phase) => ZH[FOLD[phase] ?? phase] ?? str(phase ?? "?");
/** 状态标记符号：完成=✓、未完成=✗。
* @param ok 是否完成。
* @returns 状态符号（✓ 或 ✗）。 */
var mark = (ok) => ok ? "✓" : "✗";
/**
* 阶段名映射当前执行角色（经 FOLD 归一，reconcile=building；intake=leader 会话无派生角色）。
* @param ph 阶段名（可为 null）。
* @returns 角色 slug（如 "wf/builder"）或 null（未派生/未知阶段）。
*/
var roleOf = (ph) => ({
	planning: "wf/planner",
	review: "wf/planner-reviewer",
	test_design: "wf/tester",
	building: "wf/builder",
	reconcile: "wf/builder",
	build_review: "wf/builder-reviewer",
	testing: "wf/tester",
	fixing: "wf/fixer",
	done: "wf/learner",
	retrospect: "wf/learner"
})[FOLD[ph ?? ""] ?? ph ?? ""] ?? null;
/** 字节数格式化为 KB 串（一位小数、去尾零，如 0.5k/1.2k；非正数返回空串）。
* @param b 字节数（任意值，弱转 Number）。
* @returns KB 格式串；非正数返回空串。 */
var fmtKB = (b) => {
	const n = Number(b ?? 0);
	return n > 0 ? `${(n / 1024).toFixed(1).replace(/\.0$/, "")}k` : "";
};
/** 构造产物清单行（▸ + 名字 fit 18 + ✓/✗/免 + KB 大小）。
* @param name 产物文件名。
* @param ok 是否已记账/通过。
* @param kb KB 大小串（空串则不显示）。
* @param exempt 是否豁免（显示「免」）。
* @returns 产物清单行文本。 */
var artLine = (name, ok, kb, exempt) => `  ▸ ${fit(name, 18)} ${exempt ? "免" : mark(ok)}${exempt || !kb ? "" : ` ${kb}`}`;
/**
* 构造 text 文本节点（恒非空内容、wrapMode none，fg 可选，全部 fail-soft）。
* @param s 文本内容（经 sanitize 消毒）。
* @param fg 前景色（主题色值，可选）。
* @returns @opentui 的 text 元素。
*/
function textEl(s, fg) {
	const t = createElement("text");
	try {
		if (fg) setProp(t, "fg", fg);
	} catch {}
	try {
		setProp(t, "wrapMode", "none");
	} catch {}
	insert(t, [sanitize(s)]);
	return t;
}
/**
* 构造 box 容器节点（width 100%、column 布局，逐个插入非空子节点）。
* @param children 子节点数组（null/undefined/false 项跳过）。
* @param height 可选高度字符串（宿主不支持该 prop 时静默跳过）。
* @returns @opentui 的 box 元素。
*/
function boxEl(children, height) {
	const b = createElement("box");
	setProp(b, "width", "100%");
	if (height) try {
		setProp(b, "height", height);
	} catch {}
	setProp(b, "flexDirection", "column");
	for (const c of children) if (c !== null && c !== void 0 && c !== false) insert(b, c);
	return b;
}
var SyntaxStyleClass = null;
var syntaxStyleImportErr = "";
var syntaxStyleCache = /* @__PURE__ */ new Map();
import("@opentui/core").then((mod) => {
	SyntaxStyleClass = mod?.SyntaxStyle ?? null;
}, (e) => {
	syntaxStyleImportErr = errMsg(e);
});
/** 查询宿主组件目录是否有 markdown 组件（异常时返回 "unknown"）。
* @returns 是否有 markdown 组件；探测异常返回 "unknown"。 */
var hasMdCatalogue = () => {
	try {
		return !!ot.getComponentCatalogue?.().markdown;
	} catch {
		return "unknown";
	}
};
/**
* 构造 markdown 正文节点：先设 syntaxStyle（缓存按 nativeScene owner 分键）再设 content，
* 构造异常时销毁半成品并返回 null（调用方走纯文本逐行降级轨）。content 原文直喂不经 sanitize。
* @param content markdown 原文。
* @param onError 构造失败回调（携带错误信息与目录探测结果）。
* @param onStyle syntaxStyle 接线结果回调（ok/err/import-err 分型，仅进探针）。
* @returns markdown 元素，或 null（降级轨）。
*/
function mdEl(content, onError, onStyle) {
	let m = null;
	try {
		m = createElement("markdown");
		try {
			setProp(m, "width", "100%");
		} catch {}
		if (SyntaxStyleClass) try {
			const owner = m.ctx?.nativeScene;
			let ss = syntaxStyleCache.get(owner);
			if (ss === void 0) {
				ss = SyntaxStyleClass.create(owner);
				syntaxStyleCache.set(owner, ss);
			}
			setProp(m, "syntaxStyle", ss);
			onStyle?.({ evt: "syntax-style-ok" });
		} catch (e2) {
			onStyle?.({
				evt: "syntax-style-err",
				err: errMsg(e2)
			});
		}
		else if (syntaxStyleImportErr) onStyle?.({
			evt: "syntax-style-import-err",
			err: syntaxStyleImportErr
		});
		setProp(m, "content", content || " ");
		return m;
	} catch (e) {
		if (m && typeof m.destroy === "function") try {
			m.destroy();
		} catch {}
		onError?.({
			err: errMsg(e),
			hasMd: hasMdCatalogue()
		});
		return null;
	}
}
/** 查询宿主组件目录是否有 scrollbox 组件（异常时返回 "unknown"）。
* @returns 是否有 scrollbox 组件；探测异常返回 "unknown"。 */
var hasScrollCatalogue = () => {
	try {
		return !!ot.getComponentCatalogue?.().scrollbox;
	} catch {
		return "unknown";
	}
};
/**
* 构造正文滚动容器：width 100% + flexGrow 1 占满外层剩余高度，逐个插入非空子节点；
* 构造异常时销毁半成品并返回 null（调用方正文直挂=现状行为）。
* @param children 滚动内容节点数组。
* @param onError 构造失败回调（携带错误信息与目录探测结果）。
* @returns scrollbox 元素，或 null（正文直挂降级）。
*/
function scrollEl(children, onError) {
	let s = null;
	try {
		s = createElement("scrollbox");
		try {
			setProp(s, "width", "100%");
		} catch {}
		try {
			setProp(s, "flexGrow", 1);
		} catch {}
		for (const c of children) if (c !== null && c !== void 0 && c !== false) insert(s, c);
		return s;
	} catch (e) {
		if (s && typeof s.destroy === "function") try {
			s.destroy();
		} catch {}
		onError?.({
			err: errMsg(e),
			hasScroll: hasScrollCatalogue()
		});
		return null;
	}
}
/** 阶段名在推进序列中的下标（未知阶段视为 0）。
* @param phase 阶段名（任意值）。
* @param order 推进序列（默认 STAGE_ORDER）。
* @returns 序列下标（未知阶段视为 0）。 */
var stageOf = (phase, order = STAGE_ORDER) => {
	const p = FOLD[phase] ?? phase;
	const i = order.indexOf(p);
	return i < 0 ? 0 : i;
};
/**
* 把活动任务摘要压成一行（slug fit 14 + 阶段中文 fit 8 + 三轮次计数），供 inactive 回退列表使用。
* @param x 任务摘要对象（slug/phase/rounds）。
* @returns 单行文本。
*/
var listLine = (x) => {
	const r = x?.rounds ?? {};
	return `${fit(str(x?.slug || "(未定)"), 14)} ${fit(zhOf(x?.phase), 8)} ${r.plan_review ?? 0}/${r.build_review ?? 0}/${r.test_fix ?? 0}`;
};
/**
* 构造侧边栏恒定 20 行表格视图（行文本 t / 颜色 c / 可点击产物文件名 af 三数组），
* daily/full 双模式：6 行或 9 行阶段表 + 关卡行 + 产物区（daily 逐文件清单 / full 紧凑两行）。
* @param s 任务状态投影（active=false 或 null 时走错误/回退/空态分支）。
* @param err 拉取错误文案（非 null 时首行展示错误）。
* @param oth inactive 回退列表行（listLine 产物，至多 3 行）。
* @param othScope 回退列表作用域标签（"本项目" / "全局·其它项目"）。
* @param T 主题色板（text.muted/base/feedback/action）。
* @param now 当前时间戳（驱动进行中耗时与总耗时；缺省不追加耗时）。
* @param w 面板显示宽度（fail-soft 缺省 80，下限 24）。
* @returns { t, c, af }——行文本数组、行颜色数组、行可点击产物文件名（null=不可点击）。
*/
var buildRows = (s, err, oth, othScope, T, now, w) => {
	const t = Array.from({ length: ROWS }, () => " ");
	const c = Array.from({ length: ROWS }, () => T.text.muted);
	const af = Array.from({ length: ROWS }, () => null);
	const W = w ?? 80;
	t[0] = "── Workflow " + "─".repeat(Math.max(0, W - 12));
	t[19] = "─".repeat(W);
	if (err) {
		t[1] = `wf 错误: ${err}`;
		c[1] = T.text.feedback.error;
		return {
			t,
			c,
			af
		};
	}
	if (!s) {
		t[1] = "  wf: …";
		return {
			t,
			c,
			af
		};
	}
	if (!s.active) {
		if (oth.length > 0) {
			t[1] = `  活动任务·${othScope}`;
			c[1] = T.text.base;
			for (let n = 0; n < 3; n++) if (oth[n]) {
				t[2 + n] = `  ${oth[n]}`;
				c[2 + n] = T.text.action.primary;
			}
		} else t[1] = "  wf: 本会话无活动任务";
		return {
			t,
			c,
			af
		};
	}
	const r = s.rounds ?? {};
	const daily = s.mode === "daily";
	const order = daily ? DAILY_STAGE_ORDER : STAGE_ORDER;
	const i = stageOf(s.phase, order);
	const total = order.length;
	const isDone = s.phase === "done" || s.phase === "retrospect";
	const planV = r.plan_review ?? 0;
	const buildV = r.build_review ?? 0;
	const fixV = r.test_fix ?? 0;
	const done = isDone ? total : i;
	const bar = "●".repeat(done) + "○".repeat(total - done);
	const arts = s.artifacts ?? {};
	const extraCount = Object.keys(arts).filter((n) => CANON.indexOf(n) < 0).length;
	const verdict = s.testReportVerdict;
	const size = str(s.size || "M");
	const pv = s.planReviewVerdict;
	t[1] = daily ? `  ${str(s.slug || "(未定)")} [daily·${size}]` : `  ${str(s.slug || "(未定)")}`;
	c[1] = T.text.base;
	t[2] = `  ${bar} ${done}/${total} · F${i} ${zhOf(s.phase)}`;
	c[2] = T.text.action.primary;
	const totalSec = s.finishedAt && s.startedAt ? (Date.parse(s.finishedAt) - Date.parse(s.startedAt)) / 1e3 : s.startedAt && now ? (now - Date.parse(s.startedAt)) / 1e3 : null;
	if (totalSec !== null && Number.isFinite(totalSec)) t[2] += ` · 共 ${fmtElapsed(totalSec)}`;
	const curRole = roleOf(s.phase);
	const curVar = curRole ? s.tiers?.[curRole] : null;
	if (curRole && curVar) {
		t[3] = `  ⚡ 档位 ${curRole.replace("wf/", "")}:${str(curVar)}`;
		c[3] = T.text.action.primary;
	}
	t[4] = ` ${padE("#", 2)} ${padE("阶段", 8)}  ${padE("状态", 4)}  ${padS("轮次", 4)}  ${padS("耗时", 6)}`;
	c[4] = T.text.muted;
	t[5] = " " + "─".repeat(W - 1);
	c[5] = T.text.muted;
	const roundOf = (stage) => {
		if (stage === "review") return `${planV}/3`;
		if (stage === "build_review") return `${buildV}/3`;
		if (stage === "fixing" || daily && stage === "testing") return `${fixV}/3`;
		return "·";
	};
	const capOf = (stage) => stage === "review" && planV >= 3 || stage === "build_review" && buildV >= 3 || (stage === "fixing" || daily && stage === "testing") && fixV >= 3;
	for (let k = 0; k < total; k++) {
		const stage = order[k];
		const st = isDone || k < i ? "完成" : k === i ? "进行" : "待办";
		let ev = "·";
		if (st === "完成") {
			const d = s.phaseDurations?.[FOLD[stage] ?? stage];
			if (Number.isFinite(d)) ev = fmtElapsed(d);
		} else if (st === "进行" && now && s.phaseEnteredAt) {
			const sec = (now - Date.parse(s.phaseEnteredAt)) / 1e3;
			if (Number.isFinite(sec)) ev = fmtElapsed(sec);
		}
		const row = 6 + k;
		t[row] = ` ${String(k + 1).padStart(2, "0")} ${padE(ZH[stage] ?? stage, 8)}  ${st}  ${padS(roundOf(stage), 4)}  ${padS(ev, 6)}`;
		c[row] = capOf(stage) ? T.text.feedback.error : k === i && !isDone ? T.text.action.primary : isDone || k < i ? T.text.base : T.text.muted;
	}
	let k = 6 + total;
	if (18 - k > 3) {
		t[k] = " ";
		c[k] = T.text.base;
		k++;
	}
	const vTxt = verdict ? str(verdict) : "—";
	if (daily) {
		const g = size === "S" ? "verify 自检(S)" : `verify ${pv ? str(pv) : "—"}`;
		const fail = pv === "FAIL" || verdict === "FAIL";
		const pass = verdict === "PASS" || size !== "S" && pv === "PASS";
		t[k] = `  关卡 ${g} · report ${vTxt}`;
		c[k] = fail ? T.text.feedback.error : pass ? T.text.feedback.success : T.text.muted;
	} else {
		t[k] = `  关卡 test-plan ${s.testPlanWritten ? "✓" : "✗"} · report ${vTxt}`;
		c[k] = verdict === "FAIL" ? T.text.feedback.error : verdict === "PASS" ? T.text.feedback.success : T.text.muted;
	}
	k++;
	if (daily) {
		const items = [{
			name: "plan.md",
			ok: !!arts["plan.md"],
			kb: fmtKB(arts["plan.md"]?.bytes)
		}];
		if (size === "S") items.push({
			name: "plan-review",
			ok: false,
			kb: "",
			exempt: true
		});
		else {
			const pr = Object.keys(arts).filter((n) => n.startsWith("plan-review")).toSorted((a, b) => String(arts[b]?.at ?? "").localeCompare(String(arts[a]?.at ?? "")))[0];
			if (pr) items.push({
				name: pr,
				ok: true,
				kb: fmtKB(arts[pr]?.bytes)
			});
		}
		items.push({
			name: "test-report.md",
			ok: !!arts["test-report.md"],
			kb: fmtKB(arts["test-report.md"]?.bytes)
		});
		const extras = Object.keys(arts).filter((n) => CANON.indexOf(n) < 0 && !n.startsWith("plan-review")).toSorted((a, b) => String(arts[b]?.at ?? "").localeCompare(String(arts[a]?.at ?? "")));
		for (const n of extras) items.push({
			name: n,
			ok: true,
			kb: fmtKB(arts[n]?.bytes)
		});
		for (let n = 0; n < 3 && n < items.length; n++) {
			const it = items[n];
			t[14 + n] = artLine(it.name, it.ok, it.kb, it.exempt);
			c[14 + n] = T.text.base;
			if (it.ok && !it.exempt) af[14 + n] = it.name;
		}
		const more = items.length - 3;
		if (more > 0) {
			t[17] = `  ▸ …${more} 更多`;
			c[17] = T.text.muted;
		}
	} else {
		t[k] = `  ▸ plan.md ${mark(!!arts["plan.md"])} · test-plan.md ${mark(!!arts["test-plan.md"])}`;
		c[k] = T.text.base;
		k++;
		t[k] = `     test-report.md ${mark(!!arts["test-report.md"])} · 其他 ${extraCount} 项`;
		c[k] = T.text.base;
		af[k - 1] = arts["plan.md"] ? "plan.md" : arts["test-plan.md"] ? "test-plan.md" : null;
		af[k] = arts["test-report.md"] ? "test-report.md" : null;
	}
	t[18] = "  /wf:status 查看状态";
	c[18] = T.text.muted;
	return {
		t,
		c,
		af
	};
};
/**
* 装配产物预览：注册 wf-artifact route（markdown 主轨 + 纯文本逐行降级轨，均入 scrollbox）
* 与 q 关闭键层，返回 openArtifact（rpc.read + navigate，降级 toast）与 routerOk。
* @param context 宿主注入的插件上下文（ui.router/ui.toast/keymap.layer/theme）。
* @param deps 依赖注入对象（probe/getSid/rpc/rpcOpts）。
* @param deps.probe 调试探针函数。
* @param deps.getSid 当前会话 ID 读取器（空则 openArtifact 直接跳过）。
* @param deps.rpc RPC 客户端工厂（read 调用）。
* @param deps.rpcOpts RPC 调用选项工厂（location 必带）。
* @returns { openArtifact } 打开产物预览；{ routerOk } route 是否注册成功。
*/
function setupArtifactPreview(context, deps) {
	const { probe, getSid, rpc, rpcOpts } = deps;
	const ROUTE_NAME = "wf-artifact";
	/**
	* 打开产物预览：rpc.read 拉全文后优先 navigate 到 wf-artifact route，route 不可用/失败降级 toast。
	* @param file 产物文件名（artifacts key）。
	* @returns 无返回值（失败路径均以 toast 反馈）。
	*/
	const openArtifact = async (file) => {
		const sid = getSid();
		if (!sid || !file) return;
		probe({
			evt: "open-artifact",
			file
		});
		try {
			const r = await rpc().read({
				sessionID: sid,
				file
			}, rpcOpts());
			if (!r || r.error) {
				context.ui.toast.show({
					message: String(r?.error ?? `读取产物失败：${file}`),
					variant: "info"
				});
				return;
			}
			if (routerOk) try {
				context.ui.router.navigate({
					type: "plugin",
					name: ROUTE_NAME,
					data: {
						file,
						text: r.text,
						bytes: r.bytes ?? 0,
						path: r.path,
						truncated: !!r.truncated
					}
				});
				probe({
					evt: "navigate-ok",
					file
				});
				return;
			} catch (e) {
				probe({
					evt: "navigate-err",
					err: errMsg(e)
				});
			}
			context.ui.toast.show({
				message: `产物路径：${r.path}（预览 route 不可用）`,
				variant: "info"
			});
		} catch (e) {
			context.ui.toast.show({
				message: `打开产物失败：${errMsg(e)}`,
				variant: "error"
			});
		}
	};
	let routerOk = false;
	try {
		const R = context.ui?.router;
		probe({
			evt: "router-probe",
			hasRegister: typeof R?.register === "function",
			hasNavigate: typeof R?.navigate === "function",
			hasCurrent: typeof R?.current === "function"
		});
		if (typeof R?.register === "function" && typeof R?.navigate === "function") {
			R.register({
				name: ROUTE_NAME,
				render: (input) => {
					probe({
						evt: "route-render",
						keys: Object.keys(input ?? {}).slice(0, 8).join(",")
					});
					const container = boxEl([], "100%");
					insert(container, () => {
						try {
							const d = input?.data ?? input ?? {};
							const T = context.theme ?? { text: {
								muted: "gray",
								base: "white",
								feedback: { error: "red" }
							} };
							const body = String(d.text ?? "").split("\n");
							const head = `  ${str(d.file)} · ${(Number(d.bytes) / 1024).toFixed(1)}k${d.truncated ? " · 超64KB已截断" : ""}`;
							const fixedHead = [
								textEl("── wf 产物预览 ────────────────", T.text.muted),
								textEl(head, T.text.muted),
								textEl(`  ${str(d.path)}`, T.text.muted),
								textEl(" ", T.text.muted)
							];
							const fixedFoot = [textEl(" ", T.text.muted), textEl("  q 返回会话", T.text.muted)];
							const md = mdEl(body.slice(0, 200).join("\n"), (info) => probe({
								evt: "md-el-err",
								...info
							}), (info) => probe(info));
							if (md) {
								probe({
									evt: "route-render-md-ok",
									lines: Math.min(body.length, 200)
								});
								const kids = [md, ...body.length > 200 ? [textEl(`  …（共 ${body.length} 行，仅显示前 200 行；截断可能落在代码块/表格中段）`, T.text.muted)] : []];
								const sc = scrollEl(kids, (info) => probe({
									evt: "scroll-el-err",
									...info
								}));
								return boxEl([
									...fixedHead,
									...sc ? [sc] : kids,
									...fixedFoot
								], "100%");
							}
							const kids = [...body.slice(0, 200).map((ln) => textEl("  " + ln, T.text.base)), ...body.length > 200 ? [textEl(`  …（共 ${body.length} 行，仅显示前 200 行）`, T.text.muted)] : []];
							const sc2 = scrollEl(kids, (info) => probe({
								evt: "scroll-el-err",
								...info
							}));
							return boxEl([
								...fixedHead,
								...sc2 ? [sc2] : kids,
								...fixedFoot
							], "100%");
						} catch (e) {
							probe({
								evt: "route-render-ERR",
								err: errMsg(e)
							});
							return boxEl([textEl(`wf 预览异常: ${errMsg(e)}`, "red")]);
						}
					});
					return container;
				}
			});
			routerOk = true;
		}
	} catch (e) {
		probe({
			evt: "router-register-err",
			err: errMsg(e)
		});
	}
	if (routerOk) try {
		context.keymap.layer(() => ({
			mode: "global",
			priority: 2,
			commands: [{
				id: "wf.artifact.close",
				title: "wf: 关闭产物预览",
				bind: "q",
				enabled: () => {
					try {
						const cur = context.ui?.router?.current?.();
						return String(cur?.name ?? "") === ROUTE_NAME;
					} catch {
						return false;
					}
				},
				run: () => {
					try {
						context.ui.router.navigate({
							type: "session",
							sessionID: getSid()
						});
						return true;
					} catch (e) {
						probe({
							evt: "close-nav-err",
							err: errMsg(e)
						});
						return false;
					}
				}
			}]
		}));
	} catch (e) {
		probe({
			evt: "keymap-err",
			err: errMsg(e)
		});
	}
	return {
		openArtifact,
		routerOk
	};
}
// tui/notify.ts
/**
* 装配通知层：返回 OS 通知函数与 toastReport 工厂——报告按 sessionID|at 幂等键去重（60s 新鲜度门），
* toast 呈现 brief（旧行本地降级），仅 level==="warn" 追加 attention.notify。
* @param context 宿主注入的插件上下文（ui.toast / attention.notify）。
* @param probe 调试探针函数（recv/stale-skipped/dup-skipped/toast-shown 等事件分型）。
* @returns { notifyImportant } 系统级通知（非 warn 直接忽略）；{ makeToastReport } 闭包工厂，
*   入参 getSid=当前会话 ID 读取器、dedupe=共享去重实例，返回 (data, chan) 形状的 toastReport。
*/
function setupNotify(context, probe) {
	/**
	* 弹 OS 通知（仅 level==="warn"；message 截前 160 码点）。
	* @param msg 通知正文（通常为 brief）。
	* @param level server 判定的结构化级别（非 "warn" 静默跳过）。
	* @returns 无返回值（attention 不可用时静默降级为纯 toast）。
	*/
	const notifyImportant = (msg, level) => {
		if (level !== "warn") return;
		try {
			context.attention?.notify?.({
				title: "wf",
				message: msg.slice(0, 160),
				sound: false
			});
			probe({ evt: "notify" });
		} catch {}
	};
	/**
	* 构造 toastReport：对当前会话的报告做 60s 新鲜度门 + 幂等键去重，toast 展示 brief 并按需弹 OS 通知。
	* @param getSid 当前会话 ID 读取器（不匹配的报告直接丢弃）。
	* @param dedupe 三通道共享的去重实例（seen 判定过期/重复/淘汰）。
	* @returns toastReport 函数 (data, chan)：data 为报告负载（sessionID/text/at/brief/level），chan 为通道标记（local/rpc/data/poll，仅进探针）。
	*/
	const makeToastReport = (getSid, dedupe) => {
		const toastReport = (d, chan) => {
			const sid = String(d?.sessionID ?? "");
			const text = str(d?.text);
			const at = str(d?.at);
			probe({
				reportEv: "recv",
				chan,
				got: sid,
				cur: getSid(),
				chars: text.length
			});
			try {
				if (sid !== getSid() || !text) return;
				if (at) {
					const age = Date.now() - Date.parse(at);
					if (Number.isFinite(age) && age > 6e4) {
						probe({
							reportEv: "stale-skipped",
							chan
						});
						return;
					}
					const key = reportId(sid, at);
					if (!dedupe.seen(key, Date.parse(at))) {
						probe({
							reportEv: "dup-skipped",
							chan
						});
						return;
					}
				}
				const brief = briefOf(d);
				context.ui.toast.show({
					message: brief,
					variant: "info"
				});
				probe({
					reportEv: "toast-shown",
					chan
				});
				notifyImportant(brief, str(d?.level));
			} catch (er) {
				probe({
					reportEv: "toast-err",
					err: errMsg(er)
				});
			}
		};
		return toastReport;
	};
	return {
		notifyImportant,
		makeToastReport
	};
}
// tui/exec-intercept.ts
/**
* 注册 return 键拦截层：编辑器内容以 /wf: 开头时本地调度（wf:open 带参走产物预览，其余透传
* execLocal），否则返回 false 交还宿主默认行为（quota 式 P0⑧：run 必须同步返回）。
* @param context 宿主注入的插件上下文（keymap.layer / renderer 取焦点编辑器）。
* @param deps 依赖注入对象（execLocal/openArtifact/isRouterOk/probe）。
* @param deps.execLocal 主轨执行函数（RPC exec + toast/刷新）。
* @param deps.openArtifact 本地产物预览打开函数。
* @param deps.isRouterOk 预览 route 是否可用的判定（返回 false 时 wf:open 走 server 降级轨）。
* @param deps.probe 调试探针函数（记录 intercept-hit 事件）。
* @returns 无返回值（副作用：向 keymap 注册 wf.exec 命令层）。
*/
function installExecIntercept(context, deps) {
	const { execLocal, openArtifact, isRouterOk, probe } = deps;
	context.keymap.layer(() => ({
		mode: "global",
		priority: 1,
		commands: [{
			id: "wf.exec",
			title: "wf: 本地执行 /wf:* 命令",
			bind: "return",
			run: () => {
				const editor = context.renderer?.currentFocusedEditor;
				const text = str(editor?.plainText).trim();
				if (!editor || !text.startsWith("/wf:")) return false;
				const body = text.slice(1);
				const sp = body.search(/\s/);
				const name = sp < 0 ? body : body.slice(0, sp);
				const promptText = sp < 0 ? "" : body.slice(sp + 1);
				try {
					editor.clear();
				} catch {}
				if (name === "wf:open" && promptText.trim() && isRouterOk()) openArtifact(promptText.trim());
				else execLocal(name, promptText);
				probe({
					evt: "intercept-hit",
					name
				});
				return true;
			}
		}]
	}));
}
// tui/data.ts
/**
* 装配对账拉取：refresh 按 fingerprint 门禁把 state 投影写入 snap 信号（无真实变化且同一
* 5s tick 内绝不发信号），inactive 时回退拉取本项目→全局活动任务列表；markStale 清空指纹强制重拉。
* @param context 宿主注入的插件上下文（data.session.get 取 projectID/directory）。
* @param deps 依赖注入对象（probe/getSid/rpc/rpcOpts/setSnap/toastReport）。
* @param deps.probe 调试探针函数。
* @param deps.getSid 当前会话 ID 读取器（空则 refresh 直接跳过）。
* @param deps.rpc RPC 客户端工厂（state/list 调用）。
* @param deps.rpcOpts RPC 调用选项工厂（location 必带）。
* @param deps.setSnap snap 信号 setter（写入 { st, oth, othScope, err } 投影）。
* @param deps.toastReport 轮询通道报告回调（s.lastReport 补偿达）。
* @returns { refresh } 单次对账拉取函数；{ markStale } 清空 lastFp 指纹（会话切换/重连时用）。
*/
function setupRefresh(context, deps) {
	const { probe, getSid, rpc, rpcOpts, setSnap, toastReport } = deps;
	let lastFp = "";
	/** 单次对账：拉 state → 补偿 lastReport → inactive 回退列表 → fingerprint 门禁后写 snap。 */
	const refresh = async () => {
		const sid = getSid();
		if (!sid) return;
		try {
			const s = await rpc().state({ sessionID: sid }, rpcOpts());
			if (s?.lastReport) toastReport(s.lastReport, "poll");
			let oth = [];
			let othScope = "";
			if (!s?.active) {
				let pid = null;
				let dir = null;
				try {
					const cs = context.data?.session?.get(sid);
					pid = cs?.projectID ?? null;
					dir = cs?.location?.directory ?? null;
				} catch {}
				try {
					const mine = await rpc().list(pid ? {
						projectID: String(pid),
						...dir ? { directory: String(dir) } : {}
					} : {}, rpcOpts());
					const act = (Array.isArray(mine?.sessions) ? mine.sessions : []).filter((x) => x?.phase && x.phase !== "done").slice(0, 3);
					if (act.length) {
						oth = act.map(listLine);
						othScope = "本项目";
					} else {
						const allR = await rpc().list({}, rpcOpts());
						const cross = (Array.isArray(allR?.sessions) ? allR.sessions : []).filter((x) => x?.phase && x.phase !== "done").slice(0, 3);
						if (cross.length) {
							oth = cross.map(listLine);
							othScope = "全局·其它项目";
						}
					}
				} catch {}
			}
			const fp = JSON.stringify([
				s ?? null,
				oth,
				othScope,
				Math.floor(Date.now() / 5e3)
			]);
			if (fp !== lastFp) {
				lastFp = fp;
				probe({
					evt: "refresh",
					sid,
					active: !!s?.active,
					othN: oth.length
				});
				setSnap({
					st: s ?? { active: false },
					oth,
					othScope,
					err: null
				});
			}
		} catch (e) {
			const msg = errMsg(e);
			probe({
				evt: "refresh-err",
				err: msg
			});
			const fp = "ERR:" + msg;
			if (fp !== lastFp) {
				lastFp = fp;
				setSnap({
					st: null,
					oth: [],
					othScope: "",
					err: msg
				});
			}
		}
	};
	return {
		refresh,
		markStale: () => {
			lastFp = "";
		}
	};
}
// tui/index.tsx
/** 当前构建版本号（与 server 同源 shared/version.ts，随探针落盘对账）。 */
var TUI_BUILD = VERSION;
/**
* TUI 插件入口（流派 A 结构约束本体：本文件禁 JSX、slot render 顶层零响应式、唯一动态点
* insert(accessor)——真机实证的唯一不崩形态，勿为注释/重构改动该结构）。
* setup 内装配：探针、数据订阅（事件/data.listen/server.connected/5s 轮询）、通知去重、
* 产物预览 route、slot 渲染与 return 键拦截；返回的清理函数一次性收口所有订阅与定时器。
* @param context.setup 入参 context——宿主注入的插件上下文（ui/client/data/keymap/theme/renderer 等，
*   无官方类型，边界显式 any）。
* @returns 清理函数（dispose 时清 interval、abort 信号并逐项摘除订阅/注册）。
*/
var tui_default = Plugin.define({
	id: "wf-workflow-tui",
	setup(context) {
		const compact = context?.options?.compact === true || process.env.WF_COMPACT === "1";
		const { REPO, probe } = setupProbe(context, { build: TUI_BUILD });
		probe({
			evt: "loaded",
			repo: REPO,
			options: JSON.stringify(context?.options ?? null),
			loc: str(context?.location?.directory),
			hasSlot: typeof context?.ui?.slot === "function",
			hasKeymap: typeof context?.keymap?.layer === "function",
			hasDataListen: typeof context?.data?.listen === "function",
			hasDataOn: typeof context?.data?.on === "function",
			hasAttention: typeof context?.attention?.notify === "function",
			hasRendererEditor: !!context?.renderer
		});
		const [snap, setSnap] = createSignal(null);
		let latestSid = "";
		const ac = new AbortController();
		const myDir = () => String(context?.location?.directory ?? "");
		const rpc = () => context.client.rpc(Wf);
		const rpcOpts = () => {
			const d = myDir();
			return d ? { location: { directory: d } } : {};
		};
		const locOk = (e) => {
			const d = String(e?.location?.directory ?? "");
			return !d || !myDir() || d === myDir();
		};
		const dedupe = createDeduper();
		const { makeToastReport } = setupNotify(context, probe);
		const toastReport = makeToastReport(() => latestSid, dedupe);
		const { openArtifact, routerOk } = setupArtifactPreview(context, {
			probe,
			getSid: () => latestSid,
			rpc,
			rpcOpts
		});
		const { refresh, markStale } = setupRefresh(context, {
			probe,
			getSid: () => latestSid,
			rpc,
			rpcOpts,
			setSnap,
			toastReport
		});
		/**
		* 主轨本地执行：RPC exec 运行 /wf:* 命令，透传 brief/level 弹 toast（同 at 登记去重键）并刷新 snap。
		* @param name 命令名（如 "wf:status"）。
		* @param promptText 命令参数文本（可为空串）。
		* @returns Promise（失败路径以 error toast 反馈，不向外抛）。
		*/
		const execLocal = async (name, promptText) => {
			try {
				const r = await rpc().exec({
					sessionID: latestSid,
					name,
					prompt: promptText
				}, rpcOpts());
				if (r?.text) toastReport({
					sessionID: latestSid,
					text: r.text,
					at: r.at,
					brief: r.brief,
					level: r.level
				}, "local");
				await refresh();
			} catch (e) {
				context.ui.toast.show({
					message: `wf 执行失败：${errMsg(e)}`,
					variant: "error"
				});
			}
		};
		const offUpdated = rpc().events.on("updated", (e) => {
			if (locOk(e)) refresh();
		}, { signal: ac.signal });
		const offReport = rpc().events.on("report", (e) => {
			if (!locOk(e)) return;
			toastReport(e && typeof e === "object" && "data" in e ? e.data : e, "rpc");
		}, { signal: ac.signal });
		let offData = null;
		try {
			offData = context.data?.listen?.((ev) => {
				const details = ev?.details ?? ev;
				const type = String(details?.type ?? "");
				if (!type.startsWith(RPC_EVENT_PREFIX)) return;
				if (!locOk(details)) return;
				const payload = details?.data ?? details;
				if (type === RPC_EVENT_REPORT) toastReport(payload, "data");
				else if (type === RPC_EVENT_UPDATED) refresh();
			});
		} catch {}
		let offConn = null;
		try {
			offConn = context.data?.on?.("server.connected", () => {
				probe({ evt: "server-connected" });
				markStale();
				refresh();
			});
		} catch {}
		probe({
			evt: "subscribed",
			hasDataListen: !!offData,
			hasConn: !!offConn
		});
		const timer = setInterval(() => {
			refresh();
		}, 5e3);
		let containers = 0;
		let builds = 0;
		const unregister = context.ui.slot({
			append: "sidebar.content",
			render: (input) => {
				containers += 1;
				const container = boxEl([]);
				insert(container, () => {
					builds += 1;
					if (builds === 1 || builds === 2 || builds === 5 || builds % 20 === 0) probe({
						evt: "build",
						n: builds,
						containers,
						sid: str(input?.sessionID),
						hasSnap: !!snap()
					});
					try {
						const sid = String(input?.sessionID ?? "");
						if (sid && sid !== latestSid) {
							latestSid = sid;
							markStale();
							queueMicrotask(() => {
								refresh();
							});
						}
						const T = context.theme ?? { text: {
							muted: "gray",
							base: "white",
							feedback: {
								error: "red",
								success: "green"
							},
							action: { primary: "cyan" }
						} };
						const data = snap();
						if (compact) {
							const s = data?.st;
							if (!s?.active) return textEl(str(data?.err ? `wf 错误: ${data.err}` : "  wf: 无活动任务"), T.text.muted);
							const rr = s.rounds ?? {};
							const label = zhOf(s.phase);
							return textEl(`▶ ${s.mode === "daily" ? `[daily·${str(s.size || "M")}] ` : ""}${label} ${rr.plan_review ?? 0}/${rr.build_review ?? 0}/${rr.test_fix ?? 0}`, T.text.action.primary);
						}
						const W = Math.max(24, Math.floor(Number(context?.renderer?.width)) || 80);
						const { t, c, af } = buildRows(data?.st ?? null, data?.err ?? null, data?.oth ?? [], data?.othScope ?? "", T, Date.now(), W);
						return boxEl(t.map((line, i) => {
							const el = textEl(line, c[i]);
							const f = af?.[i];
							if (f) try {
								setProp(el, "onMouseDown", () => {
									openArtifact(f);
								});
							} catch {}
							return el;
						}));
					} catch (e) {
						probe({
							evt: "render-ERR",
							err: errMsg(e)
						});
						return boxEl([textEl(`wf 渲染异常: ${errMsg(e)}`, "red")]);
					}
				});
				probe({
					evt: "slot-render",
					containers
				});
				return container;
			}
		});
		installExecIntercept(context, {
			execLocal,
			openArtifact,
			isRouterOk: () => routerOk,
			probe
		});
		return () => {
			try {
				clearInterval(timer);
			} catch {}
			try {
				ac.abort();
			} catch {}
			try {
				offUpdated?.();
			} catch {}
			try {
				offReport?.();
			} catch {}
			try {
				offData?.();
			} catch {}
			try {
				offConn?.();
			} catch {}
			try {
				unregister?.();
			} catch {}
		};
	}
});
export { briefOf, buildRows, tui_default as default, dispW, fmtElapsed, listLine };
