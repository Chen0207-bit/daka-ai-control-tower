-- 0001_init.sql — DAKA Ontology Platform 事实层 schema (daka_app 执行)
-- 设计依据: 02_ARCHITECTURE.md §4。核心身份/时态/状态/租户/审计字段关系化, 可扩展属性进 JSONB。

BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

-- Ontology 发布登记: 每次 compile/seed 绑定一个指纹
CREATE TABLE ontology_releases (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  version       text NOT NULL,
  fingerprint   text NOT NULL,
  manifest      jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','deprecated')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text NOT NULL,
  UNIQUE (name, version),
  UNIQUE (name, fingerprint)
);

-- 对象记录: 所有 objectType 实例的统一存储
CREATE TABLE object_records (
  id                uuid NOT NULL,
  tenant_id         uuid NOT NULL,
  workspace_id      uuid NOT NULL,
  ontology_release  uuid NOT NULL REFERENCES ontology_releases(id),
  object_type       text NOT NULL,
  version           integer NOT NULL DEFAULT 1,
  data              jsonb NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  superseded_at     timestamptz,
  created_by        text NOT NULL,
  updated_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, workspace_id, object_type, id),
  CHECK (version >= 1),
  CHECK (superseded_at IS NULL OR superseded_at >= recorded_at)
);
CREATE INDEX object_records_type_idx ON object_records (tenant_id, workspace_id, object_type) WHERE superseded_at IS NULL;
CREATE INDEX object_records_status_idx ON object_records (tenant_id, workspace_id, object_type, (data->>'status')) WHERE superseded_at IS NULL;
CREATE INDEX object_records_due_at_idx ON object_records (tenant_id, workspace_id, object_type, ((data->>'dueAt'))) WHERE superseded_at IS NULL;

-- 关系记录
CREATE TABLE link_records (
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  workspace_id      uuid NOT NULL,
  ontology_release  uuid NOT NULL REFERENCES ontology_releases(id),
  link_type         text NOT NULL,
  from_type         text NOT NULL,
  from_id           uuid NOT NULL,
  to_type           text NOT NULL,
  to_id             uuid NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  superseded_at     timestamptz,
  created_by        text NOT NULL,
  PRIMARY KEY (tenant_id, workspace_id, link_type, from_id, to_id),
  UNIQUE (tenant_id, workspace_id, id)
);
CREATE INDEX link_records_from_idx ON link_records (tenant_id, workspace_id, from_type, from_id) WHERE superseded_at IS NULL;
CREATE INDEX link_records_to_idx ON link_records (tenant_id, workspace_id, to_type, to_id) WHERE superseded_at IS NULL;

-- 事实断言: 双时态 + 状态机
CREATE TABLE fact_assertions (
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL,
  workspace_id        uuid NOT NULL,
  ontology_release    uuid NOT NULL REFERENCES ontology_releases(id),
  subject_type        text NOT NULL,
  subject_id          uuid NOT NULL,
  predicate           text NOT NULL,
  object_value        jsonb NOT NULL,
  status              text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','verified','rejected','superseded')),
  confidence          numeric,
  evidence_anchor_id  uuid,
  valid_from          timestamptz,
  valid_to            timestamptz,
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  superseded_at       timestamptz,
  asserted_by         text NOT NULL,
  supersedes_fact_id  uuid,
  review_comment      text,
  reviewed_by         text,
  reviewed_at         timestamptz,
  PRIMARY KEY (tenant_id, workspace_id, id)
);
CREATE INDEX fact_subject_idx ON fact_assertions (tenant_id, workspace_id, subject_type, subject_id, status);
CREATE INDEX fact_status_idx ON fact_assertions (tenant_id, workspace_id, status) WHERE status = 'proposed';
-- 证据策略: verified 必须有证据锚点或显式人工声明 (review_comment 非空)
ALTER TABLE fact_assertions ADD CONSTRAINT fact_verified_needs_evidence
  CHECK (status <> 'verified' OR evidence_anchor_id IS NOT NULL OR review_comment IS NOT NULL);

-- 原始文档(不可变版本)
CREATE TABLE documents (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  workspace_id  uuid NOT NULL,
  uri           text NOT NULL,
  sha256        text NOT NULL,
  media_type    text NOT NULL,
  version       text NOT NULL,
  captured_at   timestamptz NOT NULL,
  recorded_by   text NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, sha256, version)
);

