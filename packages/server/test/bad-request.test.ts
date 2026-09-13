import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const app = createApp();

const post = (path: string, body: string): Promise<Response> =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });

const MALFORMED = ['/api/parse', '/api/validate', '/api/sessions'];

describe('malformed request bodies', () => {
  it.each(MALFORMED)('answers 400 on invalid JSON at %s', async (path) => {
    const res = await post(path, 'nao-json');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('Request body must be valid JSON.');
    // The internal parser message must not leak into the response.
    expect(body.error).not.toContain('Unexpected token');
  });

  it('answers 400 when a JSON body is not an object', async () => {
    const res = await post('/api/parse', '"xml"');
    expect(res.status).toBe(400);
  });

  it('answers 400 when xml is missing', async () => {
    const res = await post('/api/parse', JSON.stringify({}));
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining('xml') as unknown as string,
    });
  });

  it('answers 400 when tokenId is missing on complete', async () => {
    const res = await post('/api/sessions/does-not-matter/complete', JSON.stringify({}));
    expect(res.status).toBe(400);
  });

  it('answers 400 when name is missing on signal', async () => {
    const res = await post('/api/sessions/does-not-matter/signal', JSON.stringify({}));
    expect(res.status).toBe(400);
  });

  it('still accepts an absent body where it is optional', async () => {
    const res = await app.request('/api/sessions/unknown-id/tick', { method: 'POST' });
    // The body was fine; the session simply does not exist.
    expect(res.status).toBe(404);
  });

  it('answers 400 on a malformed optional body', async () => {
    const res = await post('/api/sessions/unknown-id/tick', 'nao-json');
    expect(res.status).toBe(400);
  });
});
