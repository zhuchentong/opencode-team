// R2 T2.1（arch-r2-profile-statemachine）：WorkflowProfile 形状完整性守卫。
// 模式=数据三元组（flows/gates/phases）+ guidance 编排层 GUIDANCE_BY_ID 按 id 派发——
// 本锁保证「新增模式两处成对注册，漏一处即红」：profile 键集 ⊆ guidance 可达（双模式 smoke），
// gates 键 ⊆ flows 键，flows.to ∈ phases 键，nextFor 未知阶段 fallback 不变。
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROFILES, profileOf, registerProfile, nextFor, GATES, GATES_DAILY } from "../server/lib.ts";
import { guidance } from "../server/guidance.ts";

const blank = (over = {}) => ({ slug: "t", phase: null, rounds: { plan_review: 0, build_review: 0, test_fix: 0 }, artifacts: {}, lanes: {}, ...over });

test("R2 T2.1：PROFILES 双模式自注册，三元组齐全且非空", () => {
  assert.deepEqual(Object.keys(PROFILES).toSorted(), ["daily", "full"]);
  for (const id of ["full", "daily"]) {
    const p = PROFILES[id];
    assert.equal(p.id, id);
    assert.ok(Object.keys(p.flows).length > 0, `${id} flows 非空`);
    assert.ok(Object.keys(p.gates).length > 0, `${id} gates 非空`);
    assert.ok(Object.keys(p.phases).length > 0, `${id} phases 非空`);
  }
});

test("R2 T2.1：profileOf 是 isDaily 唯一消费点（存量无 mode→full；daily→daily）", () => {
  assert.equal(profileOf(blank()).id, "full", "存量无 mode → full 兼容");
  assert.equal(profileOf(blank({ mode: "full" })).id, "full");
  assert.equal(profileOf(blank({ mode: "daily" })).id, "daily");
  assert.equal(profileOf(blank({ mode: "未知" })).id, "full", "未知 mode 回退 full");
});

test("R2 T2.1：gates 键 ⊆ flows 键；flows.to ∈ phases 键（双模式）", () => {
  for (const id of ["full", "daily"]) {
    const p = PROFILES[id];
    for (const cmd of Object.keys(p.gates)) assert.ok(cmd in p.flows, `${id} gate 命令无 flow：${cmd}`);
    for (const [cmd, f] of Object.entries(p.flows)) assert.ok(f.to in p.phases, `${id} flow.to 无 phase 注册：${cmd}→${f.to}`);
  }
});

test("R2 T2.1：Gate 对象形状（id/isSatisfiedBy/explain）与表同源", () => {
  for (const table of [GATES, GATES_DAILY]) {
    for (const [cmd, g] of Object.entries(table)) {
      assert.equal(typeof g.id, "string", `${cmd} gate.id`);
      assert.equal(typeof g.isSatisfiedBy, "function", `${cmd} isSatisfiedBy`);
      assert.equal(typeof g.explain, "function", `${cmd} explain`);
      assert.ok(g.id.length > 0);
    }
  }
  assert.equal(GATES_DAILY["wf:done"], GATES["wf:done"], "daily done 关卡复用 full 同一对象");
});

test("R2 T2.1：guidance 派发覆盖全部 profile.id（GUIDANCE_BY_ID 成对注册守卫）", () => {
  for (const id of Object.keys(PROFILES)) {
    const st = blank({ mode: id, phase: "planning" });
    const g = guidance("planning", st);
    assert.ok(g.startsWith("【wf 工作流｜planning"), `${id} guidance 须命中注册表（漏注册=红）：${g.slice(0, 40)}`);
  }
});

test("R2 T2.1：nextFor 未知阶段 fallback=/wf:intake（双模式）；registerProfile 可扩展", () => {
  assert.equal(nextFor(blank(), "不存在阶段"), "/wf:intake");
  assert.equal(nextFor(blank({ mode: "daily" }), null), "/wf:intake");
  // 扩展面：注册临时 profile 后 profileOf 可取（不污染既有键——用独立 id）
  registerProfile({ id: "r2-probe", flows: {}, gates: {}, phases: {} });
  assert.ok(PROFILES["r2-probe"], "registerProfile 写入注册表");
  delete PROFILES["r2-probe"]; // 清理（测试隔离）
});
