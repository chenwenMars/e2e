/** Compile-time assertions for `browser.webmcp` and the `webmcp` option. */
import type { Browser, WebMcpTool, WebOptions } from '../../src/index.ts';
import type { JsonValue } from '@e2e-dev/core';

/** True only when A and B are the same type: `any`, `unknown`, and a dropped `readonly` all fail it. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
/** Compiles only when given `true`. */
function assertTrue<T extends true>(): T | undefined {
  return undefined;
}

type WebMcp = Browser['webmcp'];

assertTrue<Equal<WebMcpTool, {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: JsonValue;
  readonly annotations?: {
    readonly readOnly?: boolean;
    readonly untrustedContent?: boolean;
    readonly consequential?: boolean;
  };
}>>();
assertTrue<Equal<Parameters<WebMcp['tools']>, []>>();
assertTrue<Equal<ReturnType<WebMcp['tools']>, Promise<readonly WebMcpTool[]>>>();
assertTrue<Equal<Parameters<WebMcp['callTool']>, [name: string, input?: { readonly [key: string]: JsonValue } | null | undefined]>>();
assertTrue<Equal<ReturnType<WebMcp['callTool']>, Promise<JsonValue>>>();

declare const browser: Browser;
declare const tools: Awaited<ReturnType<WebMcp['tools']>>;
declare const tool: WebMcpTool;

browser.webmcp.callTool('add', { a: 2, b: 40 });
browser.webmcp.callTool('refresh');
browser.webmcp.callTool('refresh', null);
// @ts-expect-error a tool name is a string
browser.webmcp.callTool(42);
// @ts-expect-error input is an object
browser.webmcp.callTool('add', 42);
// @ts-expect-error input is an object, not a list
browser.webmcp.callTool('add', [2, 40]);
// @ts-expect-error input is JSON, so it holds no function
browser.webmcp.callTool('add', { a: () => 2 });
// @ts-expect-error input is JSON, so it holds no Date
browser.webmcp.callTool('add', { at: new Date() });
// @ts-expect-error the list is read-only
tools.push(tool);
// @ts-expect-error a tool is read-only
tool.name = 'renamed';
// @ts-expect-error the hint is `readOnly`, not the spec's `readOnlyHint`
void tool.annotations?.readOnlyHint;
declare const other: Browser;
// @ts-expect-error the member cannot be replaced
browser.webmcp = other.webmcp;

assertTrue<Equal<WebOptions['webmcp'], boolean | undefined>>();
void ({ webmcp: true } satisfies WebOptions);
// @ts-expect-error webmcp is a boolean
void ({ webmcp: 'on' } satisfies WebOptions);
