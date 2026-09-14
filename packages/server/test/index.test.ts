import { describe, expect, it } from 'vitest';
import { SessionStore } from '../src/sessions.js';
import type { SessionRecord, SessionStorage } from '../src/storage.js';

const TIMER = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  targetNamespace="http://bpmn-flow.test" id="Defs">
  <bpmn:process id="P" isExecutable="true">
    <bpmn:startEvent id="Start" />
    <bpmn:intermediateCatchEvent id="Esperar">
      <bpmn:timerEventDefinition>
        <bpmn:timeDuration xsi:type="bpmn:tFormalExpression">PT1H</bpmn:timeDuration>
      </bpmn:timerEventDefinition>
    </bpmn:intermediateCatchEvent>
    <bpmn:endEvent id="End" />
    <bpmn:sequenceFlow id="f0" sourceRef="Start" targetRef="Esperar" />
    <bpmn:sequenceFlow id="f1" sourceRef="Esperar" targetRef="End" />
  </bpmn:process>
</bpmn:definitions>`;

const USER_TASK = TIMER.replace(
  /<bpmn:intermediateCatchEvent[\s\S]*?<\/bpmn:intermediateCatchEvent>/,
  '<bpmn:userTask id="Esperar" />',
);

/** In-memory storage that counts how often the whole set is read. */
class CountingStorage implements SessionStorage {
  readonly records = new Map<string, SessionRecord>();
  lists = 0;
  reads = 0;

  read(id: string): Promise<SessionRecord | undefined> {
    this.reads += 1;
    return Promise.resolve(this.records.get(id));
  }

  write(record: SessionRecord): Promise<void> {
    this.records.set(record.id, record);
    return Promise.resolve();
  }

  remove(id: string): Promise<boolean> {
    return Promise.resolve(this.records.delete(id));
  }

  list(): Promise<SessionRecord[]> {
    this.lists += 1;
    return Promise.resolve([...this.records.values()]);
  }
}

const HOUR = 60 * 60 * 1000;

describe('session index', () => {
  it('does not re-read storage on every tickAll', async () => {
    const storage = new CountingStorage();
    const store = new SessionStore({ storage });
    for (let i = 0; i < 5; i += 1) await store.create({ xml: TIMER });

    // One scan rebuilds the index; the ticks after it never touch storage.
    await store.tickAll(Date.now());
    const after = storage.lists;
    for (let i = 0; i < 10; i += 1) await store.tickAll(Date.now());
    expect(storage.lists).toBe(after);
  });

  it('does not re-read storage on every inbox', async () => {
    const storage = new CountingStorage();
    const store = new SessionStore({ storage });
    await store.create({ xml: USER_TASK });

    await store.inbox();
    const after = storage.lists;
    for (let i = 0; i < 10; i += 1) await store.inbox();
    expect(storage.lists).toBe(after);
  });

  it('still finds sessions a previous process left behind', async () => {
    const storage = new CountingStorage();
    const first = new SessionStore({ storage });
    const created = await first.create({ xml: USER_TASK });

    // A brand new store: one scan rebuilds the index, then it stays in memory.
    const second = new SessionStore({ storage });
    expect((await second.inbox()).map((task) => task.sessionId)).toEqual([created.id]);
    const scans = storage.lists;
    await second.inbox();
    await second.tickAll();
    expect(storage.lists).toBe(scans);
  });

  it('answers when the next timer of any session is due', async () => {
    const store = new SessionStore();
    expect(store.nextDueAt()).toBeUndefined();
    await store.create({ xml: TIMER });
    expect(store.nextDueAt()).toBeTypeOf('number');
  });

  it('forgets a deleted session', async () => {
    const storage = new CountingStorage();
    const store = new SessionStore({ storage });
    const created = await store.create({ xml: USER_TASK });
    expect(await store.list()).toHaveLength(1);
    await store.delete(created.id);
    expect(await store.list()).toHaveLength(0);
    expect(await store.inbox()).toEqual([]);
  });

  it('fires the timers that are due and leaves the others alone', async () => {
    const store = new SessionStore();
    const due = await store.create({ xml: TIMER });
    await store.create({ xml: USER_TASK });
    const advanced = await store.tickAll(Date.now() + 2 * HOUR);
    expect(advanced).toEqual([due.id]);
    expect((await store.get(due.id))?.snapshot.status).toBe('completed');
  });
});
