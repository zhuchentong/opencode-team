import { Plugin } from "@opencode/plugin/tui";
import { createSignal } from "solid-js";
import { Rpc } from "@opencode/plugin/rpc";
import * as ot from "@opentui/solid";
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
// shared/version.ts
var VERSION = "M16-r47";
// shared/report.ts
function reportId(sessionID, at) {
	return `${sessionID}|${at}`;
}
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
var str = (v) => v === null || v === void 0 ? "" : String(v);
var errMsg = (e) => String(e?.message ?? e);
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
// shared/redact.ts
function redactIds(text) {
	return String(text ?? "").replace(/ses_[A-Za-z0-9]+/g, "〔已隐去〕");
}
// tui/panel.tsx
var { createElement, insert, setProp } = ot;
var ROWS = 20;
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
var zhOf = (phase) => ZH[FOLD[phase] ?? phase] ?? str(phase ?? "?");
var mark = (ok) => ok ? "✓" : "✗";
var fmtKB = (b) => {
	const n = Number(b ?? 0);
	return n > 0 ? `${(n / 1024).toFixed(1).replace(/\.0$/, "")}k` : "";
};
var artLine = (name, ok, kb, exempt) => `  ▸ ${fit(name, 18)} ${exempt ? "免" : mark(ok)}${exempt || !kb ? "" : ` ${kb}`}`;
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
var hasMdCatalogue = () => {
	try {
		return !!ot.getComponentCatalogue?.().markdown;
	} catch {
		return "unknown";
	}
};
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
var hasScrollCatalogue = () => {
	try {
		return !!ot.getComponentCatalogue?.().scrollbox;
	} catch {
		return "unknown";
	}
};
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
var stageOf = (phase, order = STAGE_ORDER) => {
	const p = FOLD[phase] ?? phase;
	const i = order.indexOf(p);
	return i < 0 ? 0 : i;
};
var listLine = (x) => {
	const r = x?.rounds ?? {};
	return `${fit(str(x?.slug || "(未定)"), 14)} ${fit(zhOf(x?.phase), 8)} ${r.plan_review ?? 0}/${r.build_review ?? 0}/${r.test_fix ?? 0}`;
};
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
	const roleOf = (ph) => ({
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
function setupArtifactPreview(context, deps) {
	const { probe, getSid, rpc, rpcOpts } = deps;
	const ROUTE_NAME = "wf-artifact";
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
function setupNotify(context, probe) {
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
function setupRefresh(context, deps) {
	const { probe, getSid, rpc, rpcOpts, setSnap, toastReport } = deps;
	let lastFp = "";
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
var TUI_BUILD = VERSION;
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
