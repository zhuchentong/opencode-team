import { Plugin } from "@opencode/plugin/tui";
import { createSignal } from "solid-js";
import * as ot from "@opentui/solid";
var Wf = { define: (def) => def }.define({
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
					artifacts: {
						type: "object",
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
					at: { type: "string" }
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
				at: { type: "string" }
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
var FOLD = {
	reconcile: "building",
	retrospect: "done"
};
var CANON = [
	"plan.md",
	"test-plan.md",
	"test-report.md"
];
var STAGE_ORDER = PHASE_ORDER;
var DAILY_STAGE_ORDER = [
	"intake",
	"planning",
	"review",
	"building",
	"testing",
	"done"
];
// tui/index.tsx
var { createElement, insert, setProp } = ot;
var TUI_BUILD = "M16-r37-table";
var ROWS = 20;
var str = (v) => v === null || v === void 0 ? "" : String(v);
var errMsg = (e) => String(e?.message ?? e);
var sanitize = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").slice(0, 200) || " ";
var dispW = (s) => {
	let w = 0;
	for (const ch of String(s ?? "")) {
		const c = ch.codePointAt(0) ?? 0;
		w += c >= 11904 && c <= 40959 || c >= 65280 && c <= 65376 || c >= 44032 && c <= 55215 ? 2 : 1;
	}
	return w;
};
var padE = (s, w) => s + " ".repeat(Math.max(0, w - dispW(s)));
var padS = (s, w) => " ".repeat(Math.max(0, w - dispW(s))) + s;
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
var zhOf = (phase) => ZH[FOLD[phase] ?? phase] ?? str(phase ?? "?");
var mark = (ok) => ok ? "✓" : "✗";
function textEl(s, fg) {
	const t = createElement("text");
	try {
		if (fg) setProp(t, "fg", fg);
	} catch {}
	setProp(t, "truncate", true);
	insert(t, [sanitize(s)]);
	return t;
}
function boxEl(children) {
	const b = createElement("box");
	setProp(b, "width", "100%");
	setProp(b, "flexDirection", "column");
	for (const c of children) if (c !== null && c !== void 0 && c !== false) insert(b, c);
	return b;
}
var stageOf = (phase, order = STAGE_ORDER) => {
	const p = FOLD[phase] ?? phase;
	const i = order.indexOf(p);
	return i < 0 ? 0 : i;
};
var listLine = (x) => {
	const r = x?.rounds ?? {};
	return `${fit(str(x?.slug || "(未定)"), 14)} ${fit(zhOf(x?.phase), 8)} ${r.plan_review ?? 0}/${r.build_review ?? 0}/${r.test_fix ?? 0}`;
};
var buildRows = (s, err, oth, othScope, T) => {
	const t = Array.from({ length: ROWS }, () => " ");
	const c = Array.from({ length: ROWS }, () => T.text.muted);
	t[0] = "── Workflow ────────";
	t[19] = "──────────────────────";
	if (err) {
		t[1] = `wf 错误: ${err}`;
		c[1] = T.text.feedback.error;
		return {
			t,
			c
		};
	}
	if (!s) {
		t[1] = "  wf: …";
		return {
			t,
			c
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
			c
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
	const hasPlanReview = Object.keys(arts).some((n) => n.startsWith("plan-review"));
	const extraCount = Object.keys(arts).filter((n) => CANON.indexOf(n) < 0 && !(daily && n.startsWith("plan-review"))).length;
	const verdict = s.testReportVerdict;
	const size = str(s.size || "M");
	const pv = s.planReviewVerdict;
	t[1] = daily ? `  ${str(s.slug || "(未定)")} [daily·${size}]` : `  ${str(s.slug || "(未定)")}`;
	c[1] = T.text.base;
	t[2] = `  ${bar} ${done}/${total} · F${i} ${zhOf(s.phase)}`;
	c[2] = T.text.action.primary;
	t[4] = ` ${padE("#", 2)} ${padE("阶段", 8)}  ${padE("状态", 4)}  ${padS("轮次", 4)}`;
	c[4] = T.text.muted;
	t[5] = " " + "─".repeat(23);
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
		const row = 6 + k;
		t[row] = ` ${String(k + 1).padStart(2, "0")} ${padE(ZH[stage] ?? stage, 8)}  ${st}  ${padS(roundOf(stage), 4)}`;
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
	const a1 = daily ? size === "S" ? "plan-review —(S免)" : `plan-review ${mark(hasPlanReview)}` : `test-plan.md ${mark(!!arts["test-plan.md"])}`;
	t[k] = `  产物 plan.md ${mark(!!arts["plan.md"])} · ${a1}`;
	c[k] = T.text.base;
	k++;
	t[k] = `       test-report.md ${mark(!!arts["test-report.md"])} · 其他 ${extraCount} 项`;
	c[k] = T.text.base;
	t[18] = "  /wf:status 查看状态";
	c[18] = T.text.muted;
	return {
		t,
		c
	};
};
var isImportant = (text) => /⚠️|❌|FAIL|illegal/i.test(text);
var tui_default = Plugin.define({
	id: "wf-workflow-tui",
	setup(context) {
		const compact = context?.options?.compact === true;
		const REPO = String(context?.location?.directory ?? "") || decodeURIComponent(new URL("../../", "" + import.meta.url).pathname).replace(/\/$/, "");
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
						build: TUI_BUILD,
						loadedAt: LOADED_AT,
						seq: ++seq,
						...data
					}) + "\n");
				} catch {}
			})();
		};
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
		const shown = /* @__PURE__ */ new Set();
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
		const notifyImportant = (text) => {
			if (!isImportant(text)) return;
			try {
				context.attention?.notify?.({
					title: "wf",
					message: text.slice(0, 160),
					sound: false
				});
				probe({ evt: "notify" });
			} catch {}
		};
		const toastReport = (d, chan) => {
			const sid = String(d?.sessionID ?? "");
			const text = str(d?.text);
			const at = str(d?.at);
			probe({
				reportEv: "recv",
				chan,
				got: sid,
				cur: latestSid,
				chars: text.length
			});
			try {
				if (sid !== latestSid || !text) return;
				if (at) {
					const age = Date.now() - Date.parse(at);
					if (Number.isFinite(age) && age > 6e4) {
						probe({
							reportEv: "stale-skipped",
							chan
						});
						return;
					}
					const key = sid + "|" + at;
					if (shown.has(key)) {
						probe({
							reportEv: "dup-skipped",
							chan
						});
						return;
					}
					shown.add(key);
					if (shown.size > 50) {
						const first = shown.values().next().value;
						if (first !== void 0) shown.delete(first);
					}
				}
				context.ui.toast.show({
					message: text,
					variant: "info"
				});
				probe({
					reportEv: "toast-shown",
					chan
				});
				notifyImportant(text);
			} catch (er) {
				probe({
					reportEv: "toast-err",
					err: errMsg(er)
				});
			}
		};
		let lastFp = "";
		const refresh = async () => {
			const sid = latestSid;
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
					othScope
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
					at: r.at
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
				if (!type.startsWith("rpc.wf.")) return;
				if (!locOk(details)) return;
				const payload = details?.data ?? details;
				if (type === "rpc.wf.report") toastReport(payload, "data");
				else if (type === "rpc.wf.updated") refresh();
			});
		} catch {}
		let offConn = null;
		try {
			offConn = context.data?.on?.("server.connected", () => {
				probe({ evt: "server-connected" });
				lastFp = "";
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
							lastFp = "";
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
						const { t, c } = buildRows(data?.st ?? null, data?.err ?? null, data?.oth ?? [], data?.othScope ?? "", T);
						return boxEl(t.map((line, i) => textEl(line, c[i])));
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
					execLocal(name, promptText);
					probe({
						evt: "intercept-hit",
						name
					});
					return true;
				}
			}]
		}));
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
export { buildRows, tui_default as default, dispW, listLine };
