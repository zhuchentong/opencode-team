// wf-workflow — wf_write_artifact 工具（M3，自 index.ts 原样搬移）：kind → .workflow/<slug>/ 文件名，
// 落盘并记入 state.artifacts；test-plan/test-report 同步关卡记账（testPlanWritten/testReportVerdict）；
// 子会话经 resolveState 反查管辖状态（M10-b）。
// 已验证 API（实测 2026-11-09）：工具注册 draft.add({name, description, input:<JSONSchema>,
// options:{codemode:false}, execute: async (args, context) => ({ content }) })；实测 context 仅
// {sessionID, agent, messageID, id, progress, signal}——**无 directory**！项目目录须经
// ctx.session.get(sessionID).location.directory 取（封装于 state.resolveProjectDir）。
// P4 公告（goopspec blocked-append）：test-report 落盘后按 verdict 在工具输出里指路
// （PASS→/wf:done、FAIL→/wf:fix 后重跑 /wf:test）——agent 在 tool output 即可看到下一步。
import * as fs from "node:fs";
import { createHash } from "node:crypto"; // r53 批次 1：register 幂等 hash 复核（managed-sync 同款 sha256 前 12 位口径）
import { VERSION, KIND_FILES, hasStrictVerdictLine, artifactPhaseWarning, artifactSizeWarning, fuzzyFind, markVerdicts, profileOf, trackRoleSession, CHUNK_KB, checkLaneDeps, checkProbeMatrix, checkPlanEscape, tierOf, type WfState } from "./lib.ts"; // R2 T2.1：isDaily→profileOf // CHUNK_KB：分段阈值单一来源 // opt-agentic 项①：markVerdicts 记账单点（verdict/lane 表判定收敛 domain 同源） // 效率批 P1：checkLaneDeps/tierOf（预检 fail-fast 副本） // W14：checkPlanEscape（扩展逃生门条款写时预检）
import { logAdd, withStateRetry, type Store } from "./state.ts";
import { type Observer } from "./observe.ts";

/** 内容 hash：sha256 前 12 位 hex（与 managed-sync 两域同源；bytes 弱比较的强复核锚）。
 * @param buf 待哈希内容（Buffer 或字符串）。
 * @returns sha256 前 12 位 hex 串。 */
const hashOf = (buf: Buffer | string): string => createHash("sha256").update(buf).digest("hex").slice(0, 12);

// M16-r39 T06：deps 类型化（ArtifactDeps 契约；宿主入参 ctx 保留 any）
export interface ArtifactDeps {
  resolveState: Store["resolveState"];
  resolveProjectDir: Store["resolveProjectDir"];
  save: Store["save"];
  emitUpdated: (st: WfState) => Promise<void>;
  probeOnce: Observer["probeOnce"];
  logToolsOnce: Observer["logToolsOnce"];
}

/** 注册 wf_write_artifact 工具：产物落盘/修订/注册三模式 + 记账（artifacts/verdicts/lane 表）与告警指路。
 * @param host T03 防腐层（tools.transform 注册面）
 * @param deps 显式注入依赖（ArtifactDeps 契约）：resolveState/resolveProjectDir/save/emitUpdated/probeOnce/logToolsOnce
 * @returns 工具注册 dispose 句柄（host.tools.transform 返回值透传） */
