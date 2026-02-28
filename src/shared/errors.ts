export type BotErrorCode =
  | 'OCR_FAILED'
  | 'OCR_TIMEOUT'
  | 'MISSING_CRITICAL_FIELDS'
  | 'INVALID_IMAGE'
  | 'USER_NOT_FOUND'
  | 'PROVIDER_ERROR'
  | 'DUPLICATE_MESSAGE'
  | 'DB_ERROR';

export class BotError extends Error {
  constructor(
    public readonly code: BotErrorCode,
    public readonly userMessage: string,
    cause?: unknown,
  ) {
    super(userMessage, { cause: cause instanceof Error ? cause : undefined });
    this.name = 'BotError';
  }
}

export function isBotError(err: unknown): err is BotError {
  return err instanceof BotError;
}
