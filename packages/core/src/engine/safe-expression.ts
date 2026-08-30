/**
 * Safe evaluator for BPMN expressions.
 *
 * Expressions are tokenized, parsed into a tree and interpreted by this module.
 * Nothing here compiles source into code — no `eval`, no `new Function` — so a
 * diagram that arrived from an untrusted source cannot reach the host process.
 * Anything the grammar does not describe is a parse error, and the caller
 * turns it into `undefined` (a condition then reads as `false`).
 *
 * The supported language is the subset of JavaScript a flow guard actually
 * needs:
 *
 *     literais        1  2.5  'ok'  "ok"  true  false  null  undefined  [a, b]
 *     identificadores valor  pedido.cliente.nome  itens[0]  a?.b
 *     operadores      ! - + typeof   * / %   + -   < <= > >=
 *                     === !== == !=   &&  ||  ??   ? :
 *     chamadas        Math.max(a, b)   itens.includes('x')   Number(valor)
 *
 * Two allowlists bound what a call can reach: {@link GLOBALS} (globals exposed
 * to an expression, member by member) and {@link CALLABLE_METHODS} (methods
 * callable on a value that came from the process variables). Property *reads*
 * are open, minus the names that lead back to code — `constructor`,
 * `prototype`, `__proto__`, `call`, `apply`, `bind`.
 *
 * There is no assignment, no `new`, no function literal and no statement, so an
 * expression cannot mutate the process variables either.
 */

import { BpmnExpressionError } from '../errors.js';

// --- Tree ------------------------------------------------------------------

export type ExpressionNode =
  | { type: 'literal'; value: unknown }
  | { type: 'identifier'; name: string }
  | { type: 'array'; items: ExpressionNode[] }
  | { type: 'unary'; operator: UnaryOperator; argument: ExpressionNode }
  | { type: 'binary'; operator: BinaryOperator; left: ExpressionNode; right: ExpressionNode }
  | { type: 'logical'; operator: LogicalOperator; left: ExpressionNode; right: ExpressionNode }
  | { type: 'conditional'; test: ExpressionNode; then: ExpressionNode; otherwise: ExpressionNode }
  | {
      type: 'member';
      object: ExpressionNode;
      property: ExpressionNode;
      /** `a[b]` (the property is an expression) instead of `a.b`. */
      computed: boolean;
      /** `a?.b`: a nullish object yields `undefined` instead of throwing. */
      optional: boolean;
    }
  | { type: 'call'; callee: ExpressionNode; args: ExpressionNode[]; optional: boolean };

type UnaryOperator = '!' | '-' | '+' | 'typeof';
type LogicalOperator = '&&' | '||' | '??';
type BinaryOperator =
  '===' | '!==' | '==' | '!=' | '<' | '<=' | '>' | '>=' | '+' | '-' | '*' | '/' | '%';

/** Binding power per binary operator; higher binds tighter. */
const BINARY_POWER: Record<string, number> = {
  '??': 1,
  '||': 2,
  '&&': 3,
  '===': 4,
  '!==': 4,
  '==': 4,
  '!=': 4,
  '<': 5,
  '<=': 5,
  '>': 5,
  '>=': 5,
  '+': 6,
  '-': 6,
  '*': 7,
  '/': 7,
  '%': 7,
};

const LOGICAL = new Set<string>(['&&', '||', '??']);

// --- Lexer -----------------------------------------------------------------

interface Token {
  kind: 'number' | 'string' | 'name' | 'punct';
  text: string;
  /** Already-decoded value of a number or string token. */
  value?: unknown;
  at: number;
}

/** Longest first, so `===` is not read as `==` followed by `=`. */
const PUNCTUATION = [
  '===',
  '!==',
  '?.',
  '??',
  '&&',
  '||',
  '==',
  '!=',
  '<=',
  '>=',
  '(',
  ')',
  '[',
  ']',
  '.',
  ',',
  '?',
  ':',
  '!',
  '<',
  '>',
  '+',
  '-',
  '*',
  '/',
  '%',
];