export function registerArtifactTool(host: import("./host.ts").Host, deps: ArtifactDeps) { // T03：ctx→Host
  const { resolveState, resolveProjectDir, save, emitUpdated, probeOnce, logToolsOnce } = deps;
  return host.tools.transform((draft: any) => {
    const namesPromise = Promise.resolve(draft.list?.()).catch(() => null);
    draft.add({
      name: "wf_write_artifact",
      description:
        "把 wf 工作流产物写入 <项目>/.workflow/<slug>/。kind 决定文件名：" +
        Object.keys(KIND_FILES).join(" | ") +
        "。循环类产物（plan-review/build-review）自动按当前轮次编号。" +
        "三种模式（互斥）：① content=完整内容首写；② patch=[{old,new}] 增量修订（old 逐字摘录、唯一匹配、按序应用；严格未命中自动回退引号/破折号/nbsp 变体与行尾空白容忍的模糊匹配）；" +
        "③ 不带 content 与 patch = 注册（register）：产物已由原生 write/edit 落盘时，只读盘记账+告警+指路——入参极小、几乎不会流中断失败，重试不重新生成内容。" +
        `大产物（>${CHUNK_KB}KB）推荐分段：首段原生 write、后续 edit 追加（每段≤${CHUNK_KB}KB），失败先 read 尾部断点续写，全部落盘后才 register（结论行在首段，提前 register 会以截断内容过关卡）。`,
      input: {
        type: "object",
        properties: {
          kind: { type: "string", enum: Object.keys(KIND_FILES), description: "产物类型" },
          content: { type: "string", description: "完整文件内容（首写用；与 patch 二选一；两者皆缺=注册已落盘产物）" },
          patch: {
            type: "array",
            description: "增量修订（修订已有产物用；与 content 二选一）：old 逐字摘录原文、唯一匹配，按序应用；严格未命中自动模糊回退（引号/破折号变体、行尾空白）",
            items: {
              type: "object",
              properties: {
                old: { type: "string", description: "原文中待替换的片段（逐字摘录，须唯一）" },
                new: { type: "string", description: "替换后的内容" },
              },
              required: ["old", "new"],
            },
          },
        },
        required: ["kind"],
      },
      options: { codemode: false },
      execute: async (args: any, context: any) => {
        try {
          await probeOnce(context?.sessionID, "tool-probe", {
            argsKeys: Object.keys(args ?? {}),
            contextKeys: Object.keys(context ?? {}),
            sessionID: context?.sessionID,
            directory: context?.directory,
          });
          await logToolsOnce(namesPromise, context?.sessionID);
          const kind = String(args?.kind ?? "");
          const mk = KIND_FILES[kind];
          if (!mk) return { content: `❌ 未知 kind=${kind}（可用：${Object.keys(KIND_FILES).join(" | ")}）` };
          // M16-r33 P1a：content（首写）与 patch（增量修订）互斥；M16-r47：两者皆缺=注册已落盘产物
          const hasContent = typeof args?.content === "string";
          const patch = Array.isArray(args?.patch) ? args.patch : null;
          if (hasContent && patch) return { content: "❌ content 与 patch 互斥：首写用 content，修订已有产物用 patch，两者皆缺=注册已落盘产物。" };
          const initial = await resolveState(context?.sessionID, context?.agent); // M10-b：子会话经项目索引反查管辖状态
          if (!initial?.slug) return { content: "❌ 本会话无活动 wf 任务：请回报 leader，由 leader 调用 wf_command(name=\"wf:intake\", prompt=\"<slug>\") 开任务（或用户手敲 /wf:intake <slug>）。子会话不得自行推进。\n若本会话非 wf 工作流会话且用户未明确要求走工作流：忽略本提示，直接按默认方式完成任务。" }; // nonleader-decontam B2b：默认回退（第二行；条件排除 wf/* 子会话，其"回报 leader"语义保留）
          // 落盘目录：三级回退（resolveProjectDir，与 wf:diagnose 同源）
          const dir = await resolveProjectDir(initial, context?.sessionID);
          const file = mk(initial); // 文件名按首快照轮次定型；并发重放不改名（文件已落盘，记账与磁盘必须同名）
          const target = `${dir}/.workflow/${initial.slug}/${file}`;
          // M16-r33 P1a：patch 模式——读磁盘原文，顺序应用（M16-r47：严格未命中自动模糊回退——
          // 引号/破折号/nbsp 1:1 变体 + 行尾空白容忍，见 lib.fuzzyFind）；未命中/歧义/目标不存在 →
          // 报错不落盘。修订只输出变更段，省全量重写的生成耗时。
          // M16-r47 register 模式：content/patch 皆缺 → 产物已由原生 write/edit 落盘，只读盘记账。
          let finalContent: string;
          let mode: "write" | "patch" | "patch-fuzzy" | "register";
          if (patch) {
            if (!fs.existsSync(target)) return { content: `❌ patch 目标不存在：${target}（首写用 content；产物已原生落盘则不带 content 注册）。` };
            let cur = fs.readFileSync(target, "utf8");
            let fuzzy = false;
            for (let i = 0; i < patch.length; i++) {
              const old = String(patch[i]?.old ?? "");
              const nw = String(patch[i]?.new ?? "");
              if (old === nw) continue; // 幂等跳过
              if (!old) return { content: `❌ patch[${i}].old 为空（须逐字摘录原文片段）。` };
              const fm = fuzzyFind(cur, old);
              if (fm.status === "notfound") return { content: `❌ patch[${i}] 未命中：old 须逐字摘录产物原文（修订前先 read 产物；自动回退仅容忍引号/破折号/nbsp 变体与行尾空白），本次未落盘。` };
              if (fm.status === "ambiguous") return { content: `❌ patch[${i}] 歧义：old 在产物中出现多次（含归一后），请补充上下文使其唯一，本次未落盘。` };
              if (fm.via !== "exact") fuzzy = true;
              cur = cur.slice(0, fm.start) + nw + cur.slice(fm.end);
            }
            finalContent = cur;
            mode = fuzzy ? "patch-fuzzy" : "patch";
          } else if (hasContent) {
            finalContent = args.content;
            mode = "write";
          } else {
            if (!fs.existsSync(target)) return { content: `❌ register 目标不存在：${target}（${kind} 的期望文件名）。先把内容写到该路径（大产物分段 ≤${CHUNK_KB}KB/段）再注册；或首写直接带 content。` };
            finalContent = fs.readFileSync(target, "utf8");
            if (!finalContent.length) return { content: `❌ 产物为空（0 字节）：${target}——疑似截断残留，拒绝注册（补写内容后重试）。` };
            const diskBytes = fs.statSync(target).size;
            // M16-r47 plan 幂等守卫：盘上 bytes 与记账一致 → no-op 早退，不清 review 记账——
            // register 调用廉价，误调/重放不得放大「修订即清」锐边。
            // r53 批次 1：bytes 一致再 sha256 复核（消除同 bytes 异内容碰撞的文档化局限）；
            // 存量记账无 hash → 退回 bytes 弱比较（向后兼容，保持 no-op 不放大锐边）；
            // bytes 同 hash 异 → 不早退，落到下方 mark 的「修订即清」路径+审计照记。
            if (kind === "plan" && initial.artifacts?.[file]?.bytes === diskBytes) {
              const prevHash = initial.artifacts?.[file]?.hash;
              const diskHash = hashOf(fs.readFileSync(target));
              if (prevHash === undefined || prevHash === diskHash) {
                return { content: `✅ [${VERSION}] ${target} 已注册且内容未变化（${diskBytes} bytes）：记账不重放（review 结论/test-plan/方案确认记账保留）。` };
              }
            }
            mode = "register";
          }
          if (mode !== "register") {
            fs.mkdirSync(`${dir}/.workflow/${initial.slug}`, { recursive: true });
            fs.writeFileSync(target, finalContent.endsWith("\n") ? finalContent : `${finalContent}\n`);
          }
          const bytes = fs.statSync(target).size;
          const hash = hashOf(fs.readFileSync(target)); // r53 批次 1：落盘结果 hash（write 补 \n 后以盘上为准）
          // 效率批 P1：plan lane-deps 机器区预检（fail-fast 副本——记账判定以 markVerdicts 单点自 derive 为准，
          // 评审 M3；gate-reconcile 补记路径同样只经 markVerdicts）。
          // 评审 M5 修订：硬拒仅限 planning/review（未来关卡的保护窗口内）；building/testing 降级 ⚠️+记账
          // laneDepsOk=false（此时 wf:build 已过，硬拒=纯摩擦）；register 幂等 no-op 早退（上方 bytes+hash
          // 一致路径）先于本检查——保 pre-upgrade 无机器区 plan 的重放不受拒。
          const dep = kind === "plan" ? checkLaneDeps(finalContent, tierOf(initial.size)) : null;
          if (dep && !dep.ok && (initial.phase === "planning" || initial.phase === "review")) {
            return { content: `❌ lane 依赖边表校验未过（${file}，本次未落盘/未记账——修订机器区后重试；violations 清单如下）：\n` + dep.violations.map((s) => `- ${s}`).join("\n") };
          }
          // W11-v2.1：probe-matrix 机器区预检（fail-fast 副本——记账以 markVerdicts 单点自 derive 为准；
          // 硬拒窗口与 lane-deps 同口径：仅 planning/review，building/testing 降级 ⚠️+记账 probeMatrixOk=false）。
          const pm = kind === "plan" ? checkProbeMatrix(finalContent, tierOf(initial.size)) : null;
          if (pm && !pm.ok && (initial.phase === "planning" || initial.phase === "review")) {
            return { content: `❌ probe-matrix 机器区校验未过（${file}，本次未落盘/未记账——修订机器区后重试；violations 清单如下）：\n` + pm.violations.map((s) => `- ${s}`).join("\n") };
          }
          // W14：扩展逃生门条款预检（test_57 F1 同族二现、提示词层证伪 → 结构强制）。三模式统一对
          // finalContent 单点校验（register 主路径实证=test_57 events mode=register）；tierOf!=="S"
          // 统一门（评审 v1 F-1：裸「写集」标记在真实语料假阳率 2/3）；硬拒窗与上两块同口径，
          // register 幂等 no-op 早退先于本检查（pre-upgrade 无条款 plan 重放不受拒）。
          const esc = kind === "plan" ? checkPlanEscape(finalContent, tierOf(initial.size)) : null;
          if (esc && !esc.ok && (initial.phase === "planning" || initial.phase === "review")) {
            return { content: `❌ 扩展逃生门条款校验未过（${file}，文本已落盘、记账冻结——修订 plan 补条款后重新注册；violations 清单如下）：\n` + esc.violations.map((s) => `- ${s}`).join("\n") };
          }
          // M16-r33/M16-r34（语义随 markVerdicts 迁移）：verdict 从**结果全文**解析（patch/register
          // 模式入参无 content——markVerdicts 内部经 domain parseVerdict 对全文判定，否则 done 关卡误拦）
          // T04：记账写回带冲突重试——文件已落盘不重写，stale-rev 时仅对最新快照重放记账字段（≤3）
          const mark = (row: WfState) => {
            // M16-r40：角色→子会话自动登记（搭本次记账 save 便车，零额外写盘）——
            // 产物写入者（planner/reviewer/tester/builder-reviewer/learner）在此暴露子会话身份
            trackRoleSession(row, context?.agent, context?.sessionID);
            // opt-agentic 项①：verdicts 记账收敛 domain/artifact.markVerdicts 单点（与 gate-reconcile
            // 补记同源口径，verdict 从结果全文解析的 M16-r33 语义、r55 修复 1 lane 表判定均随迁）；
            // clearOnPlan=true 保留 M16-r39 T02 plan 修订清双通道 + M16-r44 清确认记账语义；
            // bytes-no-op 早退不进 mark=保留上次记账的幂等语义不变。
            markVerdicts(row, file, kind, finalContent, bytes, hash, new Date().toISOString(), { clearOnPlan: true });
            logAdd(row, { at: new Date().toISOString(), cmd: "tool:wf_write_artifact", from: row.phase, to: row.phase, ok: true, note: mode === "write" ? file : `${file} mode=${mode}`, detail: `hash=${hash}` }); // r53 批次 1：hash 入审计 detail（wf.db 不进模型上下文）
          };
          // M16-r39 T07：归一 withStateRetry——mark 移入 apply（每 attempt 恰一次，防审计翻倍）；
          // load(1)=初始 st、load(n)=resolveState 最新快照（无 slug→null=gone，行被并发清除）
          const res = await withStateRetry({
            load: async (attempt) => {
              if (attempt === 1) return initial;
              const fresh = await resolveState(context?.sessionID, context?.agent);
              return fresh?.slug ? fresh : null;
            },
            apply: (row) => { mark(row); return null; },
            save,
          });
          const verb = mode === "register" ? "已注册" : "已写入";
          if (!res.ok) {
            if (res.reason === "gone") {
              return { content: `✅ ${verb} ${target}（${bytes} bytes）；⚠️ 状态行已被并发清除（reset？），记账跳过——产物已落盘，重开任务后可用 /wf:diagnose 对账` };
            }
            return { content: `✅ ${verb} ${target}（${bytes} bytes）；❌ 状态记账保存失败（${res.reason}），产物对账不一致（/wf:diagnose 可核对），请重试${mode === "register" ? "注册" : "写入"}（无需重写内容）。` };
          }
          const st = res.st;
          await emitUpdated(st);
          let note = `✅ [${VERSION}] ${verb} ${target}（${bytes} bytes）`;
          // M16-r29：阶段纪律——产物错位告警（不阻断，落盘/记账照常）
          const phaseWarn = artifactPhaseWarning(kind, st.phase);
          if (phaseWarn) note += `\n${phaseWarn}`;
          // M16-r32：产物瘦身——超预算告警（不阻断，落盘/记账照常）；M16-r33：按任务体量分级
          const sizeWarn = artifactSizeWarning(kind, bytes, st.size);
          if (sizeWarn) note += `\n${sizeWarn}`;
          // 效率批 P1：lane-deps 预检结果回显（通过=合并序信息面；未过硬拒降级=⚠️+violation 清单，
          // laneDepsOk=false 已由 markVerdicts 记账、wf:build 关卡兜底）。
          if (dep) {
            if (dep.ok) {
              if (dep.order) note += `\n→ lane 依赖边表通过；合并序：${dep.order}`;
            } else {
              note += `\n⚠️ lane 依赖边表未过（${dep.violations.length} 项，已记账 laneDepsOk=false，wf:build 关卡将拒——修订机器区后重新注册）：\n` + dep.violations.map((s) => `- ${s}`).join("\n");
            }
          }
          // W11-v2.1：probe-matrix 预检结果回显（与 lane-deps 同款：通过=简报；未过硬拒降级=⚠️+清单）
          if (pm) {
            note += pm.ok
              ? `\n→ probe-matrix 机器区通过（与 lane-deps 双射）`
              : `\n⚠️ probe-matrix 机器区未过（${pm.violations.length} 项，已记账 probeMatrixOk=false，wf:build 关卡将拒——修订机器区后重新注册）：\n` + pm.violations.map((s) => `- ${s}`).join("\n");
          }
          // W14：逃生门条款降级回显（building/testing 窗）。诚实版（评审 v1 F-4）：本批无 verdicts/gate
          // 元素，不提「已记账/关卡将拒」；残差=此窗删条款无下游兜底（接受，HOST-CONTRACT W14 节声明）。
          if (esc && !esc.ok) {
            note += `\n⚠️ plan 缺扩展逃生门条款（写集锁死时下游 T 点需扩声明即死锁——test_54/57 同族实证。修订 plan 后重新 wf:review 补条款）`;
          }
          if ((kind === "test-report" || kind === "plan-review") && !hasStrictVerdictLine(finalContent)) {
            note += `\n⚠️ ${kind} 首行应含「**结论**: PASS|FAIL」（记为 UNKNOWN 后 ${kind === "test-report" ? "/wf:done" : "日常模式 /wf:build"} 会被关卡拦截）`;
          }
          // P4 公告：verdict 指路（与 GATES["wf:done"] 拒绝文案同语义，agent 在 tool output 直接看到）
          if (kind === "test-report") {
            note += st.verdicts?.testReport === "PASS"
              ? `\n→ 验收 PASS：请 leader 调用 wf_command(name="wf:done") 推进（验收关卡放行；用户手敲亦可）`
              : `\n→ 验收 ${st.verdicts?.testReport ?? "UNKNOWN"}：FAIL → 请 leader 推进 /wf:fix 修复后重跑 /wf:test（wf_command 或用户手敲；UNKNOWN 需先补首行「**结论**: PASS|FAIL」）`;
          }
          // M16-r34：plan-review verdict 指路（日常模式 M/L 独立验证 → wf:build 关卡）
          if (kind === "plan-review") {
            note += st.verdicts?.planReview === "PASS"
              ? `\n→ 验证 PASS：请 leader 调用 wf_command(name="wf:build") 推进（日常模式验证关卡放行）`
              : `\n→ 验证 ${st.verdicts?.planReview ?? "UNKNOWN"}：FAIL → 请 leader 推进 wf:plan 带意见修订后再验（UNKNOWN 需先补首行「**结论**: PASS|FAIL」）`;
          }
          // M16-r39 T02：plan 修订清双通道记账——模式感知的重新验证指路
          if (kind === "plan") {
            note += "\nplan 已修订：review 结论、test-plan 与方案确认记账已清，须重新 " + (profileOf(st).id === "daily" ? "wf:review（含 question 方案确认）" : "wf:review / wf:test-design（含 question 方案确认）"); // R2 T2.1：模式判定单点
          }
          return { content: note };
        } catch (e) {
          return { content: `❌ wf_write_artifact 失败：${(e as Error)?.message ?? e}` };
        }
      },
    });
  });
}