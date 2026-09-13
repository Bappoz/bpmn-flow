import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { parseBpmn, validateBpmn, type TaskFilter, type WaitReason } from '@bpmn-flow/core';
import { Hono } from 'hono';
import { BadRequestError, jsonBody, optionalJsonBody, requireString } from './http.js';
import { SampleProvider } from './samples.js';
import { SessionStore, type CreateSessionInput, type SessionStoreOptions } from './sessions.js';
import { FileSessionStorage } from './storage.js';

export interface AppOptions {
  /** Directory of `.bpmn` files exposed under `/api/samples`. */
  samplesDir?: string;
  /** Directory of built static assets (the playground) served at `/`. */
  staticDir?: string;
  /**
   * Directory where running executions are persisted, one JSON per session.
   * Without it sessions live in memory only and are lost on restart.
   */
  dataDir?: string;
  /** Session registry to use. Built from `dataDir` and `handlers` when omitted. */
  sessions?: SessionStore;
  /**
   * Automation for every session: task handlers by node id, element kind or
   * `*`. Without them, automatic activities pass through.
   */
  handlers?: SessionStoreOptions['handlers'];
  /**
   * How the expressions of a posted diagram are evaluated. Left alone, they go
   * through the safe evaluator: the API accepts XML from anyone, so a flow
   * condition must not be able to run code in this process.
   */
  expressions?: SessionStoreOptions['expressions'];
}

/** Storage and automation for the default session store. */
export function storeOptionsFrom(options: AppOptions): SessionStoreOptions {
  return {
    ...(options.dataDir ? { storage: new FileSessionStorage(options.dataDir) } : {}),
    ...(options.handlers ? { handlers: options.handlers } : {}),
    ...(options.expressions ? { expressions: options.expressions } : {}),
  };
}

/** Builds a task filter from `?role=&reason=&nodeId=`. */
function taskFilter(query: Record<string, string>): TaskFilter {
  return {
    ...(query.role ? { role: query.role } : {}),
    ...(query.nodeId ? { nodeId: query.nodeId } : {}),
    ...(query.reason ? { reason: query.reason as WaitReason } : {}),
  };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.bpmn': 'application/xml; charset=utf-8',
};

/**
 * Builds the HTTP application: a REST API over @bpmn-flow/core plus optional
 * sample and static-asset serving. Returned as a Hono app so it can be mounted
 * into a larger server or started standalone via {@link startServer}.
 */
export function createApp(options: AppOptions = {}): Hono {
  const app = new Hono();
  const sessions = options.sessions ?? new SessionStore(storeOptionsFrom(options));
  const samples = options.samplesDir ? new SampleProvider(options.samplesDir) : undefined;

  app.get('/api/health', (c) => c.json({ status: 'ok' }));

  app.post('/api/parse', async (c) => {
    const { xml } = await jsonBody<{ xml?: unknown }>(c);
    return c.json(await parseBpmn(requireString(xml, 'xml')));
  });

  app.post('/api/validate', async (c) => {
    const { xml } = await jsonBody<{ xml?: unknown }>(c);
    const { valid, issues } = await validateBpmn(requireString(xml, 'xml'));
    return c.json({ valid, issues });
  });

  app.post('/api/sessions', async (c) => {
    const body = await jsonBody<CreateSessionInput>(c);
    requireString(body.xml, 'xml');
    return c.json(await sessions.create(body), 201);
  });

  app.get('/api/sessions', async (c) => c.json(await sessions.list()));

  app.get('/api/sessions/:id', async (c) => {
    const session = await sessions.get(c.req.param('id'));
    return session ? c.json(session) : c.json({ error: 'Session not found' }, 404);
  });

  app.post('/api/sessions/:id/complete', async (c) => {
    const { tokenId, output } = await jsonBody<{
      tokenId?: unknown;
      output?: Record<string, unknown>;
    }>(c);
    return c.json(
      await sessions.complete(c.req.param('id'), requireString(tokenId, 'tokenId'), output),
    );
  });

  app.get('/api/tasks', async (c) => c.json(await sessions.inbox(taskFilter(c.req.query()))));

  app.get('/api/sessions/:id/tasks', async (c) =>
    c.json(await sessions.tasks(c.req.param('id'), taskFilter(c.req.query()))),
  );

  app.get('/api/sessions/:id/incidents', async (c) =>
    c.json(await sessions.incidents(c.req.param('id'))),
  );

  app.post('/api/sessions/:id/incidents/:tokenId/retry', async (c) =>
    c.json(await sessions.retry(c.req.param('id'), c.req.param('tokenId'))),
  );

  app.post('/api/sessions/:id/incidents/:tokenId/resolve', async (c) => {
    const body = await optionalJsonBody<{ output?: Record<string, unknown> }>(c);
    return c.json(
      await sessions.resolveIncident(c.req.param('id'), c.req.param('tokenId'), body?.output),
    );
  });

  app.post('/api/sessions/:id/tick', async (c) => {
    const body = await optionalJsonBody<{ now?: number }>(c);
    return c.json(await sessions.tick(c.req.param('id'), body?.now));
  });

  app.post('/api/sessions/:id/signal', async (c) => {
    const { name, output } = await jsonBody<{
      name?: unknown;
      output?: Record<string, unknown>;
    }>(c);
    return c.json(await sessions.signal(c.req.param('id'), requireString(name, 'name'), output));
  });

  app.delete('/api/sessions/:id', async (c) =>
    c.json({ deleted: await sessions.delete(c.req.param('id')) }),
  );

  if (samples) {
    app.get('/api/samples', async (c) => c.json(await samples.list()));
    app.get('/api/samples/:name', async (c) => {
      const xml = await samples.read(c.req.param('name'));
      return xml
        ? c.body(xml, 200, { 'content-type': MIME['.bpmn']! })
        : c.json({ error: 'Sample not found' }, 404);
    });
    app.post('/api/samples', async (c) => {
      const body = await jsonBody<{ name?: unknown; xml?: unknown }>(c);
      const name = requireString(body.name, 'name');
      const xml = requireString(body.xml, 'xml');
      const validation = await validateBpmn(xml);
      if (!validation.valid) {
        return c.json({ error: 'Invalid BPMN', issues: validation.issues }, 400);
      }
      const stored = await samples.write(name, xml);
      return c.json({ name: stored, issues: validation.issues }, 201);
    });
  }

  app.onError((err, c) => {
    if (err instanceof BadRequestError) return c.json({ error: err.message }, 400);
    if (err.name === 'SessionNotFoundError') return c.json({ error: err.message }, 404);
    if (
      err.name === 'BpmnParseError' ||
      err.name === 'BpmnValidationError' ||
      err.name === 'InvalidSampleNameError'
    ) {
      return c.json({ error: err.message }, 400);
    }
    return c.json({ error: err.message }, 500);
  });

  if (options.staticDir) registerStatic(app, options.staticDir);

  return app;
}

function registerStatic(app: Hono, dir: string): void {
  app.get('*', async (c) => {
    const pathname = new URL(c.req.url).pathname;
    const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const safe = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, '');
    const primary = join(dir, safe);

    let data = await readFile(primary).catch(() => null);
    let ext = extname(primary);
    if (!data) {
      // SPA fallback: serve index.html for unknown non-file routes.
      data = await readFile(join(dir, 'index.html')).catch(() => null);
      ext = '.html';
    }
    if (!data) return c.notFound();
    return new Response(data, {
      status: 200,
      headers: { 'content-type': MIME[ext] ?? 'application/octet-stream' },
    });
  });
}