const NUMBER = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
const NAME = /^[A-Za-z_$][\w$]*/;
const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;

  while (at < source.length) {
    const char = source[at]!;
    if (/\s/.test(char)) {
      at += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      const [text, value] = readString(source, at);
      tokens.push({ kind: 'string', text, value, at });
      at += text.length;
      continue;
    }

    const rest = source.slice(at);
    const number = NUMBER.exec(rest);
    if (number && (/\d/.test(char) || char === '.')) {
      tokens.push({ kind: 'number', text: number[0], value: Number(number[0]), at });
      at += number[0].length;
      continue;
    }

    const name = NAME.exec(rest);
    if (name) {
      tokens.push({ kind: 'name', text: name[0], at });
      at += name[0].length;
      continue;
    }

    // `a ? .5 : 1` is a ternary over a number, not an optional chain.
    const punct = PUNCTUATION.find(
      (candidate) =>
        rest.startsWith(candidate) && !(candidate === '?.' && /\d/.test(rest[2] ?? '')),
    );
    if (!punct) throw new BpmnExpressionError(`Unexpected character "${char}" at ${at}.`);
    tokens.push({ kind: 'punct', text: punct, at });
    at += punct.length;
  }

  return tokens;
}

/** Reads a quoted string starting at `from`, returning its raw text and value. */
function readString(source: string, from: number): [string, string] {
  const quote = source[from];
  let value = '';
  let at = from + 1;

  while (at < source.length) {
    const char = source[at]!;
    if (char === '\\') {
      const escaped = source[at + 1];
      if (escaped === undefined) break;
      value += ESCAPES[escaped] ?? escaped;
      at += 2;
      continue;
    }
    if (char === quote) return [source.slice(from, at + 1), value];
    value += char;
    at += 1;
  }

  throw new BpmnExpressionError(`Unterminated string at ${from}.`);
}

// --- Parser ----------------------------------------------------------------

const KEYWORD_LITERALS: Record<string, unknown> = {
  true: true,
  false: false,
  null: null,
  undefined: undefined,
};

/**
 * Precedence-climbing parser: `expression(power)` consumes every operator that
 * binds at least as tight as `power`, so each level is one loop instead of one
 * function per precedence.
 */
