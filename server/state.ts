// wf-workflow — 状态存取层（自 index.js 原样搬移）：会话状态键 / 项目索引 / load / save /
// resolveState（wf/* 子会话经项目索引反查管辖状态）/ scanStates（看板枚举 + done 状态 GC）/
// resolveProjectDir（三级回退：st.directory → session.get → cwd）。
// 原则：只放与 storage/session 相关的存取逻辑；纯流转校验见 lib.js，组装接线见 index.js。
// 已验证 API（实测 2026-11-09）：storage 为 string key get/set/remove；entry.put key 正则 ^[a-z0-9][a-z0-9._-]*$

export const ENTRY_KEY = "wf.phase";
export const HINT_KEY = "wf.hint"; // P3：自动激活一次性提示（不入状态机，reset 一并清除）
export const KEY = (sessionID) => `wf-workflow/state/${sessionID}`;
// M10-b：项目索引——子会话（agent 匹配 wf/*）经 projectID 反查管辖状态（实测 session 记录无 parentID）
export const IDX = (projectID) => `wf-workflow/project/${projectID}`;
export const STATE_PREFIX = KEY("");

export const logAdd = (st, entry) => {
  st.log = Array.isArray(st.log) ? st.log : [];
  st.log.push(entry);
  if (st.log.length > 50) st.log = st.log.slice(-50);
};

export function createStore(ctx) {
  const S = ctx.storage;

  const load = async (sessionID) => {
    try { return (await S.get(KEY(sessionID))) ?? null; } catch { return null; }
  };
  const save = async (st) => {
    st.updatedAt = new Date().toISOString();
    await S.set(KEY(st.sessionID), st);
    try {
      if (st.projectID) await S.set(IDX(st.projectID), { sessionID: st.sessionID, updatedAt: st.updatedAt });
    } catch { }
  };
  const resolveState = async (sessionID, agent) => {
    const own = await load(sessionID);
    if (own) return own;
    if (!/^wf\//.test(String(agent ?? ""))) return null; // 仅 wf/* agent 受项目索引管辖；普通 build/plan 会话不受影响
    try {
      const s = await ctx.session.get({ sessionID });
      const pid = s?.projectID;
      if (!pid) return null;
      const idx = await S.get(IDX(pid));
      if (idx?.sessionID && idx.sessionID !== sessionID) {
        const owner = await load(idx.sessionID);
        if (owner) return owner;
      }
    } catch { }
    return null;
  };
  // 落盘目录三级回退同源提取（原 wf_write_artifact 与 wf:diagnose 两处内联重复）：
  // 优先管辖状态的 directory，回退本会话 session.get，再回退 cwd
  const resolveProjectDir = async (st, sessionID) => {
    let dir = st?.directory ?? null;
    if (!dir) {
      const sess = await ctx.session.get({ sessionID }).catch(() => null);
      dir = sess?.location?.directory ?? null;
    }
    return dir ?? process.cwd();
  };

  // ── M8-b：状态枚举（面板看板）；M10-d A6 项目过滤 + A7 done 状态 GC ────
  const STALE_MS = 14 * 24 * 3600 * 1000;
  const scanStates = async (projectID, directory) => {
    const out = [];
    try {
      const res = await S.scan({ prefix: STATE_PREFIX });
      const entries = Array.isArray(res) ? res : (res?.entries ?? []);
      for (const e of entries) {
        const k = e?.key ?? e?.[0];
        let v = e?.value ?? e?.[1];
        if (k == null) continue;
        const ks = Array.isArray(k) ? k.join("/") : String(k);
        if (!ks.startsWith(STATE_PREFIX)) continue;
        if (typeof v === "string") { try { v = JSON.parse(v); } catch { } }
        if (!v || typeof v !== "object") continue;
        // A7 GC：done 且 >14 天 → 删状态并清指向自己的项目索引
        try {
          const age = v.updatedAt ? Date.now() - Date.parse(String(v.updatedAt)) : 0;
          if (v.phase === "done" && v.updatedAt && age > STALE_MS) {
            await S.remove(ks);
            if (v.projectID) {
              const idx = await S.get(IDX(v.projectID));
              if (idx && idx.sessionID === v.sessionID) await S.remove(IDX(v.projectID));
            }
            continue;
          }
        } catch { /* GC 失败按保留处理 */ }
        // A6：按项目过滤（M14：无 projectID 的旧状态回退 directory 比较，匹配则显示）
        if (projectID) {
          if (v.projectID) { if (String(v.projectID) !== String(projectID)) continue; }
          else if (!(directory && v.directory && String(v.directory) === String(directory))) continue;
        }
        out.push({
          sessionID: v.sessionID ?? ks.slice(STATE_PREFIX.length),
          slug: v.slug ?? "",
          phase: v.phase ?? null,
          rounds: v.rounds ?? {},
          testPlanWritten: !!v.testPlanWritten,
          testReportVerdict: v.testReportVerdict ?? null,
          updatedAt: v.updatedAt ?? null,
        });
      }
    } catch { /* 扫描失败按空处理 */ }
    out.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
    return out.slice(0, 20);
  };

  return { load, save, resolveState, resolveProjectDir, scanStates };
}
