import { defineConfig } from "vitest/config";

/** UI 组件测试独立配置：node 环境 + renderToStaticMarkup，不依赖 jsdom。 */
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    include: ["app/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
