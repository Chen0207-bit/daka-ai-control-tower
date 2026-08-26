import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const importJobs = sqliteTable("import_jobs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  objectType: text("object_type").notNull(),
  fileName: text("file_name").notNull(),
  fileKey: text("file_key").notNull(),
  rowCount: integer("row_count").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("idx_import_jobs_workspace_created").on(table.workspaceId, table.createdAt)]);

export const importRows = sqliteTable("import_rows", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => importJobs.id),
  workspaceId: text("workspace_id").notNull(),
  sourceRow: integer("source_row").notNull(),
  recordJson: text("record_json").notNull(),
  validationStatus: text("validation_status").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("idx_import_rows_job").on(table.jobId)]);

export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  action: text("action").notNull(),
  objectType: text("object_type").notNull(),
  objectId: text("object_id").notNull(),
  detailJson: text("detail_json").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("idx_audit_workspace_created").on(table.workspaceId, table.createdAt)]);
