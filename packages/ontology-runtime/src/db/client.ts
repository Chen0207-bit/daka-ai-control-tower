import pg from "pg";
import type { ActorContext } from "../context";

/**
 * DB 访问约定：
 * - 所有业务读写走 withTx：单事务内 SET LOCAL app.tenant_id/app.workspace_id（RLS 依据）。
 * - 连接角色应为 daka_runtime（非表 owner），RLS 生效；迁移/seed 用 daka_app。
 */
export type Db = pg.Pool | pg.PoolClient | pg.Client;

export interface Queryable {
  query: pg.Pool["query"];
}

export async function withTx<T>(
  pool: pg.Pool,
  ctx: ActorContext,
  fn: (client: pg.PoolClient) => Promise<T>,
  wrapClient?: (client: pg.PoolClient) => pg.PoolClient,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [ctx.tenantId]);
    await client.query("SELECT set_config('app.workspace_id', $1, true)", [ctx.workspaceId]);
    const result = await fn(wrapClient ? wrapClient(client) : client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 5 });
}
