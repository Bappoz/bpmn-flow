import { serve } from '@hono/node-server';
import { createApp, type AppOptions } from './app.js';
import { storeOptionsFrom } from './app.js';
import { SessionStore } from './sessions.js';

export { createApp, type AppOptions } from './app.js';
export { SessionStore, SessionNotFoundError } from './sessions.js';
export type {
  CreateSessionInput,
  InboxTask,
  Session,
  SessionStoreOptions,
  SessionSummary,
} from './sessions.js';
export { FileSessionStorage, InvalidSessionIdError } from './storage.js';
export type { SessionRecord, SessionStorage } from './storage.js';
export { SampleProvider, type SampleInfo } from './samples.js';
export { BadRequestError } from './http.js';

export interface ServerOptions extends AppOptions {
  port?: number;
  hostname?: string;
  /**
   * How often to fire due BPMN timers, in milliseconds. Defaults to 1000; set
   * to 0 to disable and drive timers yourself via `POST /api/sessions/:id/tick`.
   */
  timerIntervalMs?: number;
}

export interface RunningServer {
  port: number;
  close: () => void;
}

/**
 * Starts the BPMN Flow HTTP server on the given port and returns a handle for
 * shutting it down. Defaults to port 3000.
 */
export function startServer(options: ServerOptions = {}): RunningServer {
  const port = options.port ?? 3000;
  const sessions = options.sessions ?? new SessionStore(storeOptionsFrom(options));
  const app = createApp({ ...options, sessions });
  const server = serve({
    fetch: app.fetch,
    port,
    ...(options.hostname ? { hostname: options.hostname } : {}),
  });

  // Timers are the one thing a process cannot do for itself: something has to
  // notice the due date passed.
  const interval = options.timerIntervalMs ?? 1000;
  const timer =
    interval > 0
      ? setInterval(() => {
          void sessions.tickAll().catch(() => undefined);
        }, interval)
      : undefined;
  timer?.unref?.();

  return {
    port,
    close: () => {
      if (timer) clearInterval(timer);
      server.close();
    },
  };
}