class Parser {
  private at = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): ExpressionNode {
    if (this.tokens.length === 0) throw new BpmnExpressionError('Empty expression.');
    const node = this.expression(0);
    const extra = this.peek();
    if (extra) throw new BpmnExpressionError(`Unexpected "${extra.text}" at ${extra.at}.`);
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.at];
  }

  private next(): Token {
    const token = this.tokens[this.at];
    if (!token) throw new BpmnExpressionError('Unexpected end of expression.');
    this.at += 1;
    return token;
  }

  private isPunct(text: string): boolean {
    const token = this.peek();
    return token?.kind === 'punct' && token.text === text;
  }

  private eat(text: string): boolean {
    if (!this.isPunct(text)) return false;
    this.at += 1;
    return true;
  }

  private expect(text: string): void {
    if (!this.eat(text)) {
      const token = this.peek();
      throw new BpmnExpressionError(
        `Expected "${text}" but found ${token ? `"${token.text}" at ${token.at}` : 'the end'}.`,
      );
    }
  }

  private expression(power: number): ExpressionNode {
    let left = this.unary();

    for (;;) {
      const token = this.peek();
      if (token?.kind !== 'punct') break;

      // The ternary is the loosest operator and associates to the right, so it
      // only applies while nothing tighter is being parsed.
      if (token.text === '?' && power === 0) {
        this.at += 1;
        const then = this.expression(0);
        this.expect(':');
        left = { type: 'conditional', test: left, then, otherwise: this.expression(0) };
        continue;
      }

      const operator = token.text;
      const binding = BINARY_POWER[operator];
      if (binding === undefined || binding < power) break;
      this.at += 1;
      const right = this.expression(binding + 1);
      left = LOGICAL.has(operator)
        ? { type: 'logical', operator: operator as LogicalOperator, left, right }
        : { type: 'binary', operator: operator as BinaryOperator, left, right };
    }

    return left;
  }

  private unary(): ExpressionNode {
    const token = this.peek();
    const isTypeof = token?.kind === 'name' && token.text === 'typeof';
    if (isTypeof || (token?.kind === 'punct' && ['!', '-', '+'].includes(token.text))) {
      this.at += 1;
      return { type: 'unary', operator: token!.text as UnaryOperator, argument: this.unary() };
    }
    return this.postfix(this.primary());
  }

  /** Member access and calls, which bind tighter than any operator. */
  private postfix(node: ExpressionNode): ExpressionNode {
    for (;;) {
      if (this.eat('.')) {
        node = this.member(node, false);
      } else if (this.eat('?.')) {
        if (this.isPunct('(')) {
          node = { type: 'call', callee: node, args: this.args(), optional: true };
        } else if (this.eat('[')) {
          node = this.computedMember(node, true);
        } else {
          node = this.member(node, true);
        }
      } else if (this.eat('[')) {
        node = this.computedMember(node, false);
      } else if (this.isPunct('(')) {
        node = { type: 'call', callee: node, args: this.args(), optional: false };
      } else {
        return node;
      }
    }
  }

  private member(object: ExpressionNode, optional: boolean): ExpressionNode {
    return { type: 'member', object, property: this.name(), computed: false, optional };
  }

  private computedMember(object: ExpressionNode, optional: boolean): ExpressionNode {
    const property = this.expression(0);
    this.expect(']');
    return { type: 'member', object, property, computed: true, optional };
  }

  private name(): ExpressionNode {
    const token = this.next();
    if (token.kind !== 'name') {
      throw new BpmnExpressionError(`Expected a property name at ${token.at}.`);
    }
    return { type: 'literal', value: token.text };
  }

  private args(): ExpressionNode[] {
    this.expect('(');
    const args: ExpressionNode[] = [];
    if (this.eat(')')) return args;
    do {
      args.push(this.expression(0));
    } while (this.eat(','));
    this.expect(')');
    return args;
  }

  private primary(): ExpressionNode {
    const token = this.next();

    if (token.kind === 'number' || token.kind === 'string') {
      return { type: 'literal', value: token.value };
    }
    if (token.kind === 'name') {
      return Object.hasOwn(KEYWORD_LITERALS, token.text)
        ? { type: 'literal', value: KEYWORD_LITERALS[token.text] }
        : { type: 'identifier', name: token.text };
    }
    if (token.text === '(') {
      const node = this.expression(0);
      this.expect(')');
      return node;
    }
    if (token.text === '[') {
      const items: ExpressionNode[] = [];
      if (this.eat(']')) return { type: 'array', items };
      do {
        items.push(this.expression(0));
      } while (this.eat(','));
      this.expect(']');
      return { type: 'array', items };
    }

    throw new BpmnExpressionError(`Unexpected "${token.text}" at ${token.at}.`);
  }
}

/** Parses an expression, throwing {@link BpmnExpressionError} when it cannot. */
export function parseExpression(source: string): ExpressionNode {
  return new Parser(tokenize(source)).parse();
}

// --- Allowlists ------------------------------------------------------------

/** Property names that lead from any value back to code. */
const DENIED_PROPERTIES = new Set([
  'constructor',
  'prototype',
  '__proto__',
  'call',
  'apply',
  'bind',
]);

/**
 * Methods callable on a value coming from the process variables. Everything
 * here is a read-only query; `repeat` and friends are left out on purpose, so
 * an expression cannot inflate a string into a memory problem.
 */
const CALLABLE_METHODS = new Set([
  'at',
  'charAt',
  'concat',
  'endsWith',
  'includes',
  'indexOf',
  'join',
  'lastIndexOf',
  'slice',
  'split',
  'startsWith',
  'toFixed',
  'toLowerCase',
  'toString',
  'toUpperCase',
  'trim',
]);

