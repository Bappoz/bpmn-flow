import { describe, expect, it } from 'vitest';
import { SessionStore } from '../src/sessions.js';
import type { SessionRecord, SessionStorage } from '../src/storage.js';

const USER_TASK = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  targetNamespace="http://bpmn-flow.test" id="Defs">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:userTask id="Aprovar" />
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Aprovar" />
    <bpmn:sequenceFlow id="f1" sourceRef="Aprovar" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

const STRAIGHT_THROUGH = USER_TASK.replace('bpmn:userTask', 'bpmn:task').replace(
  '</bpmn:task>',
  '',
);

class MemoryStorage implements SessionStorage {
  readonly records = new Map<string, SessionRecord>();
  read = (id: string): Promise<SessionRecord | undefined> => Promise.resolve(this.records.get(id));
  write = (record: SessionRecord): Promise<void> => {
    this.records.set(record.id, record);
    return Promise.resolve();
  };
  remove = (id: string): Promise<boolean> => Promise.resolve(this.records.delete(id));
  list = (): Promise<SessionRecord[]> => Promise.resolve([...this.records.values()]);
}

describe('session cache', () => {
  it('keeps at most the configured number of engines in memory', async () => {
    const store = new SessionStore({ storage: new MemoryStorage(), maxCachedSessions: 3 });
    for (let i = 0; i < 10; i += 1) await store.create({ xml: USER_TASK });
    expect(store.cachedSessions()).toBeLessThanOrEqual(3);
  });

  it('rebuilds an evicted session from storage, exactly where it was', async () => {
    const store = new SessionStore({ storage: new MemoryStorage(), maxCachedSessions: 2 });
    const first = await store.create({ xml: USER_TASK });
    for (let i = 0; i < 5; i += 1) await store.create({ xml: USER_TASK });

    const reloaded = await store.get(first.id);
    expect(reloaded?.snapshot.status).toBe('waiting');
    const task = (await store.tasks(first.id))[0]!;
    expect((await store.complete(first.id, task.tokenId)).snapshot.status).toBe('completed');
  });

  it('drops a finished session from memory as soon as it is persisted', async () => {
    const store = new SessionStore({ storage: new MemoryStorage() });
    const created = await store.create({ xml: STRAIGHT_THROUGH });
    expect(created.snapshot.status).toBe('completed');
    expect(store.cachedSessions()).toBe(0);
    // Still readable: it was written through before being dropped.
    expect((await store.get(created.id))?.snapshot.status).toBe('completed');
  });

  it('never evicts what it cannot rebuild', async () => {
    const store = new SessionStore({ maxCachedSessions: 2 });
    for (let i = 0; i < 5; i += 1) await store.create({ xml: USER_TASK });
    // Without storage the cache is the only copy of these executions.
    expect(store.cachedSessions()).toBe(5);
  });
});
