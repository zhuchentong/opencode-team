# M4 根因报告：新项目 wf.db 首启含异项目行（状态库种子污染）

> headless-orch 步骤 6 取证产出（本批零代码改动）；方案 docs/OPT-plan-headless-orchestration.md §二 M4。
> 结论：**ready() 一次性迁移的 `host.storage.scan({prefix:"wf-workflow/state/"})` 作用域含异项目行，
> 迁移无 directory/projectID 归属校验，全量导入且 updatedAt 原样保留**——与 test_44 现场"新文件含旧
> 时间戳行"签名精确吻合。

## 一、现场证据（真机）

test_44（新测试项目）`.workflow/wf.db` tasks 表：

| session_id | slug | state_json.directory | updated_at |
|---|---|---|---|
| ses_e3cefb03… | stageb-dual | **/home/zhuchentong/Projects/zhuchentong/eye-guard**（异项目） | 2026-11-10T03:53:21.229Z（**旧时间戳原样**） |
| ses_e1c3cf1b… | csvkit-rfc4180 | /home/zhuchentong/Projects/test-space/test_44（本项目） | 2026-11-16T10:13:42.618Z |

查询命令（可复现）：
```bash
sqlite3 /home/zhuchentong/Projects/test-space/test_44/.workflow/wf.db \
  "SELECT session_id, slug, json_extract(state_json,'\$.directory'), updated_at FROM tasks;"
```
eye-guard 行出现在 test_44 新库 = 迁移数据源含异项目行（storage scan 未按项目过滤）。

## 二、代码定位（签名吻合）

`server/state.ts ready()`（createStore 内一次性迁移，tasks 空时触发）：
- `await host.storage.scan({ prefix: STATE_PREFIX })`（STATE_PREFIX=`wf-workflow/state/`）——
  **仅 prefix 维度，无 project 过滤**；`host.ts` L40-44/L82 为薄透传，作用域语义完全由宿主决定；
- 逐条 `qUpsert.run(sid, slug, phase, v.projectID, v.directory, isActive, 1, **v.updatedAt ?? null**, json)`——
  **updatedAt 原样保留**（设计意图=不重置 GC 时钟），异项目行同待遇；
- 迁移条件仅 `tasks 空`——任何新项目首启都会走全量导入。

## 三、复现（已执行，PASS）

最小复现（临时脚本，未入库；与 §一 同构）：

```bash
cd /home/zhuchentong/Projects/zhuchentong/opencode-team && bun -e '
import fs from "node:fs";
import { createStore } from "./server/state.ts";
import { mkHostStub } from "./tests/helpers/host-stub.js";
fs.mkdirSync("/tmp/opencode", { recursive: true });
const dir = fs.mkdtempSync("/tmp/opencode/m4-repro-");
const oldRow = { sessionID: "ses_eye_old", slug: "stageb-dual", phase: "done", projectID: "eye-pid",
  directory: "/home/zhuchentong/Projects/zhuchentong/eye-guard", updatedAt: "2026-11-10T03:53:21.229Z", log: [] };
const host = mkHostStub({ location: { directory: dir },
  storage: { scan: async ({ prefix }) => prefix === "wf-workflow/state/" ? [{ key: "wf-workflow/state/ses_eye_old", value: JSON.stringify(oldRow) }] : { entries: [] } },
  sessions: { get: async () => ({ projectID: "new-pid", location: { directory: dir } }) } });
const s = createStore(host); await s.ready;
console.log(await s.load("ses_eye_old")); s.close();'
```
输出：异项目行被导入，`updatedAt=2026-11-10T03:53:21.229Z` 原样保留、`directory=eye-guard` → **污染复现**。

## 四、影响面

1. 新项目首启吸入全部历史项目任务行 → resolveState 跨项目兜底路由污染（slug 撞车时可能路由到异项目状态）；
2. 异项目行带旧 updatedAt：14 天内不被 done GC 清理，长期滞留；
3. `/wf:status`、wf:ping 跨库并发扫描（scanActiveTasks）会把幽灵行误判为其它项目活动任务（休眠告警噪音）；
4. M2 slug 唯一性闸口径同库一致，不受跨库影响——但被污染库内的异项目行本身成为脏数据。

## 五、修复方向（立任务卡，本批不动码）

- **A（首选）迁移加归属校验**：ready() 导入前按 `v.directory`（或 projectID）与本项目比对，
  不匹配跳过并记账（swallow 前缀 `state:migrate-skip-foreign`）；存量被污染库可顺带清理
  （directory 非本项目的行为迁移对象——需 wf:diagnose 提示人工确认，勿静默删）。
- **B（治本）scan 加 project 维度过滤**：需宿主 ctx.storage 支持（或确认 storage 本就 per-plugin
  per-project、污染另有入口——先向宿主取证 storage 的 key 空间定义再动）。
- **边界核实项**：csvkit 行 `projectID="global"` 形态异常（非 hash 形 projectID）——修复前需核实
  projectID 写入链路（host.sessions.get 返回 projectID="global" 的场景语义），避免修复误伤合法行。
