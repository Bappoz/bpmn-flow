import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { SessionStore } from '../src/sessions.js';

const APPROVAL = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  targetNamespace="http://bpmn-flow.test" id="Defs">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:laneSet id="Lanes">
      <bpmn:lane id="L1" name="Gerencia">
        <bpmn:flowNodeRef>Aprovar</bpmn:flowNodeRef>
      </bpmn:lane>
    </bpmn:laneSet>
    <bpmn:startEvent id="Start" />
    <bpmn:userTask id="Aprovar" name="Aprovar pedido" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Aprovar" />
    <bpmn:sequenceFlow id="f1" sourceRef="Aprovar" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

const CATCH_EVENT = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  targetNamespace="http://bpmn-flow.test" id="Defs">
  <bpmn:signal id="Sig" name="liberado" />
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:intermediateCatchEvent id="Esperar">
      <bpmn:signalEventDefinition signalRef="Sig" />
    </bpmn:intermediateCatchEvent>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Esperar" />
    <bpmn:sequenceFlow id="f1" sourceRef="Esperar" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

const FAILING = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  targetNamespace="http://bpmn-flow.test" id="Defs">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:serviceTask id="Cobrar" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Cobrar" />
    <bpmn:sequenceFlow id="f1" sourceRef="Cobrar" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

