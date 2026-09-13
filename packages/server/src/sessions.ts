import { randomUUID } from 'node:crypto';
import {
  executableProcess,
  parseBpmn,
  WorkflowEngine,
  type EngineMode,
  type EngineOptions,
  type EngineState,
  type ExpressionMode,
  type ExecutionSnapshot,
  type ExecutionStatus,
  type IncidentState,
  type PendingTask,
  type ProcessModel,
  type TaskFilter,
  type TaskHandler,
} from '@bpmn-flow/core';
import type { SessionStorage } from './storage.js';

/**
 * Body of a create request. Note what is *not* here: how expressions are
 * evaluated. That is the host's call ({@link SessionStoreOptions.expressions}),
 * never the caller's, so posting a diagram cannot buy code execution.
 */
export interface CreateSessionInput {
  xml: string;
  mode?: EngineMode;
  variables?: Record<string, unknown>;
  /** `incident` holds a failing activity instead of failing the execution. */
  onHandlerError?: EngineOptions['onHandlerError'];
  /** Automatic retries before an incident is opened. */
  retry?: EngineOptions['retry'];
}

export interface Session {
  id: string;
  xml: string;
  snapshot: ExecutionSnapshot;
}

/** A pending task plus the session it belongs to. */
export interface InboxTask extends PendingTask {
  sessionId: string;
}

/** Lightweight listing entry: no diagram XML, no full history. */
export interface SessionSummary {
  id: string;
  status: ExecutionStatus;
  /** Tokens currently parked on a wait state. */
  waiting: number;
  updatedAt?: string;
}

interface LiveSession extends Session {
  engine: WorkflowEngine;
}

/**
 * What the store needs to know about a session without rebuilding its engine:
 * whether somebody is waiting on it and when it next moves on its own.
 */
interface IndexEntry {
  status: ExecutionStatus;
  /** Tokens parked on a wait state. */
  waiting: number;
  /** Earliest timer or scheduled retry, when the session has one. */
  dueAt?: number;
  updatedAt?: string;
}

