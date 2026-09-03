# Explainability / QA 分支任务

你负责 DAKA 本体可解释性资产、开发调试体验和验收自动化。先读 CLAUDE.md、README、ontology YAML、compiler/manifest、现有 tests/scripts/docs。

文件边界：主要修改 `ontology/**`、`examples/**`、`scripts/**`、测试目录、`docs/**`、`.vscode/**`；除必要的测试挂钩外不要修改 `app/**`、`packages/ontology-runtime/**`、`worker/**` 或数据库迁移。

目标：

1. 给四条闭环整理可机器读取的 action 子图/来源引用元数据，优先 YAML；明确 assumed/demo/imported/evidence/verified、AI 建议与人工决定。
2. 市场建议必须表达 AI 无权直接改印量；签名额度表达守恒与超额阻断；合同链表达 evidence -> candidate -> verified -> rights/risk；付款链表达 action/policy/rule/projection。
3. 增加本地 VS Code/Chrome DevTools 调试配置与文档，能对 Worker TypeScript 的 action engine、policy、rule runner、API 打真实断点，source map 生效且调试端口仅本地。
4. 增加或完善不依赖真实密钥的验收脚本/contract tests，验证 dry-run 不落库、deny/failed 零写入、traceId 贯穿、AI 不可直接修改印量。
5. 提供 5 分钟中文演示脚本和验收清单。

执行适用的 lint/typecheck/test/build。完成后提交当前分支，commit message 使用 `test(ontology): add explainability and debugger acceptance`，汇报 commit hash、测试结果和需要集成分支适配的点。不要发布、不要碰其他 worktree。
