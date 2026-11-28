import { describe, expect, it } from 'vitest';
import type { Protocol } from 'devtools-protocol';
import { consoleText } from '../../src/console-text.ts';
import { functionSource, plainData } from '../../src/main-process.ts';

describe('functionSource', () => {
  it('keeps a function that is an expression, and puts the keyword back on a shorthand method', () => {
    const methods = {
      plain() {
        return 1;
      },
      async later() {
        return await Promise.resolve(2);
      },
      async: (value: number) => value,
    };
    expect(functionSource(() => 1)).toBe('() => 1');
    expect(functionSource(methods.async)).toBe('(value) => value');
    expect(functionSource(methods.plain)).toMatch(/^function plain\(\)/);
    expect(functionSource(methods.later)).toMatch(/^async function later\(\)/);
    expect(functionSource(function named() {})).toMatch(/^function named\(\)/);
  });

  it('refuses a function with no source of its own', () => {
    expect(() => functionSource(Math.max)).toThrow(/cannot be sent as source text/);
  });
});

describe('plainData', () => {
  it('keeps plain data as it is', () => {
    const value = { name: 'ada', tags: ['a', 'b'], nested: { count: 2, on: true, none: null } };
    expect(plainData(value)).toEqual(value);
    expect(plainData('text')).toBe('text');
    expect(plainData(undefined)).toBeUndefined();
    expect(plainData(JSON.parse('{"__proto__":{"x":1},"y":2}'))).toEqual(JSON.parse('{"__proto__":{"x":1},"y":2}'));
  });

  it('leaves out functions and symbols, and keeps an array\'s positions', () => {
    expect(plainData({ run: () => 1, id: Symbol('id'), kept: 1 })).toEqual({ kept: 1 });
    expect(plainData([1, () => 2, 3])).toEqual([1, null, 3]);
    expect(plainData(() => 1)).toBeUndefined();
  });

  it('cuts a reference back to an object that holds it, and keeps one object held twice', () => {
    const timer: Record<string, unknown> = { delay: 50 };
    timer['self'] = timer;
    timer['list'] = { head: timer, size: 1 };
    expect(plainData(timer)).toEqual({ delay: 50, list: { size: 1 } });
    const shared = { x: 1 };
    expect(plainData({ a: shared, b: shared })).toEqual({ a: { x: 1 }, b: { x: 1 } });
  });

  it('sends a date as its ISO text, a bigint as its digits, and skips a getter that throws', () => {
    const value = {
      at: new Date('2026-01-02T03:04:05.000Z'),
      big: 12345678901234567890n,
      get broken(): never {
        throw new Error('no');
      },
    };
    expect(plainData(value)).toEqual({ at: '2026-01-02T03:04:05.000Z', big: '12345678901234567890' });
  });
});

describe('consoleText', () => {
  it('joins a console call\'s arguments as a terminal prints them', () => {
    expect(
      consoleText([
        { type: 'string', value: 'count' },
        { type: 'number', value: 3 },
        { type: 'number', unserializableValue: 'NaN' },
        { type: 'undefined' },
        { type: 'object', subtype: 'null', value: null },
        { type: 'boolean', value: false },
      ]),
    ).toBe('count 3 NaN undefined null false');
  });

  it('prints an object and an array from their previews, and an error as its description', () => {
    const object: Protocol.Runtime.RemoteObject = { type: 'object', description: 'Object', preview: { type: 'object', overflow: false, properties: [{ name: 'a', type: 'number', value: '1' }, { name: 'b', type: 'object', value: 'Object' }] } };
    const array: Protocol.Runtime.RemoteObject = { type: 'object', subtype: 'array', description: 'Array(3)', preview: { type: 'object', subtype: 'array', overflow: true, properties: [{ name: '0', type: 'number', value: '1' }, { name: '1', type: 'number', value: '2' }] } };
    const error: Protocol.Runtime.RemoteObject = { type: 'object', subtype: 'error', description: 'Error: boom\n    at main.js:1:1' };
    expect(consoleText([object])).toBe('{a: 1, b: Object}');
    expect(consoleText([array])).toBe('[1, 2, …]');
    expect(consoleText([error])).toBe('Error: boom\n    at main.js:1:1');
    expect(consoleText([{ type: 'function', description: 'function run() {}' }])).toBe('function run() {}');
  });
});
