-- 0002_fact_version.sql — FactAssertion 乐观锁版本列（Action Runtime 需要）
BEGIN;
ALTER TABLE fact_assertions ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
-- 状态迁移触发器外由 runtime 显式 version+1
INSERT INTO schema_migrations (version) VALUES ('0002_fact_version');
COMMIT;
