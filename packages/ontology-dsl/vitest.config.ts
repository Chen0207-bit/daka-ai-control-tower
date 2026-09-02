import { defineConfig } from "vitest/config";

// 与根 vite.config.ts（Cloudflare Worker 插件）隔离：本包是纯 Node 库。
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
