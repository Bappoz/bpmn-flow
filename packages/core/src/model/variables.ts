import type { ProcessModel } from './types.js';

/**
 * Which variables a process actually reads, discovered from the expressions in
 * the diagram itself: sequence-flow conditions, loop cardinalities and
 * collections, completion and activation conditions, conditional events.
 *
 * A UI can use this to tell the operator what the process expects — "this
 * gateway only opens when `pago` is true" — instead of leaving them guessing in
 * front of an empty JSON box.
 */

/** Where a variable shows up, and a value that would exercise that path. */
export interface VariableUsage {
  name: string;
  /** How the variable is consumed. */
  kind: 'condition' | 'collection';
  /** Expressions mentioning it, in document order. */
  expressions: string[];
  /** Elements whose expression mentions it (name when there is one). */
  usedBy: string[];
  /**
   * A value that satisfies the first expression, when one can be inferred from
   * its shape (`pago === true` suggests `true`, `valor > 1000` suggests 1001).
   */
  suggestion?: unknown;
}

/** Names the engine provides on its own; never asked from the caller. */
const ENGINE_PROVIDED = new Set(['loopCounter', 'arrived']);

/** Globals an expression may legitimately reference. */
const GLOBALS = new Set([
  'true',
  'false',
  'null',
  'undefined',
  'NaN',
  'Infinity',
  'typeof',
  'new',
  'in',
  'of',
  'void',
  'Math',
  'Date',
  'JSON',
  'Number',
  'String',
  'Boolean',
  'Array',
  'Object',
  'RegExp',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
]);

interface Mention {
  expression: string;
  owner: string;
  kind: VariableUsage['kind'];
}

/**
 * Every variable the process reads, in the order they appear.
 *
 * Variables the process only writes (a multi-instance item, an output
 * collection) are left out: the caller does not need to provide them.
 */
export function processVariables(process: ProcessModel): VariableUsage[] {
  const mentions = new Map<string, Mention[]>();
  const produced = new Set<string>(ENGINE_PROVIDED);

  const remember = (name: string, mention: Mention): void => {
    const current = mentions.get(name) ?? [];
    current.push(mention);
    mentions.set(name, current);
  };

  const readExpression = (expression: string | undefined, owner: string): void => {
    if (!expression) return;
    for (const name of identifiersOf(expression)) {
      remember(name, { expression, owner, kind: 'condition' });
    }
  };

  const walk = (scope: ProcessModel): void => {
    for (const flow of scope.sequenceFlows) {
      readExpression(flow.conditionExpression, flow.name ?? flow.id);
    }
    for (const node of scope.flowNodes) {
      const owner = node.name ?? node.id;
      readExpression(node.activationCondition, owner);
      for (const detail of node.events ?? (node.event ? [node.event] : [])) {
        readExpression(detail.condition, owner);
      }
      if (node.loop) {
        readExpression(node.loop.cardinality, owner);
        readExpression(node.loop.completionCondition, owner);
        readExpression(node.loop.loopCondition, owner);
        if (node.loop.collection) {
          remember(node.loop.collection, {
            expression: node.loop.collection,
            owner,
            kind: 'collection',
          });
        }
        // Written by the engine or by the handler, never asked for.
        if (node.loop.elementVariable) produced.add(node.loop.elementVariable);
        if (node.loop.outputElement) produced.add(node.loop.outputElement);
        if (node.loop.outputCollection) produced.add(node.loop.outputCollection);
      }
      if (node.process) walk(node.process);
    }
  };
  walk(process);

  const usages: VariableUsage[] = [];
  for (const [name, list] of mentions) {
    if (produced.has(name)) continue;
    const kind = list.some((mention) => mention.kind === 'collection') ? 'collection' : 'condition';
    const usage: VariableUsage = {
      name,
      kind,
      expressions: [...new Set(list.map((mention) => mention.expression))],
      usedBy: [...new Set(list.map((mention) => mention.owner))],
    };
    const suggestion = suggestFor(name, kind, usage.expressions);
    if (suggestion !== undefined) usage.suggestion = suggestion;
    usages.push(usage);
  }
  return usages;
}

