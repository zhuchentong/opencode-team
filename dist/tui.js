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
var STAGE_LABEL = {
	intake: "intake",
	planning: "planning",
	review: "review ∥ 可行性",
	assign: "assign→test_design",
	test_design: "test_design（红）",
	building: "building",
	reconcile: "building+合并",
	build_review: "build_review",
	testing: "testing",
	fixing: "fixing",
	done: "done ∥ 复盘",
	retrospect: "done ∥ 复盘"
};
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
// tui/index.tsx
var { createElement, insert, setProp } = ot;
var TUI_BUILD = "M16-p4-notify";
var ROWS = 20;
var str = (v) => v === null || v === void 0 ? "" : String(v);
var errMsg = (e) => String(e?.message ?? e);
var sanitize = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").slice(0, 200) || " ";
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
var stageOf = (phase) => {
	const p = FOLD[phase] ?? phase;
	const i = STAGE_ORDER.indexOf(p);
	return i < 0 ? 0 : i;
};
var listLine = (x) => {
	const r = x?.rounds ?? {};
	return `${str(x?.slug || "(未定)")} · ${str(x?.phase ?? "?")} ${r.plan_review ?? 0}/${r.build_review ?? 0}/${r.test_fix ?? 0}`;
};
var buildRows = (s, err, oth, othScope, T) => {
	const t = Array.from({ length: ROWS }, () => " ");
	const c = Array.from({ length: ROWS }, () => T.text.muted);
	t[0] = "── wf ──────────────";
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
	const i = stageOf(s.phase);
	const total = STAGE_ORDER.length;
	const isDone = s.phase === "done" || s.phase === "retrospect";
	const label = STAGE_LABEL[s.phase] ?? str(s.phase ?? "?");
	const planV = r.plan_review ?? 0;
	const buildV = r.build_review ?? 0;
	const fixV = r.test_fix ?? 0;
	const done = isDone ? total : i;
	const bar = "●".repeat(done) + "○".repeat(total - done);
	const arts = s.artifacts ?? {};
	const extraCount = Object.keys(arts).filter((n) => CANON.indexOf(n) < 0).length;
	const verdict = s.testReportVerdict;
	t[1] = `  ${str(s.slug || "(未定)")}`;
	c[1] = T.text.base;
	t[2] = `  F${i} ${label}`;
	c[2] = T.text.action.primary;
	t[3] = `  ${bar} ${done}/${total}`;
	c[3] = T.text.action.primary;
	t[4] = " ";
	c[4] = T.text.base;
	t[5] = "── 轮次 ────────────";
	t[6] = `      plan  ${planV}/3`;
	c[6] = planV >= 3 ? T.text.feedback.error : T.text.base;
	t[7] = `      build ${buildV}/3`;
	c[7] = buildV >= 3 ? T.text.feedback.error : T.text.base;
	t[8] = `      fix   ${fixV}/3`;
	c[8] = fixV >= 3 ? T.text.feedback.error : T.text.base;
	t[9] = " ";
	c[9] = T.text.base;
	t[10] = "── 关卡 ────────────";
	t[11] = `      test-plan ${s.testPlanWritten ? "✓" : "✗"}`;
	c[11] = s.testPlanWritten ? T.text.feedback.success : T.text.muted;
	t[12] = `      report    ${verdict ? str(verdict) : "—"}`;
	c[12] = verdict === "PASS" ? T.text.feedback.success : verdict === "FAIL" ? T.text.feedback.error : T.text.muted;
	t[13] = " ";
	c[13] = T.text.base;
	t[14] = "── 产物 ────────────";
	t[15] = `      plan.md ${arts["plan.md"] ? "✓" : "✗"}`;
	c[15] = arts["plan.md"] ? T.text.feedback.success : T.text.muted;
	t[16] = `      test-plan.md ${arts["test-plan.md"] ? "✓" : "✗"}`;
	c[16] = arts["test-plan.md"] ? T.text.feedback.success : T.text.muted;
	t[17] = `      test-report.md ${arts["test-report.md"] ? "✓" : "✗"}`;
	c[17] = arts["test-report.md"] ? T.text.feedback.success : T.text.muted;
	t[18] = `      其他产物 ${extraCount} 项`;
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
							return textEl(`▶ ${STAGE_LABEL[s.phase] ?? str(s.phase ?? "?")} ${rr.plan_review ?? 0}/${rr.build_review ?? 0}/${rr.test_fix ?? 0}`, T.text.action.primary);
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
export { tui_default as default };
