/** Provider-independent failure; only dsh/ maps this to the native LlmError. */
export class TokenFreeError extends Error {
  constructor(message: string, readonly code: string, readonly details?: { status?: number; accepted?: false; retryAfterMs?: number }) {
    super(message)
    this.name = 'TokenFreeError'
  }
}

export class ToolArgumentsError extends TokenFreeError {
  constructor(message: string, readonly issue: { path: string; rule: string; missingProperty?: string; additionalProperty?: string }) {
    super(message, 'INVALID_TOOL_CALL')
  }
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
