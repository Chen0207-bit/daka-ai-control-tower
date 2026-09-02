import { defineConfig } from "vitest/config";

// 集成测试需要 DATABASE_URL 指向便携 PostgreSQL（见 .env.example）。
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
  },
});
