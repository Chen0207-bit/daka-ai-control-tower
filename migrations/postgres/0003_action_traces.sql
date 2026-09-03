-- 0003: ExecutionTrace 持久化（可观察本体工作台）
-- action_traces 记录每次 action 执行/演练的完整 trace（spans JSONB，写入前已脱敏）。
BEGIN;

CREATE TABLE action_traces (
  trace_id        uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  workspace_id    uuid NOT NULL,
  -- action_runs 的唯一键是复合的（tenant/workspace/idempotency），故此处不做 FK，仅存引用
  run_id          uuid,
  action_type     text NOT NULL,
  actor_id        text NOT NULL,
  actor_roles     text[] NOT NULL,
  target_type     text NOT NULL,
  target_id       text NOT NULL,
  mode            text NOT NULL CHECK (mode IN ('execute','plan')),
  status          text NOT NULL CHECK (status IN
    ('completed','replayed','planned','denied','precondition_failed','validation_failed','not_found','failed')),
  error_code      text,
  committed       boolean NOT NULL,
  duration_ms     integer NOT NULL,
  correlation_id  text NOT NULL,
  trace           jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_action_traces_tenant_created ON action_traces(tenant_id, workspace_id, created_at DESC);
CREATE INDEX idx_action_traces_correlation ON action_traces(tenant_id, workspace_id, correlation_id);
CREATE INDEX idx_action_traces_action ON action_traces(tenant_id, workspace_id, action_type);

ALTER TABLE action_traces ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON action_traces USING (
   tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
   AND workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
 ) WITH CHECK (
   tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
   AND workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid
 );

INSERT INTO schema_migrations (version) VALUES ('0003_action_traces');

COMMIT;