/** Copies the named members of a global, binding functions to their owner. */
function expose(source: object, keys: string[]): Record<string, unknown> {
  const exposed: Record<string, unknown> = {};
  for (const key of keys) {
    const value = (source as Record<string, unknown>)[key];
    exposed[key] =
      typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(source) : value;
  }
  return Object.freeze(exposed);
}

/** A conversion that is also a namespace, as `Number(x)` and `Number.isNaN`. */
function callable(
  fn: (value: unknown) => unknown,
  source: object,
  keys: string[],
): (value: unknown) => unknown {
  return Object.freeze(Object.assign(fn, expose(source, keys)));
}

/**
 * Globals reachable from an expression, exposed member by member: whatever is
 * not listed simply does not exist for the evaluator. `Function`, `process`,
 * `globalThis` and every other way back to the host are absent by omission.
 */
const GLOBALS: Record<string, unknown> = Object.freeze({
  Math: expose(Math, [
    'abs',
    'ceil',
    'floor',
    'round',
    'trunc',
    'sign',
    'max',
    'min',
    'pow',
    'sqrt',
    'PI',
  ]),
  JSON: expose(JSON, ['parse', 'stringify']),
  Array: expose(Array, ['isArray']),
  Object: expose(Object, ['keys', 'values', 'entries']),
  Date: expose(Date, ['now', 'parse']),
  Number: callable((value) => Number(value), Number, [
    'isFinite',
    'isInteger',
    'isNaN',
    'parseFloat',
    'parseInt',
    'EPSILON',
    'MAX_SAFE_INTEGER',
    'MIN_SAFE_INTEGER',
  ]),
  String: (value: unknown) => String(value),
  Boolean: (value: unknown) => Boolean(value),
  isNaN: (value: unknown) => Number.isNaN(Number(value)),
  isFinite: (value: unknown) => Number.isFinite(Number(value)),
  parseInt: (value: unknown, radix?: unknown) =>
    parseInt(String(value), Number(radix) || undefined),
  parseFloat: (value: unknown) => parseFloat(String(value)),
});

/** The exposed globals themselves: every member of these is callable. */
const NAMESPACES = new Set<unknown>(Object.values(GLOBALS));

// --- Evaluation ------------------------------------------------------------

/**
 * Evaluates a parsed expression against `variables`.
 *
 * A name that is neither a variable nor an exposed global reads as `undefined`,
 * matching engines with a FEEL evaluator: `pago !== true` holds before anything
 * sets `pago`. Anything the allowlists refuse throws
 * {@link BpmnExpressionError}, which the caller turns into `undefined`.
 */
export function evaluateNode(node: ExpressionNode, variables: Record<string, unknown>): unknown {
  switch (node.type) {
    case 'literal':
      return node.value;

    case 'identifier':
      if (Object.hasOwn(variables, node.name)) return variables[node.name];
      return Object.hasOwn(GLOBALS, node.name) ? GLOBALS[node.name] : undefined;

    case 'array':
      return node.items.map((item) => evaluateNode(item, variables));

    case 'unary':
      return unary(node.operator, evaluateNode(node.argument, variables));

    case 'logical': {
      const left = evaluateNode(node.left, variables);
      if (node.operator === '&&') return left ? evaluateNode(node.right, variables) : left;
      if (node.operator === '||') return left ? left : evaluateNode(node.right, variables);
      return left ?? evaluateNode(node.right, variables);
    }

    case 'binary':
      return binary(
        node.operator,
        evaluateNode(node.left, variables),
        evaluateNode(node.right, variables),
      );

    case 'conditional':
      return evaluateNode(
        evaluateNode(node.test, variables) ? node.then : node.otherwise,
        variables,
      );

    case 'member': {
      const object = evaluateNode(node.object, variables);
      if (object === null || object === undefined) {
        if (node.optional) return undefined;
        throw new BpmnExpressionError(`Cannot read a property of ${String(object)}.`);
      }
      return read(object, propertyName(node, variables));
    }

    case 'call':
      return call(node, variables);
  }
}

function unary(operator: UnaryOperator, value: unknown): unknown {
  switch (operator) {
    case '!':
      return !value;
    case 'typeof':
      return typeof value;
    case '-':
      return -Number(value);
    case '+':
      return Number(value);
  }
}