/** Reads the index entry out of a stored state, without an engine. */
function indexFromState(state: EngineState, updatedAt?: string): IndexEntry {
  const retries = (state.incidents ?? [])
    .map((incident) => incident.retryAt)
    .filter((at): at is number => at !== undefined);
  const due = [...state.timers.map((timer) => timer.dueAt), ...retries];
  return {
    status: state.status,
    waiting: state.tokens.filter((token) => token.waiting !== undefined).length,
    ...(due.length > 0 ? { dueAt: Math.min(...due) } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

export interface SessionStoreOptions {
  /** Where sessions are persisted. In-memory only when omitted. */
  storage?: SessionStorage;
  /**
   * Automation registered on every engine this store creates or restores,
   * keyed by node id, element kind or the `*` wildcard. Without it, automatic
   * activities simply pass through.
   */
  handlers?: Record<string, TaskHandler>;
  /**
   * How the diagram's expressions are evaluated. `safe` (the default) parses
   * and interprets them without ever compiling code, which is what makes
   * running a diagram from an unknown source acceptable. Switch to
   * `javascript` only when every XML this store executes is authored by you.
   */
  expressions?: ExpressionMode;
}

/**
 * Registry of running executions. Each session owns a {@link WorkflowEngine}
 * that can be driven over HTTP (complete a user task or deliver a signal).
 *
 * Engines are cached in memory. When a {@link SessionStorage} is provided,
 * every change is written through it and a session missing from the cache is
 * rebuilt from its stored state — so a restarted server picks executions up
 * exactly where they stopped.
 *
 * Every operation that touches an engine is queued per session, so concurrent
 * requests on the same execution run one after the other instead of sharing
 * the engine's ready queue. Different sessions never wait on each other.
 */
export class SessionStore {
  private readonly cache = new Map<string, LiveSession>();
  /** Tail of the pending work queued for each session, by session id. */
  private readonly queues = new Map<string, Promise<void>>();
  /**
   * Status, wait count and next due date of every known session. Kept in
   * memory so the periodic tick is a scan of this map instead of a full read
   * of the session directory, which was O(N) of disk I/O per second.
   */
  private readonly index = new Map<string, IndexEntry>();
  private indexed: Promise<void> | undefined;
  private readonly storage: SessionStorage | undefined;
  private readonly handlers: Record<string, TaskHandler>;
  private readonly expressions: ExpressionMode;

  constructor(options: SessionStoreOptions = {}) {
    this.storage = options.storage;
    this.handlers = options.handlers ?? {};
    this.expressions = options.expressions ?? 'safe';
  }

  /**
   * Runs `task` after everything already queued for this session.
   *
   * The engine's contract is that tokens are processed one at a time, which
   * two concurrent requests entering `drain()` would break: they would share
   * the ready queue and answer each other's execution. Serializing per session
   * keeps that invariant without blocking unrelated sessions.
   */
  private queued<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(id, tail);
    void tail.then(() => {
      // Only the last one out turns the light off.
      if (this.queues.get(id) === tail) this.queues.delete(id);
    });
    return run;
  }

  /**
   * Builds the index once, from whatever the storage already holds. A restart
   * pays one full scan; everything after that is served from memory.
   */
  private ensureIndex(): Promise<void> {
    this.indexed ??= (async () => {
      for (const record of (await this.storage?.list()) ?? []) {
        this.index.set(record.id, indexFromState(record.state, record.updatedAt));
      }
    })();
    return this.indexed;
  }

  /** Applies the store's automation to a freshly built engine. */
  private wire(engine: WorkflowEngine): WorkflowEngine {
    for (const [selector, handler] of Object.entries(this.handlers)) {
      engine.registerHandler(selector, handler);
    }
    return engine;
  }

  async create(input: CreateSessionInput): Promise<Session> {
    const { process, processes } = await readProcesses(input.xml);
    const engine = this.wire(
      new WorkflowEngine(process, {
        processes,
        expressions: this.expressions,
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.variables ? { variables: input.variables } : {}),
        ...(input.onHandlerError ? { onHandlerError: input.onHandlerError } : {}),
        ...(input.retry ? { retry: input.retry } : {}),
      }),
    );
    const snapshot = await engine.start();
    const session: LiveSession = { id: randomUUID(), xml: input.xml, snapshot, engine };
    this.cache.set(session.id, session);
    await this.persist(session);
    return view(session);
  }

  async get(id: string): Promise<Session | undefined> {
    return this.queued(id, async () => {
      const session = await this.load(id);
      return session ? view(session) : undefined;
    });
  }

  async complete(id: string, tokenId: string, output?: Record<string, unknown>): Promise<Session> {
    return this.queued(id, async () => {
      const session = await this.require(id);
      session.snapshot = await session.engine.completeTask(tokenId, output);
      await this.persist(session);
      return view(session);
    });
  }

  /** Work waiting on a person in one session. */
  async tasks(id: string, filter?: TaskFilter): Promise<PendingTask[]> {
    return this.queued(id, async () => {
      const session = await this.require(id);
      return session.engine.tasks(filter);
    });
  }

  /**
   * Work waiting on a person across every session — the inbox. Sessions that
   * already finished are skipped without rebuilding their engine.
   */
  async inbox(filter?: TaskFilter): Promise<InboxTask[]> {
    const ids = await this.waitingIds();

    const inbox: InboxTask[] = [];
    for (const id of ids) {
      const tasks = await this.queued(id, async () => {
        const session = await this.load(id);
        return session?.engine.tasks(filter) ?? [];
      });
      for (const task of tasks) inbox.push({ sessionId: id, ...task });
    }
    return inbox;
  }

  /** Activities of one session whose handler failed. */
  async incidents(id: string): Promise<IncidentState[]> {
    return this.queued(id, async () => {
      const session = await this.require(id);
      return session.engine.incidentList();
    });
  }

  /** Runs a failed activity again. */
  async retry(id: string, tokenId: string): Promise<Session> {
    return this.queued(id, async () => {
      const session = await this.require(id);
      session.snapshot = await session.engine.retryTask(tokenId);
      await this.persist(session);
      return view(session);
    });
  }

  /** Gives up on a failed activity and moves the process on. */
  async resolveIncident(
    id: string,
    tokenId: string,
    output?: Record<string, unknown>,
  ): Promise<Session> {
    return this.queued(id, async () => {
      const session = await this.require(id);
      session.snapshot = await session.engine.resolveIncident(tokenId, output);
      await this.persist(session);
      return view(session);
    });
  }

  /** Fires the timers of one session that are due at `now`. */
  async tick(id: string, now?: number): Promise<Session> {
    return this.queued(id, async () => {
      const session = await this.require(id);
      session.snapshot = await session.engine.tick(now);
      await this.persist(session);
      return view(session);
    });
  }

  /**
   * Fires due timers across every known session and returns the ids that were
   * advanced. Stored sessions are inspected by their state — only the ones with
   * a timer actually due are rebuilt.
   */
  async tickAll(now: number = Date.now()): Promise<string[]> {
    await this.ensureIndex();
    const candidates = [...this.index]
      .filter(([, entry]) => entry.dueAt !== undefined && entry.dueAt <= now)
      .map(([id]) => id);
    const advanced: string[] = [];
    for (const id of candidates) {
      await this.tick(id, now);
      advanced.push(id);
    }
    return advanced;
  }

  /**
   * When the earliest timer or scheduled retry of any session falls due, so a
   * host can sleep until then instead of polling.
   */
  nextDueAt(): number | undefined {
    const due = [...this.index.values()]
      .map((entry) => entry.dueAt)
      .filter((at): at is number => at !== undefined);
    return due.length > 0 ? Math.min(...due) : undefined;
  }

  /**
   * Routes a message to the executions that correlate with it: the ones with a
   * subscription of that name whose key resolves to `correlationKey`. Returns
   * the ids that took it, so a caller can tell "nobody is waiting for this"
   * from "delivered".
   *
   * Unlike {@link signal}, which is addressed at one session, this is how a
   * "pedido 42 pago" event coming from outside finds its instance.
   */
  async correlate(
    name: string,
    correlationKey: unknown,
    output?: Record<string, unknown>,
  ): Promise<string[]> {
    const delivered: string[] = [];
    for (const id of await this.waitingIds()) {
      const took = await this.queued(id, async () => {
        const session = await this.load(id);
        if (!session?.engine.subscribedTo(name, correlationKey)) return false;
        session.snapshot = await session.engine.correlate(name, correlationKey, output);
        await this.persist(session);
        return true;
      });
      if (took) delivered.push(id);
    }
    return delivered;
  }

  /** Ids of the sessions that have a token parked on something. */
  private async waitingIds(): Promise<Set<string>> {
    await this.ensureIndex();
    const ids = new Set<string>();
    for (const [id, entry] of this.index) {
      if (entry.waiting > 0) ids.add(id);
    }
    return ids;
  }

  async signal(id: string, name: string, output?: Record<string, unknown>): Promise<Session> {
    return this.queued(id, async () => {
      const session = await this.require(id);
      session.snapshot = await session.engine.signal(name, output);
      await this.persist(session);
      return view(session);
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.queued(id, async () => {
      const removedFromCache = this.cache.delete(id);
      this.index.delete(id);
      const removedFromStorage = (await this.storage?.remove(id)) ?? false;
      return removedFromCache || removedFromStorage;
    });
  }

  /**
   * Summaries of every known session, stored and in-memory. Reads the persisted
   * state directly instead of rebuilding engines, so listing stays cheap.
   */
  async list(): Promise<SessionSummary[]> {
    await this.ensureIndex();
    return [...this.index].map(([id, entry]) => ({
      id,
      status: entry.status,
      waiting: entry.waiting,
      ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
    }));
  }

  private async load(id: string): Promise<LiveSession | undefined> {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const record = await this.storage?.read(id);
    if (!record) return undefined;
    const { process, processes } = await readProcesses(record.xml);
    const engine = this.wire(
      WorkflowEngine.restore(process, record.state, {
        processes,
        expressions: this.expressions,
      }),
    );
    const session: LiveSession = {
      id: record.id,
      xml: record.xml,
      snapshot: engine.snapshot(),
      engine,
    };
    this.cache.set(id, session);
    this.index.set(id, indexFromState(record.state, record.updatedAt));
    return session;
  }

  private async require(id: string): Promise<LiveSession> {
    const session = await this.load(id);
    if (!session) throw new SessionNotFoundError(id);
    return session;
  }

  /**
   * Writes the session through to storage, if any, and refreshes its index
   * entry — which is what keeps the periodic tick off the disk.
   */
  private async persist(session: LiveSession): Promise<void> {
    const updatedAt = new Date().toISOString();
    const state = session.engine.getState();
    this.index.set(session.id, indexFromState(state, updatedAt));
    await this.storage?.write({ id: session.id, xml: session.xml, state, updatedAt });
  }
}

/** The process to run plus every process of the file, for call activities. */
async function readProcesses(
  xml: string,
): Promise<{ process: ProcessModel; processes: ProcessModel[] }> {
  const model = await parseBpmn(xml);
  return { process: executableProcess(model), processes: model.processes };
}

function view(session: LiveSession): Session {
  return { id: session.id, xml: session.xml, snapshot: session.snapshot };
}

export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`Session not found: ${id}`);
    this.name = 'SessionNotFoundError';
  }
}
