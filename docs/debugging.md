# 本地调试指南（Worker TypeScript 真实断点）

目标：在本机对 Ontology Runtime 的 action engine、policy、rule runner、API 路由打真实断点，source map 生效，调试端口仅监听 localhost。全程不需要任何真实密钥或远端资源。

## 断点落点（TypeScript 源文件）

| 关注点 | 文件 |
| --- | --- |
| action 执行链（authorize → precondition → handler → audit/outbox） | `packages/ontology-runtime/src/actions/engine.ts` |
| effect handler 注册表 | `packages/ontology-runtime/src/actions/handlers.ts` |
| policy / RLS 授权 | `packages/ontology-runtime/src/policy.ts` |
| rule runner / AST evaluator | `packages/ontology-runtime/src/rules/runner.ts`、`rules/evaluator.ts` |
| API 路由装配（Worker 适配层） | `worker/ontology/api.ts` |

## 方式一：VS Code（推荐）

`.vscode/launch.json` 已配置三组：

1. **1) Dev server + workerd inspector (terminal)** — 在 VS Code 内建终端启动 `pnpm exec vite dev --inspect`。workerd 的 V8 inspector 只监听 `localhost:9229`（workerd 默认绑定 127.0.0.1，不对外暴露）。
2. **2) Attach to Worker inspector (:9229)** — dev server 就绪后启动本配置，附加到 workerd。`resolveSourceMapLocations: null` 用于容忍 workerd 虚拟路径与磁盘路径的差异，断点应能落回 `.ts` 源文件。
3. **Debug vitest (ontology packages)** — 以 `--inspect-brk` 跑 packages 下 vitest，适合单步 policy / rule / contract test 的纯 Node 逻辑（不需要 dev server）。

操作顺序：先 F5 跑配置 1 → 等终端出现 dev server ready → 再切到配置 2 点启动 → 在 `engine.ts` / `policy.ts` 打断点 → 浏览器或 `pnpm test:e2e` 触发请求。

## 方式二：Chrome DevTools

1. 终端启动：`pnpm exec vite dev --inspect`
2. Chrome 打开 `chrome://inspect` → “Open dedicated DevTools for Node”。
3. 在 Sources 里打开 `packages/ontology-runtime/src/**`（source map 自动加载），下断点后触发请求。
4. 若端口未自动出现，点 “Configure…” 确认只有 `localhost:9229`（不要加 `0.0.0.0`）。

## 契约测试调试（无 DB）

`packages/ontology-runtime/test/acceptance.contract.test.ts` 全部为无库断言，直接用配置 3 单步即可；集成测试 `integration.test.ts` 缺 `DATABASE_URL_RUNTIME` 时整体 skip，不会误报。

## 安全约束

- inspector 端口仅限 localhost；不要把 `--inspect` 改成 `--inspect=0.0.0.0`。
- 本配置只面向本地 dev server，不适用于任何 Cloudflare Preview / 生产 Worker。
