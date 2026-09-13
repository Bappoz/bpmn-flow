/**
 * Expression evaluation for sequence-flow guards, loop cardinalities,
 * completion conditions and data mappings.
 *
 * Two modes, chosen per engine through `EngineOptions.expressions`:
 *
 * - `safe` (default): the expression is parsed and interpreted by
 *   {@link ./safe-expression.js}, a JavaScript subset with allowlisted globals
 *   and no way to compile code. A diagram from an untrusted source — anything
 *   uploaded to `@bpmn-flow/server`, for instance — cannot reach the host.
 * - `javascript`: the expression is compiled with `new Function` and evaluated
 *   over the process variables, so the full language is available. This trusts
 *   the diagram exactly as much as the code around it: **only enable it for
 *   definitions you author**.
 *
 * In both modes a variable that does not exist reads as `undefined` instead of
 * throwing — `pago !== true` is true before anything sets `pago`, as engines
 * with a FEEL evaluator behave. An expression that throws (or that the safe
 * mode refuses) is treated as `undefined`, and therefore `false` as a
 * condition, so a malformed guard never crashes the engine. Expressions may
 * optionally be wrapped in `${ ... }`.
 */

import { evaluateNode, parseExpression, type ExpressionNode } from './safe-expression.js';

/** How an expression is evaluated. See the module documentation. */
export type ExpressionMode = 'safe' | 'javascript';

const WRAPPER = /^\s*\$\{([\s\S]*)\}\s*$/;

const trees = new Map<string, ExpressionNode | Error>();
const compiled = new Map<string, (scope: Record<string, unknown>) => unknown>();

/** Strips an optional `${ ... }` wrapper. */
function body(expression: string): string {
  return expression.replace(WRAPPER, '$1').trim();
}

/** Parses once per expression; a failure is cached as the error it raised. */
function tree(expression: string): ExpressionNode {
  let cached = trees.get(expression);
  if (cached === undefined) {
    try {
      cached = parseExpression(body(expression));
    } catch (error) {
      cached = error instanceof Error ? error : new Error(String(error));
    }
    trees.set(expression, cached);
  }
  if (cached instanceof Error) throw cached;
  return cached;
}

function compile(expression: string): (scope: Record<string, unknown>) => unknown {
  const cached = compiled.get(expression);
  if (cached) return cached;

  // `with` over a proxy: the `has` trap claims every non-global identifier so
  // unknown names resolve to `undefined` rather than raising a ReferenceError.
  //
  // Compiling the diagram's expression is the whole point of the `javascript`
  // mode, and its documented cost: it trusts the definition as much as the
  // surrounding code. Untrusted XML goes through the safe evaluator instead.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function(
    'scope',
    `with (scope) { try { return (${body(expression)}); } catch { return undefined; } }`,
  ) as (scope: Record<string, unknown>) => unknown;
  compiled.set(expression, fn);
  return fn;
}

/** Wraps the variables so bare identifiers never raise a ReferenceError. */
function scopeFor(variables: Record<string, unknown>): Record<string, unknown> {
  return new Proxy(variables, {
    has: (target, key) => Reflect.has(target, key) || !(key in globalThis),
    get: (target, key): unknown =>
      key === Symbol.unscopables ? undefined : Reflect.get(target, key),
  });
}

/**
 * Evaluates an expression and returns its raw value, or `undefined` when it
 * throws. Used for non-boolean expressions such as a loop cardinality.
 */
export function evaluateExpression(
  expression: string,
  variables: Record<string, unknown>,
  mode: ExpressionMode = 'safe',
): unknown {
  try {
    return mode === 'javascript'
      ? compile(expression)(scopeFor(variables))
      : evaluateNode(tree(expression), variables);
  } catch {
    return undefined;
  }
}

/** Evaluates an expression to a boolean against `variables`. */
export function evaluateCondition(
  expression: string,
  variables: Record<string, unknown>,
  mode: ExpressionMode = 'safe',
): boolean {
  return evaluateExpression(expression, variables, mode) === true;
}

/**
 * Whether the safe evaluator understands this expression. Lets a diagram be
 * checked up front instead of silently evaluating to `false` at runtime.
 */
export function isSafeExpression(expression: string): boolean {
  try {
    tree(expression);
    return true;
  } catch {
    return false;
  }
}