function binary(operator: BinaryOperator, left: unknown, right: unknown): unknown {
  switch (operator) {
    case '===':
      return left === right;
    case '!==':
      return left !== right;
    // Loose comparison is part of the language a BPMN author expects.
    case '==':
      return left == right;
    case '!=':
      return left != right;
    case '<':
    case '<=':
    case '>':
    case '>=':
      return compare(operator, left, right);
    case '+':
      return add(left, right);
    case '-':
      return Number(left) - Number(right);
    case '*':
      return Number(left) * Number(right);
    case '/':
      return Number(left) / Number(right);
    case '%':
      return Number(left) % Number(right);
  }
}

/** `+` concatenates as soon as one side is a string, as JavaScript does. */
function add(left: unknown, right: unknown): string | number {
  if (typeof left === 'string' || typeof right === 'string') {
    return `${String(left)}${String(right)}`;
  }
  return Number(left) + Number(right);
}

function compare(operator: '<' | '<=' | '>' | '>=', left: unknown, right: unknown): boolean {
  const result = order(left, right);
  // Every comparison against NaN is false, `>=` included.
  if (Number.isNaN(result)) return false;
  switch (operator) {
    case '<':
      return result < 0;
    case '<=':
      return result <= 0;
    case '>':
      return result > 0;
    case '>=':
      return result >= 0;
  }
}

/** Two strings order lexicographically; anything else orders as numbers. */
function order(left: unknown, right: unknown): number {
  if (typeof left === 'string' && typeof right === 'string') {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  const a = Number(left);
  const b = Number(right);
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Property being accessed, as a string: `a.b`, `a['b']` and `a[0]` alike. */
function propertyName(
  node: Extract<ExpressionNode, { type: 'member' }>,
  variables: Record<string, unknown>,
): string {
  return node.computed
    ? String(evaluateNode(node.property, variables))
    : String((node.property as { value: unknown }).value);
}

function read(object: unknown, property: string): unknown {
  if (DENIED_PROPERTIES.has(property)) {
    throw new BpmnExpressionError(`Reading "${property}" is not allowed in an expression.`);
  }
  // `Object(...)` so a primitive still answers for `length`, `toFixed` and co.
  return (Object(object) as Record<string, unknown>)[property];
}

function call(
  node: Extract<ExpressionNode, { type: 'call' }>,
  variables: Record<string, unknown>,
): unknown {
  const args = node.args.map((arg) => evaluateNode(arg, variables));

  if (node.callee.type === 'member') {
    const object = evaluateNode(node.callee.object, variables);
    if (object === null || object === undefined) {
      if (node.optional || node.callee.optional) return undefined;
      throw new BpmnExpressionError(`Cannot call a method of ${String(object)}.`);
    }
    const property = propertyName(node.callee, variables);
    // A member of an exposed global is safe by construction; on any other value
    // only the allowlisted query methods can be called.
    if (!NAMESPACES.has(object) && !CALLABLE_METHODS.has(property)) {
      throw new BpmnExpressionError(`Calling "${property}" is not allowed in an expression.`);
    }
    const fn = read(object, property);
    if (typeof fn !== 'function') {
      if (node.optional && (fn === null || fn === undefined)) return undefined;
      throw new BpmnExpressionError(`"${property}" is not a function.`);
    }
    return (fn as (...values: unknown[]) => unknown).apply(object, args);
  }

  // A bare name is callable only when it resolves to an exposed global, so a
  // function that happens to sit in the process variables stays out of reach.
  const callee = evaluateNode(node.callee, variables);
  if (node.optional && (callee === null || callee === undefined)) return undefined;
  const name = node.callee.type === 'identifier' ? node.callee.name : '';
  if (typeof callee !== 'function' || !NAMESPACES.has(callee)) {
    throw new BpmnExpressionError(`Calling "${name}" is not allowed in an expression.`);
  }
  return (callee as (...values: unknown[]) => unknown)(...args);
}
