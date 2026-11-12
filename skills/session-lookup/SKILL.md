---
name: Session Lookup
description: >
  流程外查询或引用 opencode session 时必须使用。触发场景：列出/查找 opencode 会话；
  读取某会话的消息记录；按前缀定位 sessionID；遇到 SessionNotFoundError 或
  "session not found" 404；跨会话取报告/诊断需要别的会话 ID；典型措辞如
  "查一下 session"、"这个会话的 ID"、"find session"、"session lookup"。
  固化 ID 管道闭环纪律（取列表→筛 ID→用 ID 不出管道），防凭记忆复述长 ID 截断。
  wf 工作流内的子会话续接不适用（走插件 guidance/roleSessions）。
---

## 何时使用 / 何时不用

- ✅ 用：列会话、读会话消息、按前缀找 sessionID、诊断 SessionNotFoundError、跨会话取报告/诊断。
- ❌ 不用：wf 工作流内的子会话续接——用 guidance 渲染的完整 sessionID 或
  `sessionID="auto"`（多 lane `@Tnn`），无需查列表。

## 铁律

- session ID 永不在管道外凭记忆复述：取列表 → 筛 ID → 用 ID 全程在一条 shell
  管道内闭环；或落盘 /tmp/opencode/ 后以 `$(cat ...)` 引用。
- `opencode api` 对 session ID 精确匹配、不支持前缀：前缀只用于本地筛选，
  不能直接拼进 API 路径。

## 标准管道

按前缀定位并直接消费（ID 不过模型；唯一命中才输出，多候选/无候选显式报错）：

```bash
opencode api get /api/session | python3 -c "
import json,sys
pfx='<前缀>'
rows=json.load(sys.stdin).get('data',[])
hits=[r['id'] for r in rows if r.get('id','').startswith(pfx)]
if not hits: sys.exit(f'❌ 无会话命中前缀 {pfx}；放宽前缀重试')
if len(hits)>1: sys.exit(f'❌ 前缀 {pfx} 命中 {len(hits)} 个不唯一，请加长：'+' '.join(hits))
print(hits[0])
" | xargs -r -I{} opencode api get /api/session/{}/message
```

跨轮复用：先落盘、后引用路径（模型只写路径不写 ID）：

```bash
opencode api get /api/session | python3 -c "...同上筛选..." > /tmp/opencode/target-ses.txt
opencode api get /api/session/$(cat /tmp/opencode/target-ses.txt)/message
```

## 404 诊断

`SessionNotFoundError` = ID 截断/失真（API 精确匹配、无前缀匹配）。
处置：重取完整列表逐字复制，勿凭记忆重试原 ID。

## 与 wf 插件的边界（M16-r45 起）

- 流程内续接：`sessionID="auto"`（该角色唯一登记时）或 `sessionID="@Tnn"`
  （多 lane 从 lanes 反查）；guidance 渲染的完整 ID 仍兼容逐字复制。
- 本 skill 仅覆盖流程外场景：手动查询、诊断、跨项目会话检查。
