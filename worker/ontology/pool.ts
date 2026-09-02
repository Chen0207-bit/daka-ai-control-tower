import pg from "pg";

/**
 * Worker 环境的 pg.Pool 兼容 shim：连接池由 Hyperdrive 管理，
 * 每次 connect() 打开一个请求级 Client（官方推荐用法）。
 */
export function createWorkerPool(connectionString: string): pg.Pool {
  return {
    async connect() {
      const client = new pg.Client({ connectionString });
      await client.connect();
      return {
        query: client.query.bind(client),
        release: () => {
          void client.end();
        },
      } as unknown as pg.PoolClient;
    },
    async query(...args: Parameters<pg.Pool["query"]>) {
      const client = new pg.Client({ connectionString });
      await client.connect();
      try {
        return await client.query(...(args as unknown as [string, unknown[]]));
      } finally {
        await client.end();
      }
    },
    async end() {},
  } as unknown as pg.Pool;
}
