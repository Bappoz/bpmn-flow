import { BpmnParseError } from './errors.js';
import { isSafeExpression } from './engine/expression.js';
import { parseBpmn } from './parser/parse.js';
import type { BpmnModel, FlowNode, ProcessModel } from './model/types.js';

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

function validateProcess(process: ProcessModel, issues: ValidationIssue[]): void {
  const starts = process.flowNodes.filter((n) => n.kind === 'startEvent');
  const ends = process.flowNodes.filter((n) => n.kind === 'endEvent');

  if (starts.length === 0) {
    issues.push({ severity: 'error', message: `Process "${process.id}" has no start event.` });
  }
  if (ends.length === 0) {
    issues.push({
      severity: 'warning',
      message: `Process "${process.id}" has no end event.`,
    });
  }

  for (const node of process.flowNodes) {
    checkNode(node, issues);
    checkExpressions(node, issues);
    if (node.process) validateProcess(node.process, issues);
  }

  for (const flow of process.sequenceFlows) {
    checkExpression(flow.conditionExpression, `flow "${flow.id}"`, issues, flow.sourceRef);
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
  for (const process of model.processes) validateProcess(process, issues);
  return issues;
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
