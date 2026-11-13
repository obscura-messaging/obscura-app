/**
 * The JS diagnostic log: the console plus a ring buffer the Profile screen's debug log shows. Every
 * swallowed error goes through `logError`; lint bans empty catches.
 */

import { errorMessage } from '../domain/errors';

const buffer: string[] = [];
const MAX_LINES = 200;

export function logError(tag: string, e: unknown): void {
  const line = `[${tag}] ${errorMessage(e)}`;
  console.warn(line);
  buffer.push(`${new Date().toISOString().slice(11, 19)} JS ${line}`);
  if (buffer.length > MAX_LINES) buffer.splice(0, buffer.length - MAX_LINES);
}

export function getJsLog(): string[] {
  return buffer.slice();
}
