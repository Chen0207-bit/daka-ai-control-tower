/** Runtime 稳定错误码：API 层原样返回 code，不暴露堆栈。 */
export const RUNTIME_ERRORS = {
  VALIDATION: "ONTO-400-VALIDATION",
  UNKNOWN_TYPE: "ONTO-400-UNKNOWN-TYPE",
  NOT_FOUND: "ONTO-404-NOT-FOUND",
  VERSION_CONFLICT: "ONTO-409-VERSION-CONFLICT",
  IDEMPOTENCY_REPLAY_MISMATCH: "ONTO-409-IDEMPOTENCY-MISMATCH",
  POLICY_DENY: "ONTO-403-POLICY-DENY",
  PRECONDITION_FAILED: "ONTO-422-PRECONDITION",
  EVIDENCE_REQUIRED: "ONTO-422-EVIDENCE",
  CARDINALITY: "ONTO-422-CARDINALITY",
  UNKNOWN_HANDLER: "ONTO-422-HANDLER",
  DSL_UNSUPPORTED: "ONTO-422-DSL-VERSION",
} as const;

export type RuntimeErrorCode = (typeof RUNTIME_ERRORS)[keyof typeof RUNTIME_ERRORS];

export class RuntimeError extends Error {
  constructor(
    public readonly code: RuntimeErrorCode,
    message: string,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}
