-- 0000_bootstrap.sql — 由超级用户执行一次（便携 PG 初始化后）
-- 职责分离: daka_app 拥有 schema/迁移/seed; daka_runtime 是应用连接角色, 受 RLS 约束。
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'daka_app') THEN
    CREATE ROLE daka_app LOGIN PASSWORD 'change-me-app';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'daka_runtime') THEN
    CREATE ROLE daka_runtime LOGIN PASSWORD 'change-me-runtime';
  END IF;
END $$;

SELECT 'bootstrap roles ok' AS status;
