import { BpmnParseError } from './errors.js';
import { isSafeExpression } from './engine/expression.js';
import { isActivityKind } from './model/kinds.js';
import { parseBpmn } from './parser/parse.js';
import type { BpmnModel, FlowNode, ProcessModel, UnsupportedElement } from './model/types.js';

export interface ValidationIssue {
  severity: 'error' | 'warning';
  message: string;
  nodeId?: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  model?: BpmnModel;
}

/**
 * Elements the parser does not model on purpose, because they carry no
 * execution semantics: warning about them would be noise. Everything else it
 * skipped is something the diagram says and the engine will not do.
 */
const DECORATIVE = new Set([
  'textAnnotation',
  'group',
  'documentation',
  'extensionElements',
  'association',
  // Declarations consumed by reference from the events that use them.
  'message',
  'signal',
  'error',
  'escalation',
  'category',
  'itemDefinition',
  'interface',
  'resource',
  'dataStore',
  'collaboration',
  'process',
]);

/** Ids a reference may legitimately point at, gathered from the whole file. */
interface ModelContext {
  /** Every process id of the file, for `calledElement`. */
  processIds: Set<string>;
}

function validateProcess(
  process: ProcessModel,
  issues: ValidationIssue[],
  context: ModelContext,
): void {
  // "Where does it start and end" is a question about something that runs. A
  // black-box participant is drawn precisely to say "I do not model what
  // happens in here", and has no start event for the same reason it has no
  // nodes at all — that is the notation working, not a defect.
  if (process.isExecutable) {
    if (!process.flowNodes.some((n) => n.kind === 'startEvent')) {
      issues.push({ severity: 'error', message: `Process "${process.id}" has no start event.` });
    }
    if (!process.flowNodes.some((n) => n.kind === 'endEvent')) {
      issues.push({
        severity: 'warning',
        message: `Process "${process.id}" has no end event.`,
      });
    }
  }

  const nodesById = new Map(process.flowNodes.map((node) => [node.id, node]));

  for (const node of process.flowNodes) {
    checkNode(node, issues);
    checkExpressions(node, issues);
    checkReferences(node, nodesById, issues, context);
    if (node.process) validateProcess(node.process, issues, context);
  }

  for (const flow of process.sequenceFlows) {
    checkExpression(flow.conditionExpression, `flow "${flow.id}"`, issues, flow.sourceRef);
    checkFlowEnds(flow, nodesById, issues);
  }
}

/**
 * A sequence flow only connects nodes of its own scope. A reference to
 * something outside it — a typo, or a connection drawn across a subprocess
 * boundary — used to survive parsing and only surface at execution time, as a
 * raw `Flow node not found` from the graph.
 */
function checkFlowEnds(
  flow: { id: string; sourceRef: string; targetRef: string },
  nodesById: Map<string, FlowNode>,
  issues: ValidationIssue[],
): void {
  for (const [end, id] of [
    ['source', flow.sourceRef],
    ['target', flow.targetRef],
  ] as const) {
    if (nodesById.has(id)) continue;
    issues.push({
      severity: 'error',
      message: `Sequence flow "${flow.id}" has an unknown ${end}: "${id}" is not a node of this scope.`,
      nodeId: flow.id,
    });
  }
}

/** References a node makes to other elements: its host, its called process. */
function checkReferences(
  node: FlowNode,
  nodesById: Map<string, FlowNode>,
  issues: ValidationIssue[],
  context: ModelContext,
): void {
  const where = `"${node.name ?? node.id}"`;

  if (node.kind === 'boundaryEvent') {
    const host = node.attachedToRef ? nodesById.get(node.attachedToRef) : undefined;
    if (!node.attachedToRef || !host) {
      issues.push({
        severity: 'error',
        message: node.attachedToRef
          ? `Boundary event ${where} is attached to "${node.attachedToRef}", which is not a node of this scope.`
          : `Boundary event ${where} is not attached to any activity.`,
        nodeId: node.id,
      });
    } else if (!isActivityKind(host.kind)) {
      issues.push({
        severity: 'error',
        message: `Boundary event ${where} is attached to "${host.id}", a ${host.kind}; boundary events only attach to activities.`,
        nodeId: node.id,
      });
    }
  }

  if (node.calledElement && !context.processIds.has(node.calledElement)) {
    issues.push({
      severity: 'error',
      message: `Call activity ${where} calls "${node.calledElement}", which no process of this file defines.`,
      nodeId: node.id,
    });
  }
}

/** Every expression an execution would evaluate on this node. */
function checkExpressions(node: FlowNode, issues: ValidationIssue[]): void {
  const where = `"${node.name ?? node.id}"`;
  checkExpression(node.activationCondition, where, issues, node.id);
  checkExpression(node.completionCondition, where, issues, node.id);
  checkExpression(node.loop?.cardinality, where, issues, node.id);
  checkExpression(node.loop?.completionCondition, where, issues, node.id);
  checkExpression(node.loop?.loopCondition, where, issues, node.id);
}