-- 证据锚点
CREATE TABLE evidence_anchors (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  workspace_id  uuid NOT NULL,
  document_id   uuid NOT NULL,
  locator_type  text NOT NULL,
  locator       jsonb NOT NULL,
  excerpt_hash  text,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, workspace_id, id)
);

-- Action 运行记录(幂等)
CREATE TABLE action_runs (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  workspace_id     uuid NOT NULL,
  idempotency_key  text NOT NULL,
  action_type      text NOT NULL,
  actor_id         text NOT NULL,
  actor_roles      text[] NOT NULL,
  target_type      text NOT NULL,
  target_id        uuid NOT NULL,
  input            jsonb NOT NULL,
  expected_version integer,
  status           text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','rejected')),
  result           jsonb,
  error_code       text,
  correlation_id   text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, idempotency_key)
);

-- 审计事件(只追加)
CREATE TABLE audit_events (
  seq            bigint GENERATED ALWAYS AS IDENTITY,
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  workspace_id   uuid NOT NULL,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  actor_id       text NOT NULL,
  action         text NOT NULL,
  entity_type    text NOT NULL,
  entity_id      text NOT NULL,
  detail         jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id text NOT NULL,
  PRIMARY KEY (tenant_id, seq)
);

-- Outbox(同事务提交, 异步发布)
CREATE TABLE outbox_events (
  seq            bigint GENERATED ALWAYS AS IDENTITY,
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  workspace_id   uuid NOT NULL,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  event_type     text NOT NULL,
  payload        jsonb NOT NULL,
  published_at   timestamptz,
  correlation_id text NOT NULL,
  PRIMARY KEY (tenant_id, seq)
);

-- 投影检查点
CREATE TABLE projection_checkpoints (
  projection_id   text NOT NULL,
  tenant_id       uuid NOT NULL,
  workspace_id    uuid NOT NULL,
  last_event_seq  bigint NOT NULL DEFAULT 0,
  rebuilt_at      timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (projection_id, tenant_id, workspace_id)
);

-- 同步任务/记录/错误
CREATE TABLE ingest_jobs (
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  workspace_id   uuid NOT NULL,
  connector_id   text NOT NULL,
  pack_fingerprint text,
  batch_id       text NOT NULL,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','validated','applied','failed','partial')),
  stats          jsonb NOT NULL DEFAULT '{}'::jsonb,
  error          text,
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,
  PRIMARY KEY (tenant_id, workspace_id, id),
  UNIQUE (tenant_id, workspace_id, connector_id, batch_id)
);

CREATE TABLE ingest_records (
  job_id        uuid NOT NULL,
  tenant_id     uuid NOT NULL,
  workspace_id  uuid NOT NULL,
  record_key    text NOT NULL,
  record_type   text NOT NULL,
  status        text NOT NULL CHECK (status IN ('applied','skipped','failed')),
  error         jsonb,
  applied_at    timestamptz,
  PRIMARY KEY (tenant_id, workspace_id, job_id, record_key)
);

-- 角色绑定
CREATE TABLE role_bindings (
  tenant_id     uuid NOT NULL,
  workspace_id  uuid NOT NULL,
  actor_id      text NOT NULL,
  role          text NOT NULL,
  granted_by    text NOT NULL,
  granted_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, workspace_id, actor_id, role)
);

-- ============ RLS: 数据库底线隔离 ============
-- daka_runtime 连接时必须 SET app.tenant_id / app.workspace_id, 否则无行可见。
ALTER TABLE object_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE link_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE fact_assertions ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE evidence_anchors ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE projection_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingest_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingest_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_bindings ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'object_records','link_records','fact_assertions','documents','evidence_anchors',
    'action_runs','audit_events','outbox_events','projection_checkpoints',
    'ingest_jobs','ingest_records','role_bindings'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (
         tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid
         AND workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid
       ) WITH CHECK (
         tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid
         AND workspace_id = nullif(current_setting(''app.workspace_id'', true), '''')::uuid
       )', t);
  END LOOP;
END $$;

-- 授权: runtime 角色可 DML, 无 DDL, 受 RLS 约束
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO daka_runtime;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO daka_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO daka_runtime;

INSERT INTO schema_migrations (version) VALUES ('0001_init');

COMMIT;
