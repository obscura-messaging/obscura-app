/** A readable message for anything thrown. */
export function errorMessage(e: unknown): string {
  const message = (e as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : String(e);
}

/** The `code` of a bridge rejection, if any. */
export function errorCode(e: unknown): string | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}
