import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseBpmn, WorkflowEngine } from '@bpmn-flow/core';
import type { ExecutionSnapshot } from '@bpmn-flow/core';

/**
 * A double of `bpmnElementsRegistry`: it records what the viewer asks for
 * instead of touching an SVG, which is all the viewer's logic is about.
 */
class FakeRegistry {
  readonly classes = new Map<string, Set<string>>();
  readonly overlays = new Map<string, string[]>();
  removeAllCalls = 0;

  addCssClasses(ids: string | string[], names: string | string[]): void {
    for (const id of toArray(ids)) {
      const current = this.classes.get(id) ?? new Set<string>();
      for (const name of toArray(names)) current.add(name);
      this.classes.set(id, current);
    }
  }

  removeCssClasses(ids: string | string[], names: string | string[]): void {
    for (const id of toArray(ids)) {
      const current = this.classes.get(id);
      if (!current) continue;
      for (const name of toArray(names)) current.delete(name);
    }
  }

  removeAllCssClasses(): void {
    this.removeAllCalls += 1;
    this.classes.clear();
  }

  addOverlays(id: string, overlay: { label: string }): void {
    this.overlays.set(id, [...(this.overlays.get(id) ?? []), overlay.label]);
  }

  removeAllOverlays(id: string): void {
    this.overlays.delete(id);
  }

  /** Classes currently on an element, as a plain sorted array. */
  of(id: string): string[] {
    return [...(this.classes.get(id) ?? [])].sort();
  }
}

const toArray = <T>(value: T | T[]): T[] => (Array.isArray(value) ? value : [value]);

const loaded: string[] = [];
let registry = new FakeRegistry();

vi.mock('bpmn-visualization', () => ({
  FitType: { Center: 'Center' },
  BpmnVisualization: class {
    readonly bpmnElementsRegistry = registry;
    readonly navigation = { fit: vi.fn() };
    load(xml: string): void {
      loaded.push(xml);
    }
    dispose = vi.fn();
  },
}));

// Imported after the mock so the class picks the double up.
const { BpmnFlowViewer, EXECUTION_CLASSES } = await import('../src/index.js');