/**
 * Warns about an expression the safe evaluator cannot read. It would not crash
 * anything — an unreadable expression evaluates to `undefined`, so a guard
 * simply never opens — but silently never opening is worth saying out loud.
 */
function checkExpression(
  expression: string | undefined,
  where: string,
  issues: ValidationIssue[],
  nodeId?: string,
): void {
  if (!expression || isSafeExpression(expression)) return;
  issues.push({
    severity: 'warning',
    message: `Expression of ${where} is not supported by the safe evaluator and reads as undefined: ${expression}`,
    ...(nodeId ? { nodeId } : {}),
  });
}

function checkNode(node: FlowNode, issues: ValidationIssue[]): void {
  const isStart = node.kind === 'startEvent';
  const isEnd = node.kind === 'endEvent';
  const isBoundary = node.kind === 'boundaryEvent';

  if (!isStart && !isBoundary && node.incoming.length === 0) {
    issues.push({
      severity: 'warning',
      message: `"${node.name ?? node.id}" is unreachable (no incoming flow).`,
      nodeId: node.id,
    });
  }
  if (!isEnd && node.outgoing.length === 0) {
    issues.push({
      severity: 'warning',
      message: `"${node.name ?? node.id}" is a dead end (no outgoing flow).`,
      nodeId: node.id,
    });
  }
}

/** Validates an already-parsed model without re-parsing. */
export function validateModel(model: BpmnModel): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (model.processes.length === 0) {
    issues.push({ severity: 'error', message: 'No process found in the model.' });
  }
  const context: ModelContext = {
    processIds: new Set(model.processes.map((process) => process.id)),
  };
  checkUnsupported(model.unsupported, issues);
  checkCollaboration(model, issues);

  for (const process of model.processes) {
    if (!process.isExecutable) {
      issues.push({
        severity: 'warning',
        message: `Process "${process.name ?? process.id}" is not executable and will not run.`,
      });
    }
    validateProcess(process, issues, context);
  }
  return issues;
}

/**
 * Says out loud which parts of the diagram the engine will not act on. A
 * process that draws an `ioSpecification` and gets nothing from it is the kind
 * of silence this turns into a contract.
 */
function checkUnsupported(unsupported: UnsupportedElement[], issues: ValidationIssue[]): void {
  const seen = new Set<string>();
  for (const element of unsupported) {
    if (DECORATIVE.has(element.type)) continue;
    const where = element.ownerId ?? element.id;
    const key = `${element.type}:${where ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push({
      severity: 'warning',
      message: `<${element.type}>${where ? ` on "${where}"` : ''} is not modelled: the engine ignores it.`,
      ...(where ? { nodeId: where } : {}),
    });
  }
}

/**
 * What a collaboration promises and what a single execution delivers: message
 * flows that end outside an executable pool go nowhere, and more than one
 * runnable pool needs the engine that drives all of them.
 */
function checkCollaboration(model: BpmnModel, issues: ValidationIssue[]): void {
  const executable = model.processes.filter((process) => process.isExecutable);
  if (executable.length > 1) {
    issues.push({
      severity: 'warning',
      message: `Collaboration has ${executable.length} executable pools; WorkflowEngine runs one process — use CollaborationEngine to run them all.`,
    });
  }

  const nodesOfExecutablePools = new Set<string>();
  for (const process of executable) collectNodeIds(process, nodesOfExecutablePools);

  for (const flow of model.messageFlows) {
    const ends = [flow.sourceRef, flow.targetRef];
    if (ends.every((end) => end !== undefined && nodesOfExecutablePools.has(end))) continue;
    issues.push({
      severity: 'warning',
      message: `Message flow "${flow.name ?? flow.id}" is not routed: one of its ends is not a node of an executable pool.`,
      nodeId: flow.id,
    });
  }
}

function collectNodeIds(process: ProcessModel, into: Set<string>): void {
  for (const node of process.flowNodes) {
    into.add(node.id);
    if (node.process) collectNodeIds(node.process, into);
  }
}

/**
 * Parses and validates BPMN XML, reporting structural problems. The result is
 * `valid` when there are no error-severity issues (warnings are advisory).
 */
export async function validateBpmn(xml: string): Promise<ValidationResult> {
  let model: BpmnModel;
  try {
    model = await parseBpmn(xml);
  } catch (error) {
    const message = error instanceof BpmnParseError ? error.message : String(error);
    return { valid: false, issues: [{ severity: 'error', message }] };
  }
  const issues = validateModel(model);
  return { valid: !issues.some((i) => i.severity === 'error'), issues, model };
}
