// P0 契约探针 — server 部件（P0 完成即整体删除，不进正式架构）。
// 覆盖探测项：③RPC methods/④RPC events(5条件)/⑤resume:false 注入/⑥bun:sqlite server 写/⑦⑧命令注册形态。
// 一切结论以 .workflow/_debug/p0.log 的 JSONL 记录为证据（role=server）。
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync } from "node:fs";
import { Probe } from "../shared/rpc.ts";

const REPO = "/home/zhuchentong/Projects/zhuchentong/opencode-team";
const DIR = `${REPO}/.workflow/_debug`;
const DB_PATH = `${DIR}/probe.db`;

let seq = 0;
const log = (ev: string, data: Record<string, unknown> = {}) => {
  try {
    mkdirSync(DIR, { recursive: true });
    appendFileSync(`${DIR}/p0.log`, JSON.stringify({ at: new Date().toISOString(), role: "server", ev: `${ev}#${++seq}`, ...data }) + "\n");
  } catch { /* 探针日志失败不影响探测主体 */ }
};

const errMsg = (e: unknown) => String((e as Error)?.message ?? e);

export default {
  id: "wf-p0-probe",
  async setup(ctx: any) {
    log("loaded", { pid: process.pid, directory: ctx?.location?.directory ?? null });

    // ── ⑥ server 侧 bun:sqlite（写方）──────────────────────────────
    let db = null as InstanceType<typeof Database> | null;
    try {
      db = new Database(DB_PATH, { create: true });
      db.run("PRAGMA journal_mode = WAL;");
      db.run("CREATE TABLE IF NOT EXISTS writes (at TEXT, role TEXT, note TEXT);");
      db.run("INSERT INTO writes (at, role, note) VALUES (?, ?, ?)", [new Date().toISOString(), "server", "setup"]);
      const n = db.query("SELECT COUNT(*) AS c FROM writes").get() as any;
      log("sqlite-server", { ok: true, rows: n?.c ?? null });
    } catch (e) {
      log("sqlite-server", { ok: false, err: errMsg(e) });
    }

    // ── ③④ RPC 注册（methods + events）─────────────────────────────
    let rpcReg = null as any;
    try {
      rpcReg = await ctx.rpc.register(Probe, {
        where: async (input: any) => ({
          directory: ctx?.location?.directory ?? "",
          pid: process.pid,
          echo: String(input?.ping ?? ""),
        }),
        dbrows: async () => {
          try {
            return { rows: db ? db.query("SELECT at, role, note FROM writes ORDER BY at DESC LIMIT 25").all() : [], err: null };
          } catch (e) {
            return { rows: [], err: errMsg(e) };
          }
        },
      });
      log("rpc-register", { ok: true, id: (Probe as any).id });
    } catch (e) {
      log("rpc-register", { ok: false, err: errMsg(e) });
    }

    // ④：emit 一律 await+catch（5 条件之一；失败只留本日志，TUI 无感知即实证 live-only/静默丢）
    const emitChanged = async (why: string) => {
      const nonce = Math.random().toString(36).slice(2, 10);
      if (!rpcReg?.events?.emit) {
        log("emit-changed", { nonce, why, emitted: false, err: "no-emit-channel" });
        return;
      }
      try {
        await rpcReg.events.emit("changed", { nonce, at: new Date().toISOString() });
        log("emit-changed", { nonce, why, emitted: true });
      } catch (e) {
        log("emit-changed", { nonce, why, emitted: false, err: errMsg(e) });
      }
      try {
        db?.run("INSERT INTO writes (at, role, note) VALUES (?, ?, ?)", [new Date().toISOString(), "server", `emit:${why}`]);
      } catch { /* 落库失败不影响 emit 结论 */ }
    };

    // ── ⑤⑦⑧ 命令注册：冒号名 + 无冒号名，execute 走 wait→prompt(resume:false) ──
    try {
      const reg = ctx.command.transform((editor: any) => {
        const add = (name: string) => {
          try {
            editor.add({
              name,
              description: "P0 probe 命令（降级轨形态）",
              execute: async (inv: any) => {
                const sessionID = inv?.sessionID;
                log("cmd-execute", { name, sessionID });
                // ⑤-wait：忙时先排空（busy 会话的 steer 注入边界行为在此记录挂起时长）
                const t0 = Date.now();
                try {
                  await ctx.session.wait({ sessionID });
                  log("cmd-wait", { name, ms: Date.now() - t0 });
                } catch (e) {
                  log("cmd-wait", { name, err: errMsg(e) });
                }
                const text = `P0 probe 输出（${name}）at ${new Date().toISOString()}`;
                try {
                  await ctx.session.prompt({ sessionID, text, delivery: "steer", resume: false, metadata: { probe: name } });
                  log("cmd-prompt", { name, ok: true });
                } catch (e) {
                  log("cmd-prompt", { name, ok: false, err: errMsg(e) });
                }
                await emitChanged(`cmd:${name}`);
              },
            });
            log("cmd-add", { name, ok: true });
          } catch (e) {
            log("cmd-add", { name, ok: false, err: errMsg(e) });
          }
        };
        add("wf:pingprobe"); // ⑦ 冒号名 server 注册
        add("pingprobe2");   // 无冒号对照组
      });
      log("cmd-transform", { ok: true, disposedApi: typeof reg?.dispose === "function" });
    } catch (e) {
      log("cmd-transform", { ok: false, err: errMsg(e) });
    }

    // ④ 对照：boot 3s 主动 emit 一次——此刻 TUI 订阅尚未建立（首渲染更晚）→ TUI 应收不到 = live-only 实证
    const bootTimer = setTimeout(() => {
      emitChanged("boot-3s").catch((e: unknown) => log("boot-emit-ERR", { err: errMsg(e) }));
    }, 3000);

    return () => {
      clearTimeout(bootTimer);
      try { rpcReg?.dispose?.(); } catch { /* ignore */ }
      try { db?.close(); } catch { /* ignore */ }
      log("cleanup", {});
    };
  },
};
