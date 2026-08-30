import { describe, expect, it } from 'vitest';
import { evaluateCondition, evaluateExpression, isSafeExpression } from '../src/index.js';

describe('evaluateCondition', () => {
  it('evaluates plain expressions over variables', () => {
    expect(evaluateCondition('amount > 100', { amount: 150 })).toBe(true);
    expect(evaluateCondition('amount > 100', { amount: 50 })).toBe(false);
  });

  it('supports ${...} wrapped expressions', () => {
    expect(evaluateCondition('${status === "ok"}', { status: 'ok' })).toBe(true);
  });

  it('reads an unknown variable as undefined instead of throwing', () => {
    expect(() => evaluateCondition('missing === undefined', {})).not.toThrow();
    expect(evaluateCondition('missing === undefined', {})).toBe(true);
    expect(evaluateCondition('pago !== true', {})).toBe(true);
    expect(evaluateCondition('defined === undefined', { defined: undefined })).toBe(true);
  });

  it('fails closed (false) when the expression itself throws', () => {
    expect(evaluateCondition('missing.deep.value', {})).toBe(false);
    expect(evaluateCondition('(() => { throw new Error("x"); })()', {})).toBe(false);
  });

  it('keeps globals reachable', () => {
    expect(evaluateCondition('Math.max(a, b) === 5', { a: 5, b: 2 })).toBe(true);
    expect(evaluateCondition('Array.isArray(itens)', { itens: [1] })).toBe(true);
  });

  it('coerces non-boolean results to false', () => {
    expect(evaluateCondition('amount', { amount: 1 })).toBe(false);
  });
});

describe('the safe evaluator', () => {
  it('reads the language a flow guard needs', () => {
    const vars = {
      pedido: { total: 250, cliente: { nome: 'Ana' } },
      itens: ['teclado', 'mouse'],
      status: 'pago',
    };
    expect(evaluateCondition('pedido.total > 100 && status === "pago"', vars)).toBe(true);
    expect(evaluateCondition('pedido.cliente.nome === "Ana"', vars)).toBe(true);
    expect(evaluateCondition('itens.length === 2', vars)).toBe(true);
    expect(evaluateCondition('itens[0] === "teclado"', vars)).toBe(true);
    expect(evaluateCondition('itens.includes("mouse")', vars)).toBe(true);
    expect(evaluateCondition('pedido.entrega?.prazo === undefined', vars)).toBe(true);
    expect(evaluateCondition('(pedido.total - 50) / 2 === 100', vars)).toBe(true);
    expect(evaluateCondition('typeof pedido === "object"', vars)).toBe(true);
    expect(evaluateCondition('status !== "pago" ? false : true', vars)).toBe(true);
    expect(evaluateCondition('[1, 2, 3].includes(pedido.total / 250)', vars)).toBe(true);
    expect(evaluateCondition('status == "pago"', vars)).toBe(true);
  });

  it('follows JavaScript precedence and short-circuiting', () => {
    expect(evaluateExpression('1 + 2 * 3', {})).toBe(7);
    expect(evaluateExpression('(1 + 2) * 3', {})).toBe(9);
    expect(evaluateExpression('"a" + 1', {})).toBe('a1');
    expect(evaluateExpression('nulo ?? "padrao"', { nulo: null })).toBe('padrao');
    expect(evaluateExpression('ausente && ausente.x', {})).toBe(undefined);
    expect(evaluateExpression('true ? "sim" : falha.x', {})).toBe('sim');
    expect(evaluateExpression('-valor', { valor: 3 })).toBe(-3);
    expect(evaluateExpression('"b" > "a"', {})).toBe(true);
  });

  it('exposes the allowlisted globals only', () => {
    expect(evaluateExpression('Math.max(a, b)', { a: 5, b: 2 })).toBe(5);
    expect(evaluateExpression('Number("42") + 1', {})).toBe(43);
    expect(evaluateExpression('Number.isInteger(2.5)', {})).toBe(false);
    expect(evaluateExpression('JSON.stringify(itens)', { itens: [1] })).toBe('[1]');
    expect(evaluateExpression('Object.keys(o).length', { o: { a: 1 } })).toBe(1);
    // Nothing else exists, so nothing else can be reached.
    expect(evaluateExpression('typeof process', {})).toBe('undefined');
    expect(evaluateExpression('typeof globalThis', {})).toBe('undefined');
    expect(evaluateExpression('typeof Function', {})).toBe('undefined');
    expect(evaluateExpression('typeof require', {})).toBe('undefined');
  });

  it('refuses every known way back to code', () => {
    const attempts = [
      // The report in issue #12, verbatim.
      '(globalThis.__pwned = { pid: process.pid }, true)',
      '"".constructor.constructor("return process")().exit(1)',
      'itens.constructor',
      'itens.__proto__',
      'Math.max.call(null, 1, 2)',
      'Math.max.constructor("return 1")()',
      'Object.getPrototypeOf(itens)',
      '(() => true)()',
      'new Date()',
      'valor = 1',
      'itens.push(1) || true',
      '"x".repeat(1000000000).length > 0',
    ];
    const variables = { itens: [1], valor: 0 };
    for (const attempt of attempts) {
      // Refused at parse time or at evaluation time, both read as undefined.
      expect(evaluateExpression(attempt, variables), attempt).toBe(undefined);
    }
    // No expression can write, not even through a method of a variable.
    expect(variables).toEqual({ itens: [1], valor: 0 });
    expect('__pwned' in globalThis).toBe(false);
  });

  it('cannot call a function that happens to be a process variable', () => {
    let called = false;
    const variables = {
      perigo: () => {
        called = true;
        return true;
      },
    };
    expect(evaluateExpression('perigo()', variables)).toBe(undefined);
    expect(called).toBe(false);
  });

  it('reports whether an expression is readable, for validation up front', () => {
    expect(isSafeExpression('valor > 100')).toBe(true);
    expect(isSafeExpression('${valor > 100}')).toBe(true);
    expect(isSafeExpression('valor >')).toBe(false);
    expect(isSafeExpression('(() => 1)()')).toBe(false);
  });
});

describe('the javascript mode', () => {
  it('is opt-in and evaluates the whole language', () => {
    expect(evaluateExpression('(() => 1 + 1)()', {}, 'javascript')).toBe(2);
    expect(evaluateCondition('itens.some((i) => i > 2)', { itens: [1, 3] }, 'javascript')).toBe(
      true,
    );
  });

  it('is what reaches the host, which is why it is not the default', () => {
    expect(evaluateCondition('typeof process === "object"', {}, 'javascript')).toBe(true);
    expect(evaluateCondition('typeof process === "object"', {})).toBe(false);
  });
});
