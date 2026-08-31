import {
  parseBpmn,
  validateBpmn,
  WorkflowEngine,
  type EngineMode,
  type EngineState,
  type ExecutionSnapshot,
  type ExpressionMode,
  type FlowNode,
  type PendingTask,
  type ProcessModel,
  type TaskHandler,
} from '@bpmn-flow/core';

/**
 * Command implementations, kept free of process/argv/IO so they can be tested
 * directly: each returns the text to print plus the exit code to use.
 */
export interface CommandResult {
  output: string;
  exitCode: number;
}

export interface RunOptions {
  variables?: Record<string, unknown>;
  mode?: EngineMode;
  /** Previously stored state to continue instead of starting fresh. */
  state?: EngineState;
  /** Automation by node id, element kind or `*`. */
  handlers?: Record<string, TaskHandler>;
  /** What to do when a handler throws: stop, or hold an incident. */
  onHandlerError?: 'fail' | 'incident';
  /** Automatic retries before giving up on a handler. */
  retry?: { attempts?: number; delay?: string };
  /**
   * Evaluate the diagram's expressions as full JavaScript instead of through
   * the safe evaluator. Only for a diagram you trust as much as your own code.
   */
  expressions?: ExpressionMode;
}

export interface RunResult extends CommandResult {
  snapshot: ExecutionSnapshot;
  state: EngineState;
}

const CHECK = '✓';
const CROSS = '✗';

/** `bpmn-flow validate <file>` */
export async function validate(xml: string): Promise<CommandResult> {
  const { valid, issues } = await validateBpmn(xml);
  const lines = issues.map(
    (issue) => `  ${issue.severity === 'error' ? CROSS : '!'} ${issue.message}`,
  );
  const errors = issues.filter((issue) => issue.severity === 'error').length;
  const header = valid ? `${CHECK} diagram is valid` : `${CROSS} ${errors} error(s)`;
  return {
    output: [header, ...lines].join('\n'),
    exitCode: valid ? 0 : 1,
  };
}

/** `bpmn-flow inspect <file>` — what the normalized model looks like. */
export async function inspect(xml: string): Promise<CommandResult> {
  const model = await parseBpmn(xml);
  const lines: string[] = [];

  for (const process of model.processes) {
    const nodes = flatten(process);
    lines.push(`process ${process.name ?? process.id} (${process.id})`);
    lines.push(`  nodes: ${nodes.length}   flows: ${process.sequenceFlows.length}`);

    const byKind = new Map<string, number>();
    for (const node of nodes) byKind.set(node.kind, (byKind.get(node.kind) ?? 0) + 1);
    for (const [kind, count] of [...byKind].sort()) lines.push(`    ${kind}: ${count}`);

    const lanes = [...new Set(nodes.map((node) => node.lane).filter(Boolean))];
    if (lanes.length > 0) lines.push(`  lanes: ${lanes.join(', ')}`);

    const repeated = nodes.filter((node) => node.loop);
    for (const node of repeated) {
      const loop = node.loop!;
      const how =
        loop.kind === 'standard'
          ? 'standard loop'
          : `multi-instance ${loop.sequential ? 'sequential' : 'parallel'}` +
            (loop.collection ? ` over "${loop.collection}"` : '') +
            (loop.cardinality ? ` x${loop.cardinality}` : '');
      lines.push(`  ${node.name ?? node.id}: ${how}`);
    }

    const timers = nodes.filter((node) => node.event?.kind === 'timer');
    for (const node of timers) {
      lines.push(`  ${node.name ?? node.id}: timer ${node.event?.timer ?? '(no definition)'}`);
    }
  }

  if (model.participants.length > 0) {
    lines.push(`participants: ${model.participants.map((p) => p.name ?? p.id).join(', ')}`);
  }
  return { output: lines.join('\n'), exitCode: 0 };
}

/** `bpmn-flow run <file>` — executes and reports where it stopped. */
export async function run(xml: string, options: RunOptions = {}): Promise<RunResult> {
  const model = await parseBpmn(xml);
  const process = model.processes[0];
  if (!process) throw new Error('No executable process found in the diagram.');

  const engine = options.state
    ? WorkflowEngine.restore(process, options.state, {
        processes: model.processes,
        ...(options.expressions ? { expressions: options.expressions } : {}),
      })
    : new WorkflowEngine(process, {
        processes: model.processes,
        ...(options.expressions ? { expressions: options.expressions } : {}),
        ...(options.mode ? { mode: options.mode } : {}),
        ...(options.variables ? { variables: options.variables } : {}),
        ...(options.onHandlerError ? { onHandlerError: options.onHandlerError } : {}),
        ...(options.retry ? { retry: options.retry } : {}),
      });
  for (const [selector, handler] of Object.entries(options.handlers ?? {})) {
    engine.registerHandler(selector, handler);
  }

  const snapshot = options.state ? await engine.resume() : await engine.start();
  const lines = [
    `status: ${snapshot.status}`,
    `path:   ${snapshot.completedNodes.join(' -> ')}`,
    `vars:   ${JSON.stringify(snapshot.variables)}`,
  ];

  const tasks = engine.tasks();
  if (tasks.length > 0) {
    lines.push('pending:');
    for (const task of tasks) lines.push(`  ${describeTask(task)}`);
  }
  const incidents = engine.incidentList();
  if (incidents.length > 0) {
    lines.push('incidents:');
    for (const incident of incidents) {
      lines.push(
        `  [${incident.tokenId}] ${incident.nodeId}: ${incident.message} (attempt ${incident.attempts})`,
      );
    }
  }
  const timers = engine.dueTimers();
  if (timers.length > 0) {
    lines.push('timers:');
    for (const timer of timers) {
      lines.push(
        `  ${timer.nodeId} due ${new Date(timer.dueAt).toISOString()} (${timer.definition})`,
      );
    }
  }

  return {
    output: lines.join('\n'),
    exitCode: snapshot.status === 'failed' ? 1 : 0,
    snapshot,
    state: engine.getState(),
  };
}

function describeTask(task: PendingTask): string {
  const who = [task.lane, ...task.candidates].filter(Boolean).join('/');
  return `[${task.tokenId}] ${task.name ?? task.nodeId} (${task.reason}${who ? `, ${who}` : ''})`;
}

/** Flow nodes of a process, including the ones nested in subprocesses. */
function flatten(process: ProcessModel): FlowNode[] {
  const nodes: FlowNode[] = [];
  const walk = (list: FlowNode[]): void => {
    for (const node of list) {
      nodes.push(node);
      if (node.process) walk(node.process.flowNodes);
    }
  };
  walk(process.flowNodes);
  return nodes;
}
