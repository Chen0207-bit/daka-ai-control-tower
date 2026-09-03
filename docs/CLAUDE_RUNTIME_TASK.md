# Runtime 分支任务

你负责 DAKA 可观察本体工作台的 Runtime/Core/API 垂直切片。先读 CLAUDE.md、README、ontology、packages/ontology-runtime、worker、db/migrations、现有测试。

文件边界：主要修改 `packages/ontology-runtime/**`、`worker/**`、`db/**`、`migrations/**`、必要的共享 type；不要修改 `app/**`、全局样式、`.vscode/**` 和演示文档。

目标：为付款闭环实现统一 ExecutionTrace/TraceSpan 协议，覆盖 action received、ontology resolved、policy、validation、facts loaded、preconditions、writeset planned、transaction、rules、projection、audit/outbox。实现持久化查询、dry-run/plan（绝不落库）、成功/权限拒绝/前置条件失败的真实语义；失败链不得伪造 committed。贯穿 traceId/correlationId，输出脱敏。优先复用已有 action engine、policy、rules、audit/outbox。

提供稳定的前端消费类型和 API；新增关键 runtime/API 测试。执行适用的 typecheck/test/build。完成后提交到当前分支，commit message 使用 `feat(runtime): add observable ontology action traces`，汇报 commit hash、接口契约、测试结果和已知限制。不要发布、不要改真实数据、不要碰其他 worktree。

