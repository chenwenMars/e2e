/**
 * `createAgent` from `@e2e-dev/core/agent`: the agent over one session, configured
 * in code. `act`, `assert`, `waitFor`, and `extract` behave as they do in a
 * test. With `cache`, `act` replays recorded flows, each keyed by the
 * `cacheKey` the call names.
 */

import { createAgentFixture } from '../agent/index.ts';
import type { AgentContext, AgentSelection } from '../agent/invocation.ts';
import { createAgentCacheContext, settleStagedTraces, type AgentCacheContext } from '../cache/context.ts';
import { storedRecordingsFor } from '../cache/rekeyed.ts';
import { resolveAgentConfig } from '../config/agent.ts';
import type { ResolvedCacheConfig } from '../config/resolve.ts';
import { AgentError } from '../agent/error.ts';
import { TestError } from '../internal/errors.ts';
import { rejectUnknownKeys } from '../internal/options.ts';
import { lazily, lazyBuiltInAgent } from '../run/fixtures.ts';
import { targetIdentity } from '../run/sessions.ts';
import { WorkerModels } from '../run/worker-models.ts';
import type { ActOptions, ActResult, Agent, AgentConfig, CacheStore } from '../types.ts';
import { sessionInternals } from './internals.ts';
import type { Session } from './launch.ts';
import path from 'node:path';

export type {
  ActionEvent, ActionHook, ActionName, ActOptions, ActResult, Agent, AgentConfig, AgentErrorCode, AgentTool, AssertOptions,
  BeforeActionEvent, BeforeActionHook, CacheReadResult, CacheStore, ExtractOptions, ModelInstance, ProviderOptions, VisionMode,
  WaitForOptions,
} from '../types.ts';
// What a custom executor is written against, as the `e2e` entry has it.
export type {
  ExecutorActions, ExecutorAttempt, ExecutorBudgets, ExecutorModelCall, ExecutorNode, ExecutorObservation, ExecutorObserveOptions,
  ExecutorPixels, ExecutorReadOptions, ExecutorReadResult, ExecutorStep, ExecutorTarget, ExecutorVerb, PointDragResult, PointHit,
  PointTapResult, ReplayedPrefix, ReplayHandOffReason, StepExecutor, StepExecutorContext, StepVerdict, StepVerdictStatus,
} from '../agent/executor.ts';
export type { StepCacheInfo } from '../run/steps.ts';
// The project tools and executor seam an agent is built from, as `e2e/agent` has them.
export * from '../agent/public.ts';

/** Where `act` keeps the flows it recorded, and whether it may write new ones. */
export interface AgentCacheOptions {
  /** The file store's directory, from the `launch` `cwd`; ignored with `store`. */
  readonly dir?: string;
  /** `read-write` (the default) replays and records; `read-only` replays and never writes. */
  readonly mode?: 'read-write' | 'read-only';
  /** A custom store in place of the file store, the seam a shared cache plugs into. */
  readonly store?: CacheStore;
  /**
   * Replays only: a recording that no longer replays fails its step with
   * `REPLAY_STALE` instead of calling the model, and nothing is written.
   */
  readonly strict?: boolean;
}

/** The agent's model, budgets, and context, as an `agents` entry of a config takes them, plus what only a program sets. */
export type CreateAgentOptions = AgentConfig & {
  /** Replays recorded `act` flows; every `act` then names its recording with `cacheKey`. */
  readonly cache?: AgentCacheOptions;
};

/** `act` on an agent with a cache: each call names the recording it replays and records. */
export type CachingActOptions = Omit<ActOptions, 'agent'> & (
  | {
      /**
       * The recording this call replays and records, unique within what the
       * program does: `checkout`, `cart-best-coupon`. The key is this name,
       * the instruction, its params, and how many times the session made the
       * same call, so a reworded instruction records afresh.
       */
      readonly cacheKey: string;
      readonly cache?: never;
    }
  | {
      /** Runs this call live, neither replaying nor recording. */
      readonly cache: false;
      readonly cacheKey?: never;
    }
);

/** An agent whose `act` replays recorded flows. */
export interface CachingAgent extends Omit<Agent, 'act'> {
  act(instruction: string, options: CachingActOptions): Promise<ActResult>;
}

/** An agent without a cache: every `act` calls the model. */
export interface CoreAgent extends Omit<Agent, 'act'> {
  act(instruction: string, options?: Omit<ActOptions, 'agent'>): Promise<ActResult>;
}

/**
 * An agent created from options the compiler could not read a `cache` off,
 * such as a variable typed `CreateAgentOptions`: `act` takes either form, and
 * the runtime refuses the one that does not fit the agent.
 */
export interface UncheckedAgent extends Omit<Agent, 'act'> {
  act(instruction: string, options?: CachingActOptions | Omit<ActOptions, 'agent'>): Promise<ActResult>;
}

const AGENT_NAME = 'agent';
/**
 * What stands in a recording's key where a run puts its project. A run reads
 * it off `package.json`, or hashes the directory when there is none; a
 * program's recordings must be found from any directory and on any machine,
 * so a shared store works, and the `cacheKey` already names the flow.
 */
const CACHE_PROJECT_ID = '@e2e-dev/core';

