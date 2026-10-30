/**
 * The JS diagnostic log: the console plus a ring buffer the Profile screen's debug log shows. Every
 * swallowed error goes through `logError`; lint bans empty catches.
 */

const buffer: string[] = [];
const MAX_LINES = 200;

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

export function logError(tag: string, e: unknown): void {
  const line = `[${tag}] ${errorMessage(e)}`;
  console.warn(line);
  buffer.push(`${new Date().toISOString().slice(11, 19)} JS ${line}`);
  if (buffer.length > MAX_LINES) buffer.splice(0, buffer.length - MAX_LINES);
}

export function getJsLog(): string[] {
  return buffer.slice();
}