function client(app: ReturnType<typeof createApp>) {
  return {
    get: (path: string): Promise<Response> => app.request(path),
    post: (path: string, body?: unknown): Promise<Response> =>
      app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    del: (path: string): Promise<Response> => app.request(path, { method: 'DELETE' }),
  };
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

interface SessionBody {
  id: string;
  snapshot: { status: string; completedNodes: string[]; variables: Record<string, unknown> };
}

describe('API routes', () => {
  it('reports health', async () => {
    const res = await client(createApp()).get('/api/health');
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ status: 'ok' });
  });

  it('parses a diagram into the normalized model', async () => {
    const res = await client(createApp()).post('/api/parse', { xml: APPROVAL });
    expect(res.status).toBe(200);
    const model = await json<{ processes: { id: string }[] }>(res);
    expect(model.processes[0]?.id).toBe('P');
  });

  it('answers 400 with the parser message on invalid XML', async () => {
    const res = await client(createApp()).post('/api/parse', { xml: '<not-bpmn>' });
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toMatch(/BPMN/);
  });

  it('validates a diagram without executing it', async () => {
    const res = await client(createApp()).post('/api/validate', { xml: APPROVAL });
    expect(await json(res)).toEqual({ valid: true, issues: [] });
  });

  it('creates a session with 201 and lists it', async () => {
    const api = client(createApp());
    const created = await api.post('/api/sessions', { xml: APPROVAL });
    expect(created.status).toBe(201);
    const session = await json<SessionBody>(created);
    expect(session.snapshot.status).toBe('waiting');

    const list = await json<{ id: string }[]>(await api.get('/api/sessions'));
    expect(list.map((entry) => entry.id)).toEqual([session.id]);
  });

  it('answers 404 for a session that does not exist', async () => {
    const api = client(createApp());
    expect((await api.get('/api/sessions/nao-existe')).status).toBe(404);
    expect((await api.post('/api/sessions/nao-existe/complete', { tokenId: 't1' })).status).toBe(
      404,
    );
    expect((await api.get('/api/sessions/nao-existe/tasks')).status).toBe(404);
    expect((await api.post('/api/sessions/nao-existe/signal', { name: 'x' })).status).toBe(404);
  });

  it('completes a task and finishes the execution', async () => {
    const api = client(createApp());
    const session = await json<SessionBody>(await api.post('/api/sessions', { xml: APPROVAL }));
    const tasks = await json<{ tokenId: string }[]>(
      await api.get(`/api/sessions/${session.id}/tasks`),
    );
    expect(tasks).toHaveLength(1);

    const done = await api.post(`/api/sessions/${session.id}/complete`, {
      tokenId: tasks[0]!.tokenId,
      output: { aprovado: true },
    });
    const after = await json<SessionBody>(done);
    expect(after.snapshot.status).toBe('completed');
    expect(after.snapshot.variables).toMatchObject({ aprovado: true });
  });

  it('filters the inbox by role, reason and node', async () => {
    const api = client(createApp());
    await api.post('/api/sessions', { xml: APPROVAL });
    await api.post('/api/sessions', { xml: CATCH_EVENT });

    const all = await json<unknown[]>(await api.get('/api/tasks'));
    expect(all).toHaveLength(2);

    const byRole = await json<{ nodeId: string }[]>(await api.get('/api/tasks?role=Gerencia'));
    expect(byRole.map((task) => task.nodeId)).toEqual(['Aprovar']);

    const byReason = await json<{ nodeId: string }[]>(
      await api.get('/api/tasks?reason=catchEvent'),
    );
    expect(byReason.map((task) => task.nodeId)).toEqual(['Esperar']);

    const byNode = await json<{ nodeId: string }[]>(await api.get('/api/tasks?nodeId=Aprovar'));
    expect(byNode.map((task) => task.nodeId)).toEqual(['Aprovar']);

    const none = await json<unknown[]>(await api.get('/api/tasks?role=Financeiro'));
    expect(none).toEqual([]);
  });

  it('carries the session id on every inbox entry', async () => {
    const api = client(createApp());
    const session = await json<SessionBody>(await api.post('/api/sessions', { xml: APPROVAL }));
    const inbox = await json<{ sessionId: string }[]>(await api.get('/api/tasks'));
    expect(inbox[0]?.sessionId).toBe(session.id);
  });

  it('delivers a signal to a waiting catch event', async () => {
    const api = client(createApp());
    const session = await json<SessionBody>(await api.post('/api/sessions', { xml: CATCH_EVENT }));
    const after = await api.post(`/api/sessions/${session.id}/signal`, { name: 'liberado' });
    expect(after.status).toBe(200);
    expect((await json<SessionBody>(after)).snapshot.status).toBe('completed');
  });

  it('answers 500 with the engine message when a signal catches nothing', async () => {
    const api = client(createApp());
    const session = await json<SessionBody>(await api.post('/api/sessions', { xml: CATCH_EVENT }));
    const res = await api.post(`/api/sessions/${session.id}/signal`, { name: 'inexistente' });
    expect(res.status).toBe(500);
    expect((await json<{ error: string }>(res)).error).toMatch(/No catchable event/);
  });

  it('ticks a session without a body', async () => {
    const api = client(createApp());
    const session = await json<SessionBody>(await api.post('/api/sessions', { xml: CATCH_EVENT }));
    const res = await api.post(`/api/sessions/${session.id}/tick`);
    expect(res.status).toBe(200);
    expect((await json<SessionBody>(res)).snapshot.status).toBe('waiting');
  });

  it('lists, retries and resolves an incident', async () => {
    let fail = true;
    const sessions = new SessionStore({
      handlers: {
        Cobrar: () => {
          if (fail) throw new Error('gateway fora do ar');
          return { pago: true };
        },
      },
    });
    const api = client(createApp({ sessions }));
    const session = await json<SessionBody>(
      await api.post('/api/sessions', { xml: FAILING, onHandlerError: 'incident' }),
    );

    const incidents = await json<{ tokenId: string; message: string }[]>(
      await api.get(`/api/sessions/${session.id}/incidents`),
    );
    expect(incidents[0]?.message).toContain('gateway fora do ar');

    fail = false;
    const retried = await api.post(
      `/api/sessions/${session.id}/incidents/${incidents[0]!.tokenId}/retry`,
    );
    expect((await json<SessionBody>(retried)).snapshot.status).toBe('completed');
  });

  it('resolves an incident with the output a human decided on', async () => {
    const sessions = new SessionStore({
      handlers: {
        Cobrar: () => {
          throw new Error('sempre falha');
        },
      },
    });
    const api = client(createApp({ sessions }));
    const session = await json<SessionBody>(
      await api.post('/api/sessions', { xml: FAILING, onHandlerError: 'incident' }),
    );
    const incidents = await json<{ tokenId: string }[]>(
      await api.get(`/api/sessions/${session.id}/incidents`),
    );
    const resolved = await api.post(
      `/api/sessions/${session.id}/incidents/${incidents[0]!.tokenId}/resolve`,
      { output: { pago: 'manual' } },
    );
    const after = await json<SessionBody>(resolved);
    expect(after.snapshot.status).toBe('completed');
    expect(after.snapshot.variables).toMatchObject({ pago: 'manual' });
  });

  it('deletes a session', async () => {
    const api = client(createApp());
    const session = await json<SessionBody>(await api.post('/api/sessions', { xml: APPROVAL }));
    expect(await json(await api.del(`/api/sessions/${session.id}`))).toEqual({ deleted: true });
    expect(await json(await api.del(`/api/sessions/${session.id}`))).toEqual({ deleted: false });
    expect((await api.get(`/api/sessions/${session.id}`)).status).toBe(404);
  });

  it('has no sample routes without a samples directory', async () => {
    expect((await client(createApp()).get('/api/samples')).status).toBe(404);
  });
});