const LINEAR = `<?xml version="1.0" encoding="UTF-8"?>
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

function viewer(): InstanceType<typeof BpmnFlowViewer> {
  return new BpmnFlowViewer({ container: 'anywhere' });
}

function snapshot(partial: Partial<ExecutionSnapshot> = {}): ExecutionSnapshot {
  return {
    status: 'waiting',
    variables: {},
    tokens: [],
    completedNodes: [],
    history: [],
    ...partial,
  };
}

beforeEach(() => {
  registry = new FakeRegistry();
  loaded.length = 0;
});

describe('applySnapshot', () => {
  it('paints completed, active and waiting nodes', () => {
    viewer().applySnapshot(
      snapshot({
        completedNodes: ['Start'],
        tokens: [
          { id: 't1', nodeId: 'Aprovar', nodeKind: 'userTask', scopeId: 's0', waiting: true },
          { id: 't2', nodeId: 'Outro', nodeKind: 'task', scopeId: 's0', waiting: false },
        ],
      }),
    );

    expect(registry.of('Start')).toEqual([EXECUTION_CLASSES.completed]);
    expect(registry.of('Aprovar')).toEqual([EXECUTION_CLASSES.waiting]);
    expect(registry.of('Outro')).toEqual([EXECUTION_CLASSES.active]);
  });

  it('is the single source of truth: it repaints from scratch', () => {
    const view = viewer();
    view.applySnapshot(
      snapshot({
        tokens: [
          { id: 't1', nodeId: 'Aprovar', nodeKind: 'userTask', scopeId: 's0', waiting: true },
        ],
      }),
    );
    view.applySnapshot(snapshot({ completedNodes: ['Aprovar'] }));

    expect(registry.of('Aprovar')).toEqual([EXECUTION_CLASSES.completed]);
  });

  it('keeps the flows already taken across repaints', () => {
    const view = viewer();
    view.markFlowTaken('f0');
    view.applySnapshot(snapshot({ completedNodes: ['Start'] }));
    expect(registry.of('f0')).toEqual([EXECUTION_CLASSES.taken]);
  });

  it('touches nothing when there is nothing to paint', () => {
    viewer().applySnapshot(snapshot());
    expect(registry.classes.size).toBe(0);
  });
});

describe('markFlowTaken', () => {
  it('ignores the placeholder id the engine uses for internal moves', () => {
    const view = viewer();
    view.markFlowTaken('-');
    view.markFlowTaken('');
    expect(registry.classes.size).toBe(0);
  });

  it('forgets taken flows when the diagram is reloaded', async () => {
    const view = viewer();
    view.markFlowTaken('f0');
    await view.load(LINEAR);
    view.applySnapshot(snapshot());
    expect(registry.of('f0')).toEqual([]);
  });

  it('forgets them on clear too', () => {
    const view = viewer();
    view.markFlowTaken('f0');
    view.clear();
    view.applySnapshot(snapshot());
    expect(registry.of('f0')).toEqual([]);
  });
});

describe('applyReplayFrame', () => {
  it('paints the frame and the flows taken so far', () => {
    const view = viewer();
    view.markFlowTaken('f0');
    view.applyReplayFrame({
      index: 1,
      total: 3,
      nodeId: 'Aprovar',
      at: 0,
      completed: ['Start'],
      active: 'Aprovar',
    });

    expect(registry.of('Start')).toEqual([EXECUTION_CLASSES.completed]);
    expect(registry.of('Aprovar')).toEqual([EXECUTION_CLASSES.active]);
    expect(registry.of('f0')).toEqual([EXECUTION_CLASSES.taken]);
  });

  it('paints nothing active on a frame that has no token', () => {
    viewer().applyReplayFrame({ index: 2, total: 3, nodeId: 'End', at: 0, completed: ['Start'] });
    expect(registry.of('End')).toEqual([]);
  });
});

describe('bindEngine', () => {
  it('follows a real execution from enter to completion', async () => {
    const process = (await parseBpmn(LINEAR)).processes[0]!;
    const engine = new WorkflowEngine(process);
    const view = viewer();
    const unbind = view.bindEngine(engine);

    await engine.start();
    // Parked on the user task; the start event is behind us.
    expect(registry.of('Start')).toEqual([EXECUTION_CLASSES.completed]);
    expect(registry.of('Aprovar')).toEqual([EXECUTION_CLASSES.waiting]);
    expect(registry.of('f0')).toEqual([EXECUTION_CLASSES.taken]);

    const task = engine.tasks()[0]!;
    await engine.completeTask(task.tokenId);
    expect(registry.of('Aprovar')).toEqual([EXECUTION_CLASSES.completed]);
    // An end event is entered and never left, so the incremental binding
    // leaves it active; a later applySnapshot is what settles it as completed.
    expect(registry.of('End')).toEqual([EXECUTION_CLASSES.active]);
    view.applySnapshot(engine.snapshot());
    expect(registry.of('End')).toEqual([EXECUTION_CLASSES.completed]);

    unbind();
  });

  it('stops listening once unbound', async () => {
    const process = (await parseBpmn(LINEAR)).processes[0]!;
    const engine = new WorkflowEngine(process);
    const view = viewer();
    view.bindEngine(engine)();

    await engine.start();
    expect(registry.classes.size).toBe(0);
  });
});

describe('metrics badges', () => {
  const metrics = [
    {
      nodeId: 'Aprovar',
      nodeKind: 'userTask' as const,
      started: 1,
      completed: 1,
      totalMs: 4000,
      averageMs: 4000,
      maxMs: 4000,
    },
    {
      nodeId: 'Start',
      nodeKind: 'startEvent' as const,
      started: 1,
      completed: 0,
      totalMs: 0,
      averageMs: 0,
      maxMs: 0,
    },
  ];

  it('labels only what actually completed', () => {
    viewer().showMetrics(metrics);
    expect(registry.overlays.get('Aprovar')).toEqual(['4.0 s']);
    expect(registry.overlays.has('Start')).toBe(false);
  });

  it('accepts a custom label', () => {
    viewer().showMetrics(metrics, (entry) => `${entry.started}x`);
    expect(registry.overlays.get('Aprovar')).toEqual(['1x']);
  });

  it('removes them again', () => {
    const view = viewer();
    view.showMetrics(metrics);
    view.clearMetrics(metrics);
    expect(registry.overlays.size).toBe(0);
  });
});

describe('load', () => {
  it('renders the diagram it was given', async () => {
    await viewer().load(LINEAR);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toContain('<bpmn:process');
  });

  it('falls back to the original XML when layout fails', async () => {
    await viewer().load('<not-bpmn>');
    expect(loaded[0]).toBe('<not-bpmn>');
  });
});