/** Creates an agent over `session` whose `act` replays flows from `cache`, each named by its `cacheKey`. */
export function createAgent(session: Session, options: CreateAgentOptions & { readonly cache: AgentCacheOptions }): CachingAgent;
/** Creates an agent over `session`. */
export function createAgent(session: Session, options: CreateAgentOptions & { readonly cache?: undefined }): CoreAgent;
/** Creates an agent over `session` from options held in a variable; see `UncheckedAgent`. */
export function createAgent(session: Session, options: CreateAgentOptions): UncheckedAgent;
export function createAgent(session: Session, options: CreateAgentOptions): CachingAgent | CoreAgent | UncheckedAgent {
  const internals = sessionInternals(session, 'createAgent');
  if (typeof options !== 'object' || options === null) throw new TestError('INVALID_ARGUMENT', 'createAgent options must be an object with a model');
  const { cache, ...entry } = options;
  const resolved = resolveAgentConfig(entry as AgentConfig, 'createAgent');
  const { config, attempt, target } = internals;
  const cacheConfig = cache === undefined ? undefined : resolveAgentCache(cache, config.projectRoot);
  // A missing model fails the first call that needs one, as `MODEL_UNAVAILABLE`, never the construction.
  const models = new WorkerModels(() => undefined);
  const selection: AgentSelection = {
    name: AGENT_NAME,
    config: resolved,
    executor: resolved.executor ?? lazyBuiltInAgent(resolved),
    customExecutor: resolved.executor !== undefined,
    judge: lazily(() => models.build(resolved.judge, AGENT_NAME)),
    agentContext: resolved.context,
  };
  const base: AgentContext = {
    ...attempt.agentRuntime,
    select: (requested) => {
      if (requested !== undefined) throw new TestError('INVALID_ARGUMENT', 'an @e2e-dev/core agent takes no agent option: create another agent for another configuration');
      if (resolved.model === undefined && resolved.executor === undefined) {
        throw new AgentError('MODEL_UNAVAILABLE', "the agent has no model: pass one to createAgent, an AI SDK model instance such as createAgent(session, { model: gateway('openai/gpt-6-luna-fast') })");
      }
      models.preflight(resolved, AGENT_NAME);
      return selection;
    },
    reportUnservedModel: models.unservedModel,
  };
  const live = createAgentFixture(base);

  // One cache context per key, each its own occurrence count; all settle when the session closes.
  const caches = new Map<string, AgentCacheContext>();
  const cacheFor = (cacheKey: string): AgentCacheContext | undefined => {
    if (cacheConfig === undefined) return undefined;
    let context = caches.get(cacheKey);
    if (context === undefined) {
      context = createAgentCacheContext({
        cache: cacheConfig, projectRoot: config.projectRoot, projectId: CACHE_PROJECT_ID,
        testId: `core:${cacheKey}`, target: targetIdentity(target), attemptIndex: 0,
        recordings: storedRecordingsFor(cacheConfig),
      });
      if (context !== undefined) caches.set(cacheKey, context);
    }
    return context;
  };
  if (cacheConfig !== undefined) {
    internals.closers.push(async () => {
      const settlement = internals.settlement();
      for (const context of caches.values()) await settleStagedTraces(context, settlement);
    });
  }

  const act = (instruction: string, actOptions?: CachingActOptions | Omit<ActOptions, 'agent'>): Promise<ActResult> => {
    const { cacheKey, cache: perCall, ...rest } = (actOptions ?? {}) as Partial<{ cacheKey: unknown; cache: unknown }> & ActOptions;
    if (cacheConfig === undefined) {
      if (cacheKey !== undefined || perCall !== undefined) {
        return Promise.reject(new TestError('INVALID_ARGUMENT', 'act cacheKey and cache need an agent created with createAgent({ cache })'));
      }
      return live.act(instruction, rest);
    }
    if (perCall === false && cacheKey === undefined) return live.act(instruction, rest);
    if (typeof cacheKey !== 'string' || cacheKey.trim() === '' || perCall !== undefined) {
      return Promise.reject(new TestError('INVALID_ARGUMENT', 'act on an agent with a cache names its recording: pass { cacheKey: "<name>" }, or { cache: false } to run live'));
    }
    const context = cacheFor(cacheKey);
    return createAgentFixture(context === undefined ? base : { ...base, cache: context }).act(instruction, rest);
  };

  return {
    act,
    assert: (assertion, assertOptions) => live.assert(assertion, assertOptions),
    waitFor: (condition, waitOptions) => live.waitFor(condition, waitOptions),
    extract: (instruction, extractOptions) => live.extract(instruction, extractOptions),
  };
}

/** The cache options as the replay cache reads them: the file store under the project root unless a store replaces it. */
function resolveAgentCache(cache: AgentCacheOptions, projectRoot: string): ResolvedCacheConfig {
  if (typeof cache !== 'object' || cache === null) throw new TestError('INVALID_ARGUMENT', 'createAgent cache must be an object such as { dir: ".e2e/cache" }');
  rejectUnknownKeys('createAgent cache', cache, ['dir', 'mode', 'store', 'strict'], 'INVALID_ARGUMENT');
  const mode = cache.mode ?? 'read-write';
  if (mode !== 'read-write' && mode !== 'read-only') throw new TestError('INVALID_ARGUMENT', 'createAgent cache.mode must be "read-write" or "read-only"');
  if (cache.dir !== undefined && (typeof cache.dir !== 'string' || cache.dir.trim() === '')) throw new TestError('INVALID_ARGUMENT', 'createAgent cache.dir must be a non-empty path');
  if (cache.strict !== undefined && typeof cache.strict !== 'boolean') throw new TestError('INVALID_ARGUMENT', 'createAgent cache.strict must be a boolean');
  return {
    mode,
    store: cache.store,
    dir: path.resolve(projectRoot, cache.dir ?? path.join('.e2e', 'cache')),
    strict: cache.strict === true ? { config: true, flag: false } : false,
  };
}