describe('sample routes', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bpmn-flow-samples-'));
    await writeFile(join(dir, 'aprovacao.bpmn'), APPROVAL, 'utf8');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lists and reads a sample', async () => {
    const api = client(createApp({ samplesDir: dir }));
    expect(await json(await api.get('/api/samples'))).toEqual([
      { name: 'aprovacao', file: 'aprovacao.bpmn' },
    ]);

    const res = await api.get('/api/samples/aprovacao');
    expect(res.headers.get('content-type')).toContain('application/xml');
    expect(await res.text()).toContain('<bpmn:process');
  });

  it('answers 404 for a sample that is not there', async () => {
    const res = await client(createApp({ samplesDir: dir })).get('/api/samples/inexistente');
    expect(res.status).toBe(404);
  });

  it('stores a valid sample and refuses an invalid diagram', async () => {
    const api = client(createApp({ samplesDir: dir }));
    const stored = await api.post('/api/samples', { name: 'novo', xml: APPROVAL });
    expect(stored.status).toBe(201);
    expect(await json(stored)).toEqual({ name: 'novo', issues: [] });

    const refused = await api.post('/api/samples', {
      name: 'quebrado',
      xml: '<?xml version="1.0"?><bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"><bpmn:process id="X" isExecutable="true"><bpmn:task id="A" /></bpmn:process></bpmn:definitions>',
    });
    expect(refused.status).toBe(400);
    expect((await json<{ error: string }>(refused)).error).toBe('Invalid BPMN');
  });

  it('answers 400 for a name that could escape the directory', async () => {
    const res = await client(createApp({ samplesDir: dir })).post('/api/samples', {
      name: '../fuga',
      xml: APPROVAL,
    });
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toMatch(/Invalid sample name/);
  });
});

describe('static assets', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bpmn-flow-static-'));
    await writeFile(join(dir, 'index.html'), '<h1>playground</h1>', 'utf8');
    await writeFile(join(dir, 'app.js'), 'export const x = 1;', 'utf8');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('serves the index at the root, with its media type', async () => {
    const res = await client(createApp({ staticDir: dir })).get('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('playground');
  });

  it('serves an asset with its own media type', async () => {
    const res = await client(createApp({ staticDir: dir })).get('/app.js');
    expect(res.headers.get('content-type')).toContain('text/javascript');
  });

  it('falls back to the index for an unknown route', async () => {
    const res = await client(createApp({ staticDir: dir })).get('/rota/do/spa');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('playground');
  });

  it('does not serve anything above the static directory', async () => {
    const res = await client(createApp({ staticDir: dir })).get('/../../etc/passwd');
    // Whatever the traversal resolves to, it is the SPA index, not a file.
    expect(await res.text()).toContain('playground');
  });

  it('leaves the API alone', async () => {
    const res = await client(createApp({ staticDir: dir })).get('/api/health');
    expect(await json(res)).toEqual({ status: 'ok' });
  });
});
