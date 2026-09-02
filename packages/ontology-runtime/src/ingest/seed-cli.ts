import { fileURLToPath } from "node:url";
import { createPool, withTx } from "../db/client";
import { loadManifest } from "../manifest";
import { applyDataPack, planDataPack, validateDataPack } from "./datapack";
import { loadDataPack } from "./datapack-fs";
import { materializeFindings, runRules } from "../rules/runner";

/**
 * seed:demo — 从空库执行: compile 产物 + demo pack → 幂等导入 → 规则推导 → 投影摘要。
 * 用法: DATABASE_URL=... tsx src/ingest/seed-cli.ts [--dry-run]
 */
async function main(): Promise<number> {
  const dryRun = process.argv.includes("--dry-run");
  const root = fileURLToPath(new URL("../../../..", import.meta.url));
  const manifest = loadManifest(`${root}/ontology/.generated/ontology.manifest.json`);
  const pack = loadDataPack(`${root}/ontology/data-packs/demo`);

  const errors = validateDataPack(pack, manifest);
  if (errors.length > 0) {
    process.stderr.write(`pack 校验失败:\n${errors.map((e) => `  - ${e}`).join("\n")}\n`);
    return 1;
  }
  const plan = planDataPack(pack);
  process.stdout.write(`pack ${pack.manifest.id}@${pack.manifest.version} fingerprint=${pack.fingerprint}\n`);
  process.stdout.write(`plan: ${JSON.stringify(plan.counts)}\n`);
  if (dryRun) {
    process.stdout.write("[dry-run] 不写库\n");
    return 0;
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    process.stderr.write("DATABASE_URL 未设置\n");
    return 2;
  }
  const pool = createPool(url);
  try {
    const applied = await applyDataPack(pool, manifest, pack);
    process.stdout.write(`apply: ${applied.status} jobId=${applied.jobId ?? "-"}\n`);

    const ctx = {
      tenantId: pack.manifest.tenantId,
      workspaceId: pack.manifest.workspaceId,
      actorId: "rule-runner",
      roles: ["dataSteward"],
      correlationId: `rules-${pack.fingerprint.slice(0, 12)}`,
    };
    const findings = await withTx(pool, ctx, async (client) => {
      const f = await runRules(client, ctx, manifest);
      const { ensureRelease } = await import("../repository");
      const releaseId = await ensureRelease(client, manifest, "rule-runner");
      const created = await materializeFindings(client, ctx, manifest, releaseId, f);
      return { findings: f.length, created: created.length };
    });
    process.stdout.write(`rules: findings=${findings.findings} created=${findings.created}\n`);

    const { paymentCalendar, signatureOverview, bossActionInbox } = await import("../projections");
    const [pc, so, inbox] = await Promise.all([
      paymentCalendar(pool, ctx, manifest),
      signatureOverview(pool, ctx, manifest),
      bossActionInbox(pool, ctx, manifest),
    ]);
    process.stdout.write(`paymentCalendar: ${pc.items.length} 项, 未结清=${pc.totals.unsettledAmount}, 逾期=${pc.totals.overdueAmount}\n`);
    process.stdout.write(`signatureOverview: ${so.lots.length} 批次, 可用=${so.totals.available} 已分配=${so.totals.allocated}\n`);
    process.stdout.write(`bossActionInbox: ${inbox.items.length} 项\n`);
    return 0;
  } finally {
    await pool.end();
  }
}

process.exit(await main());
