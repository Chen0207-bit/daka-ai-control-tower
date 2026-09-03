# UI 分支任务

你负责 DAKA Ontology Workbench 前端。先读 CLAUDE.md、README、当前 app、ontology-panel、前端 API client 与样式。

文件边界：主要修改 `app/**`、前端组件和前端测试；不要修改 `packages/ontology-runtime/**`、`worker/**`、数据库、迁移、`.vscode/**`。

目标：把普通 CRUD 页面升级为业务视图/本体透视/Runtime 调试器联动界面。付款闭环是完整纵向切片：左侧业务对象与登记付款，中间 11 阶段时间线，右侧或底部含 YAML Source、Canonical IR、Policy/Rule Explain、Fact/SQL Diff、Projection Diff、Audit/Outbox。支持 trace stage 状态、选择步骤、暂停/继续回放、dry-run 与 commit 的明确区分。默认只展示当前 action 的本体子图，避免毛线球。每个结果旁有“为什么/如何产生”。移动端至少不破版。

由于 Runtime 分支并行开发，先定义最小前端 Trace DTO/adapter 和 mock fallback，不伪装真实落库；清楚标记 demo/mock。尽量让 adapter 容易映射到 `/v1/traces/:traceId` 与 plan/action API。不要发明与现有风格冲突的大型框架。

新增必要组件测试，执行适用的 lint/typecheck/test/build。完成后提交到当前分支，commit message 使用 `feat(ui): add ontology runtime workbench`，汇报 commit hash、截图/运行方式、测试结果和接口假设。不要发布，不要碰其他 worktree。

