import type { Context } from 'hono';

/**
 * Raised when a request cannot be read as asked. The app turns it into a 400
 * with this message, so a caller's mistake never surfaces as a 500 carrying an
 * internal parser message.
 */
export class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequestError';
  }
}

/**
 * Reads a JSON object body, or `undefined` when the request carries no body at
 * all. Malformed JSON is a client error, not a server one.
 */
export async function optionalJsonBody<T>(c: Context): Promise<T | undefined> {
  const raw = (await c.req.text()).trim();
  if (raw === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadRequestError('Request body must be valid JSON.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BadRequestError('Request body must be a JSON object.');
  }
  return parsed as T;
}

/** Same as {@link optionalJsonBody}, for routes where the body is required. */
export async function jsonBody<T>(c: Context): Promise<T> {
  const body = await optionalJsonBody<T>(c);
  if (body === undefined) throw new BadRequestError('Request body must be a JSON object.');
  return body;
}

/** Reads a required string field of a body, refusing anything else. */
export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestError(`Field "${field}" is required and must be a non-empty string.`);
  }
  return value;
}