/**
 * Ready-to-use starting variables: the suggestion of every variable the process
 * reads. Feed it to `new WorkflowEngine(process, { variables })`, or into the
 * JSON box of a UI so the operator starts from something that runs.
 */
export function suggestVariables(process: ProcessModel): Record<string, unknown> {
  const variables: Record<string, unknown> = {};
  for (const usage of processVariables(process)) {
    if (usage.suggestion !== undefined) variables[usage.name] = usage.suggestion;
  }
  return variables;
}

/** Identifiers an expression reads, ignoring strings, properties and globals. */
export function identifiersOf(expression: string): string[] {
  const withoutStrings = expression.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, ' ');
  const names: string[] = [];
  const pattern = /(^|[^\w$.])([A-Za-z_$][\w$]*)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(withoutStrings)) !== null) {
    const name = match[2]!;
    if (GLOBALS.has(name) || names.includes(name)) continue;
    names.push(name);
  }
  return names;
}

/**
 * A value for `name` that makes `expression` evaluate to `want`, read from the
 * shape of the comparison: `pago === true` is satisfied by `true` and refuted
 * by `false`, `valor > 1000` by `1001` and `1000`. Returns `undefined` when the
 * expression is too free-form to read.
 */
export function inferValue(name: string, expression: string, want = true): unknown {
  const escaped = name.replace(/[$]/g, '\\$&');

  const boolean = new RegExp(`\\b${escaped}\\s*(===?|!==?)\\s*(true|false)`).exec(expression);
  if (boolean) {
    const literal = boolean[2] === 'true';
    const equality = !boolean[1]!.startsWith('!');
    return equality === want ? literal : !literal;
  }

  const numeric = new RegExp(`\\b${escaped}\\s*(>=|<=|>|<|===?|!==?)\\s*(-?\\d+(?:\\.\\d+)?)`).exec(
    expression,
  );
  if (numeric) {
    const value = Number(numeric[2]);
    const table: Record<string, [number, number]> = {
      // operator: [value that satisfies, value that refutes]
      '>': [value + 1, value],
      '>=': [value, value - 1],
      '<': [value - 1, value],
      '<=': [value, value + 1],
      '==': [value, value + 1],
      '===': [value, value + 1],
      '!=': [value + 1, value],
      '!==': [value + 1, value],
    };
    const pair = table[numeric[1]!] ?? [value + 1, value];
    return want ? pair[0] : pair[1];
  }

  const text = new RegExp(`\\b${escaped}\\s*(===?|!==?)\\s*['"\`]([^'"\`]*)['"\`]`).exec(
    expression,
  );
  if (text) {
    const literal = text[2]!;
    const equality = !text[1]!.startsWith('!');
    const other = literal === '' ? 'x' : '';
    return equality === want ? literal : other;
  }

  const length = new RegExp(`\\b${escaped}\\.length\\s*(>=|>)\\s*(\\d+)`).exec(expression);
  if (length) {
    const enough = Number(length[2]) + (length[1] === '>' ? 1 : 0);
    const size = want ? enough : Math.max(0, enough - 1);
    return Array.from({ length: size }, (_, index) => `item-${index + 1}`);
  }

  // Bare truthiness check: `${aprovado}` or `aprovado && valor > 10`.
  if (new RegExp(`(^|[^\\w$.])${escaped}\\s*(&&|\\|\\||\\)|$)`).test(expression)) return want;
  return undefined;
}

/** Infers a value that satisfies the expression, from its shape. */
function suggestFor(name: string, kind: VariableUsage['kind'], expressions: string[]): unknown {
  if (kind === 'collection') return ['item-1', 'item-2'];
  for (const expression of expressions) {
    const value = inferValue(name, expression);
    if (value !== undefined) return value;
  }
  return undefined;
}
