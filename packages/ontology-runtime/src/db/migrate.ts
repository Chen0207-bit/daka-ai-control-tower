import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/**
 * 迁移 runner: 按文件名顺序应用 migrations/postgres/NNNN_*.sql, 记录进 schema_migrations。
 * - 0000_bootstrap.sql 由超级用户手动执行(角色/库创建), runner 跳过。
 * - 每个迁移自带事务; 失败即停, 不留半迁移状态。
 * - migrate --verify 校验所有迁移已应用且表结构完整。
 */

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export async function runMigrations(databaseUrl: string, migrationsDir: string): Promise<MigrateResult> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const { rows } = await client.query<{ version: string }>("SELECT version FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.version));
    const files = readdirSync(migrationsDir)
      .filter((f) => /^\d{4}_.+\.sql$/.test(f) && !f.startsWith("0000_"))
      .sort();
    const result: MigrateResult = { applied: [], skipped: [] };
    for (const f of files) {
      const version = f.replace(/\.sql$/, "");
      if (applied.has(version)) {
        result.skipped.push(version);
        continue;
      }
      const sql = readFileSync(join(migrationsDir, f), "utf8");
      await client.query(sql);
      result.applied.push(version);
    }
    return result;
  } finally {
    await client.end();
  }
}

const REQUIRED_TABLES = [
  "schema_migrations",
  "ontology_releases",
  "object_records",
  "link_records",
  "fact_assertions",
  "documents",
  "evidence_anchors",
  "action_runs",
  "action_traces",
  "audit_events",
  "outbox_events",
  "projection_checkpoints",
  "ingest_jobs",
  "ingest_records",
  "role_bindings",
];

export async function verifyMigrations(databaseUrl: string): Promise<{ ok: boolean; missing: string[] }> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
    );
    const existing = new Set(rows.map((r) => r.tablename));
    return { ok: REQUIRED_TABLES.every((t) => existing.has(t)), missing: REQUIRED_TABLES.filter((t) => !existing.has(t)) };
  } finally {
    await client.end();
  }
}

// CLI: tsx src/db/migrate.ts [verify]  (DATABASE_URL 环境变量必填)
if (process.argv[1] && process.argv[1].endsWith("migrate.ts")) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    process.stderr.write("DATABASE_URL 未设置（见 .env.example）\n");
    process.exit(2);
  }
  const dir = process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL("../../../../migrations/postgres", import.meta.url));
  if (process.argv[2] === "verify") {
    const v = await verifyMigrations(url);
    if (v.ok) {
      process.stdout.write("OK: migration verification 通过，全部核心表存在\n");
      process.exit(0);
    }
    process.stderr.write(`FAIL: 缺表 ${v.missing.join(", ")}\n`);
    process.exit(1);
  }
  const result = await runMigrations(url, dir);
  process.stdout.write(`applied: [${result.applied.join(", ")}]\nskipped: [${result.skipped.join(", ")}]\n`);
  process.exit(0);
}
