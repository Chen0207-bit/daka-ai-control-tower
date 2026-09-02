import { randomUUID } from "node:crypto";

/** 每次请求/命令的执行上下文；所有写操作携带。 */
export interface ActorContext {
  tenantId: string;
  workspaceId: string;
  actorId: string;
  roles: string[];
  correlationId: string;
}

export function makeContext(input: Omit<ActorContext, "correlationId"> & { correlationId?: string }): ActorContext {
  return { ...input, correlationId: input.correlationId ?? randomUUID() };
}
