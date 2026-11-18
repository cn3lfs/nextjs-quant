export type QuantTeamErrorCode =
  | "INVALID_BATCH"
  | "DUPLICATE_TASK_ID"
  | "UNKNOWN_DEPENDENCY"
  | "SELF_DEPENDENCY"
  | "DUPLICATE_DEPENDENCY"
  | "DEPENDENCY_CYCLE"
  | "INVALID_IDENTIFIER"
  | "UNSAFE_PATH"
  | "RUN_NOT_FOUND"
  | "RUN_CORRUPT"
  | "RUN_EXISTS"
  | "DEFINITION_CONFLICT"
  | "LOCK_ACTIVE"
  | "LOCK_UNVERIFIABLE"
  | "TEAM_BUSY"
  | "ORPHAN_CHILD_ALIVE"
  | "ORPHAN_CHILD_UNVERIFIABLE"
  | "LOCK_CORRUPT"
  | "TASK_NOT_FOUND"
  | "TASK_ACTIVE"
  | "TASK_COMPLETE"
  | "TASK_NOT_RESUMABLE"
  | "UNKNOWN_SESSION"
  | "UPSTREAM_CHANGED"
  | "CLAUDE_EXECUTABLE_NOT_FOUND"
  | "INVALID_CLI"
  | "INVALID_INPUT_JSON";

export class QuantTeamError extends Error {
  readonly code: QuantTeamErrorCode;

  constructor(code: QuantTeamErrorCode, message: string) {
    super(message);
    this.name = "QuantTeamError";
    this.code = code;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function errorCode(error: unknown): string {
  return error instanceof QuantTeamError ? error.code : "INTERNAL_ERROR";
}
