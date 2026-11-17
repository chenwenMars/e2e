import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectFromRegistration } from '../../src/collect/collect.ts';
import * as registry from '../../src/collect/registry.ts';
import { collectModule, test } from '../../src/collect/registry.ts';
import { CollectionError } from '@e2e-dev/core/lib/internal/errors';

const noop = async () => {};

describe('registration', () => {
  it('registers tests synchronously in declaration order', async () => {
    const registration = await collectModule(async () => {
      test('first', noop);
      test('second', { tags: ['smoke'] }, noop);
    });
    expect(registration.tests.map((item) => item.title)).toEqual(['first', 'second']);
    expect(registration.tests[0]!.declarationIndex).toBeLessThan(
      registration.tests[1]!.declarationIndex,
    );
  });

  it('returns a branded TestCase and ignores it for discovery', async () => {
    const registration = await collectModule(async () => {
      const testCase = test('kept once', noop);
      expect(testCase).toBeDefined();
    });
    expect(registration.tests).toHaveLength(1);
  });

  it('rejects tags that are not a list of distinct names --tag can spell back', async () => {
    const register = (tags: unknown) =>
      collectModule(async () => {
        test('x', { tags } as never, noop);
      });
    await expect(register('smoke')).rejects.toThrow(
      "test options: tags must be a list of tag names, e.g. tags: ['smoke'], got \"smoke\"",
    );
    await expect(register({ smoke: true })).rejects.toThrow(/tags must be a list of tag names, .* got an object/);
    const rule = 'every tag must be a non-blank string with no comma and no leading or trailing whitespace';
    for (const [tag, shown] of [[1, '1'], ['', '""'], [' smoke', '" smoke"'], ['a,b', '"a,b"'], [undefined, 'undefined']] as const) {
      await expect(register([tag])).rejects.toThrow(`test options: ${rule}, got ${shown}`);
    }
    await expect(register(['smoke', 'smoke'])).rejects.toThrow('test options: tags lists "smoke" twice');
    await expect(
      collectModule(async () => {
        test.describe('group', { tags: ['a,b'] }, () => {
          test('x', noop);
        });
      }),
    ).rejects.toThrow(`describe options: ${rule}`);
    // Inner spaces are legal: `--tag 'Login Form'` spells this back.
    const registration = await collectModule(async () => {
      test('x', { tags: ['smoke', 'Login Form', 'billing:refunds', 'v2.0'] }, noop);
    });
    expect(registration.tests[0]!.options.tags).toEqual(['smoke', 'Login Form', 'billing:refunds', 'v2.0']);
  });

  it('rejects a timeout a timer cannot wait for', async () => {
    const registration = await collectModule(async () => {
      test('x', { timeout: 2 ** 31 - 1 }, noop);
    });
    expect(registration.tests[0]!.options.timeout).toBe(2 ** 31 - 1);
    await expect(
      collectModule(async () => {
        test('x', { timeout: 2 ** 31 }, noop);
      }),
    ).rejects.toThrow('test options: timeout must be at most 2147483647 milliseconds, got 2147483648');
    await expect(
      collectModule(async () => {
        test.describe('group', { timeout: 3_000_000_000 }, () => {
          test('x', noop);
        });
      }),
    ).rejects.toThrow('describe options: timeout must be at most 2147483647 milliseconds, got 3000000000');
  });

  it('rejects an option key test, describe, or setup does not know, naming the nearest', async () => {
    const register = (declare: () => void) => collectModule(async () => declare());
    await expect(register(() => test('x', { timout: 1000, retry: 2 } as never, noop))).rejects.toThrow(
      'test options has unknown key "timout"; did you mean "timeout"?',
    );
    await expect(register(() => test('x', { retry: 2 } as never, noop))).rejects.toThrow(
      'test options has unknown key "retry"; expected one of timeout, retries, tags, skip, fail, only, platforms, requires, session, agentContext, agent, trace, video',
    );
    await expect(register(() => test.describe('group', { searial: true } as never, () => {}))).rejects.toThrow(
      'describe options has unknown key "searial"; did you mean "serial"?',
    );
    await expect(register(() => test.describe('group', { only: true } as never, () => {}))).rejects.toThrow(
      /describe options has unknown key "only"; expected one of timeout, retries/,
    );
    await expect(register(() => test.setup('login', { sessions: ['admin'], tag: ['auth'] } as never, noop))).rejects.toThrow(
      'setup options has unknown key "tag"; did you mean "tags"?',
    );
    await expect(register(() => test.setup('login', { sessions: ['admin'], skip: true } as never, noop))).rejects.toThrow(
      /^setup options has unknown key "skip"; expected one of timeout, retries, tags, platforms/,
    );
  });

  it('rejects registration outside collection', () => {
    expect(() => test('orphan', noop)).toThrow(/collected by the e2e runner/);
  });

  it('rejects registration after module evaluation (timers, promises)', async () => {
    let late: (() => void) | undefined;
    await collectModule(async () => {
      test('on time', noop);
      late = () => test('too late', noop);
    });
    expect(late!).toThrow(/after module evaluation|collected by the e2e runner/);
  });

  it('describe nests titles and must be synchronous', async () => {
    const registration = await collectModule(async () => {
      test.describe('outer', () => {
        test.describe('inner', () => {
          test('leaf', noop);
        });
      });
    });
    expect(registration.tests[0]!.titlePath).toEqual(['outer', 'inner', 'leaf']);
  });

  it('registers through the top-level describe and hooks as through test.*', async () => {
    const registration = await collectModule(async () => {
      registry.beforeAll(noop);
      registry.describe('outer', { tags: ['smoke'] }, () => {
        registry.beforeEach(noop);
        test('leaf', noop);
        registry.afterEach(noop);
      });
      registry.afterAll(noop);
    });
    expect(registration.tests[0]).toMatchObject({ titlePath: ['outer', 'leaf'], tags: ['smoke'] });
    expect(registration.hooks.map((hook) => [hook.kind, hook.group?.title])).toEqual([
      ['beforeAll', undefined],
      ['beforeEach', 'outer'],
      ['afterEach', 'outer'],
      ['afterAll', undefined],
    ]);
    expect(() => registry.describe('late', () => {})).toThrow(/describe\(\) can only be called while a test module is being collected/);
  });

  it('rejects async describe bodies', async () => {
    await expect(
      collectModule(async () => {
        test.describe('bad', (async () => {}) as never);
      }),
    ).rejects.toThrow(/synchronously/);
  });

  it('records skip and only modes', async () => {
    const registration = await collectModule(async () => {
      test.skip('skipped', noop);
      test.only('focused', noop);
      test('opt-skip', { skip: 'flaky upstream' }, noop);
    });
    expect(registration.tests.map((item) => item.mode)).toEqual(['skip', 'only', 'skip']);
    expect(registration.tests[2]!.options.skip).toBe('flaky upstream');
  });

  it('registers test.skipIf and test.runIf tests skipped or normal by the condition read at the call', async () => {
    const registration = await collectModule(async () => {
      test.skipIf(true)('skipIf true', noop);
      test.skipIf(false)('skipIf false', noop);
      test.runIf(true)('runIf true', noop);
      test.runIf(false)('runIf false', noop);
      test.skipIf('linux')('truthy string', noop);
      test.runIf(0)('falsy number', noop);
      test.skipIf(undefined)('skipIf undefined', noop);
      test.skipIf(0)('skipIf zero', noop);
      test.skipIf('')('skipIf empty string', noop);
      test.runIf('linux')('runIf truthy string', noop);
      test.runIf(undefined)('runIf undefined', noop);
    });
    expect(registration.tests.map((item) => [item.title, item.mode, item.options.skip])).toEqual([
      ['skipIf true', 'skip', true],
      ['skipIf false', 'normal', undefined],
      ['runIf true', 'normal', undefined],
      ['runIf false', 'skip', true],
      ['truthy string', 'skip', true],
      ['falsy number', 'skip', true],
      ['skipIf undefined', 'normal', undefined],
      ['skipIf zero', 'normal', undefined],
      ['skipIf empty string', 'normal', undefined],
      ['runIf truthy string', 'normal', undefined],
      ['runIf undefined', 'skip', true],
    ]);
    expect(() => test.skipIf(true)('outside', noop)).toThrow(/^test\.skipIf\(\) /);
    expect(() => test.runIf(true)('outside', noop)).toThrow(/^test\.runIf\(\) /);
  });

  it('rejects a Promise condition, which would always read as truthy', async () => {
    expect(() => test.skipIf(Promise.resolve(false) as unknown)).toThrow(
      'test.skipIf() got a Promise as its condition; await it before the call',
    );
    expect(() => test.runIf(Promise.resolve(true) as unknown)).toThrow(
      'test.runIf() got a Promise as its condition; await it before the call',
    );
    // oxlint-disable-next-line unicorn/no-thenable -- a thenable that is not a Promise is the case under test
    const thenable = { then: (resolve: (value: boolean) => void) => resolve(false) };
    expect(() => test.skipIf(thenable)).toThrow(
      'test.skipIf() got a Promise as its condition; await it before the call',
    );
  });

  it('keeps the options of a test.skipIf test, its skip reason included', async () => {
    const registration = await collectModule(async () => {
      test.skipIf(true)('tagged', { tags: ['@fs'], timeout: 5000 }, noop);
      test.skipIf(true)('with reason', { skip: 'no inotify on macOS' }, noop);
      test.skipIf(true)('empty reason', { skip: '' }, noop);
      test.skipIf(true)('skip false', { skip: false }, noop);
      test.skipIf(true)('focused', { only: true }, noop);
      test.skipIf(false)('not skipped', { tags: ['@fs'] }, noop);
      test.skipIf(false)('option reason, falsy skipIf', { skip: 'tracked in #42' }, noop);
      test.runIf(true)('option reason, truthy runIf', { skip: 'tracked in #42' }, noop);
      test.skipIf(false)('option true, falsy skipIf', { skip: true }, noop);
      test.runIf(true)('option true, truthy runIf', { skip: true }, noop);
    });
    expect(registration.tests.map((item) => [item.mode, item.options, item.tags])).toEqual([
      ['skip', { tags: ['@fs'], timeout: 5000, skip: true }, ['@fs']],
      ['skip', { skip: 'no inotify on macOS' }, []],
      ['skip', { skip: '' }, []],
      ['skip', { skip: true }, []],
      ['only', { only: true, skip: true }, []],
      ['normal', { tags: ['@fs'] }, ['@fs']],
      ['skip', { skip: 'tracked in #42' }, []],
      ['skip', { skip: 'tracked in #42' }, []],
      ['skip', { skip: true }, []],
      ['skip', { skip: true }, []],
    ]);
    await expect(collectModule(async () => test.skipIf(true)('bad', { retry: 1 } as never, noop))).rejects.toThrow(
      /test options has unknown key "retry"/,
    );
    await expect(collectModule(async () => test.skipIf(true)('no body', {} as never))).rejects.toThrow(
      'test body function is required',
    );
  });

  it('rejects test.skipIf and test.runIf in a serial group whatever the condition', async () => {
    const calls: Array<[string, () => void]> = [
      ['test.skipIf()', () => test.skipIf(true)('member', noop)],
      ['test.skipIf()', () => test.skipIf(false)('member', noop)],
      ['test.runIf()', () => test.runIf(true)('member', noop)],
      ['test.runIf()', () => test.runIf(false)('member', noop)],
    ];
    for (const [api, call] of calls) {
      await expect(
        collectModule(async () => {
          test.describe('unit', { serial: true }, () => {
            test.describe('nested', call);
          });
        }),
      ).rejects.toThrow(`${api} cannot be used inside a serial group, which skips as one unit; set skip on the serial describe instead`);
    }
    const registration = await collectModule(async () => {
      test.describe('plain group', () => {
        test.runIf(true)('member', noop);
      });
    });
    expect(registration.tests.map((item) => item.mode)).toEqual(['normal']);
  });

  it('registers expected failures by test.fail(title, fn) and the fail option, and checks the option', async () => {
    const registration = await collectModule(async () => {
      test.fail('registered', noop);
      test('by option', { fail: 'known gap' }, noop);
    });
    expect(registration.tests.map((item) => [item.mode, item.options.fail])).toEqual([
      ['normal', true],
      ['normal', 'known gap'],
    ]);
    await expect(collectModule(async () => test('bad', { fail: 1 } as never, noop))).rejects.toThrow(
      'test options: fail must be true, false, or a reason string, got 1',
    );
    await expect(collectModule(async () => test.describe('group', { fail: true } as never, () => {}))).rejects.toThrow(/unknown key "fail"/);
    await expect(collectModule(async () => test.setup('login', { sessions: ['admin'], fail: true } as never, noop))).rejects.toThrow(/unknown key "fail"/);
  });

  it('rejects test.fail(condition) outside a test body', async () => {
    expect(() => test.fail(true, 'not here')).toThrow(CollectionError);
    expect(() => test.fail(false)).toThrow(/must be called inside a test body/);
  });

  it('validates titles', async () => {
    await expect(
      collectModule(async () => {
        test('', noop);
      }),
    ).rejects.toThrow(/1 through 512/);
  });

  it('validates retries bounds', async () => {
    await expect(
      collectModule(async () => {
        test('x', { retries: 11 }, noop);
      }),
    ).rejects.toThrow(/0 through 10/);
  });

  it.each(['trace', 'video'] as const)('accepts a %s mode on tests, groups, and setups, and rejects anything else', async (kind) => {
    const registration = await collectModule(async () => {
      test.setup('auth', { sessions: ['a'], [kind]: 'off' }, noop);
      test.describe('group', { [kind]: 'on' }, () => {
        test('x', { [kind]: 'on-all-retries' }, noop);
      });
    });
    expect(registration.tests.map((item) => item.options[kind])).toEqual(['off', 'on-all-retries']);
    const register = (mode: unknown) =>
      collectModule(async () => {
        test('x', { [kind]: mode } as never, noop);
      });
    const modes = 'off, on, retain-on-failure, on-first-retry, on-all-retries';
    await expect(register(true)).rejects.toThrow(`test options: ${kind} must be one of ${modes}, got true`);
    await expect(register('on-failure')).rejects.toThrow('got "on-failure"');
    await expect(
      collectModule(async () => {
        test.describe('group', { [kind]: 'yes' } as never, () => {
          test('x', noop);
        });
      }),
    ).rejects.toThrow(`describe options: ${kind} must be one of ${modes}, got "yes"`);
  });
});

describe('declaration sites from a JavaScriptCore stack', () => {
  const file = path.join(os.tmpdir(), 'declared.e2e.ts');

  /** Collects one test declared in `file` while every stack reads as `frames`, as Bun writes them. */
  async function sourceUnder(frames: readonly string[]): Promise<unknown> {
    const original = Error.prepareStackTrace;
    Error.prepareStackTrace = () => ['Error', ...frames.map((frame) => `    at ${frame}`)].join('\n');
    try {
      return (await collectModule(async () => void test('declared', noop), file)).tests[0]!.source;
    } finally {
      Error.prepareStackTrace = original;
    }
  }

  it('reads a top-level frame without a column', async () => {
    expect(await sourceUnder([`${file}:5`, 'unknown', 'processTicksAndRejections (native:7:39)'])).toEqual({ file, line: 5, column: 1 });
  });

  it("never takes Bun's builtin code for a file", async () => {
    expect(await sourceUnder(['processTicksAndRejections (native:7:39)'])).toBeUndefined();
  });
});

describe('old trace spellings on a test', () => {
  it('name the mode they meant', async () => {
    const register = (trace: unknown) =>
      collectModule(async () => {
        test('x', { trace } as never, noop);
      });
    await expect(register('retries')).rejects.toThrow("test options: trace 'retries' is the old spelling of trace: 'on-all-retries'");
    await expect(register({ record: 'retries' })).rejects.toThrow("trace { record: 'retries' } is the old spelling of trace: 'on-all-retries'");
    await expect(register('all')).rejects.toThrow("trace 'all' is the old spelling of trace: 'on'");
  });
});

describe('setup tests', () => {
  it('requires a static sessions list with valid names', async () => {
    await expect(
      collectModule(async () => {
        test.setup('auth', { sessions: [] }, noop);
      }),
    ).rejects.toThrow(/at least one session/);
    await expect(
      collectModule(async () => {
        test.setup('auth', { sessions: ['bad name!'] }, noop);
      }),
    ).rejects.toThrow(/invalid session name/);
  });

  it('must be top-level', async () => {
    await expect(
      collectModule(async () => {
        test.describe('group', () => {
          test.setup('auth', { sessions: ['a'] }, noop);
        });
      }),
    ).rejects.toThrow(/top-level/);
  });
});

describe('serial groups', () => {
  it('rejects nested serial groups', async () => {
    await expect(
      collectModule(async () => {
        test.describe('outer', { serial: true }, () => {
          test.describe('inner', { serial: true }, () => {
            test('x', noop);
          });
        });
      }),
    ).rejects.toThrow(/nested serial/);
  });

  it.each(['trace', 'video'] as const)('rejects a %s on a describe nested in a serial group, which records as one unit', async (kind) => {
    await expect(
      collectModule(async () => {
        test.describe('unit', { serial: true }, () => {
          test.describe('inner', { [kind]: 'off' }, () => {
            test('x', noop);
          });
        });
      }),
    ).rejects.toThrow(`describe option "${kind}" cannot be set inside a serial group`);
  });

  it('rejects member overrides of unit-owned options', async () => {
    for (const options of [{ retries: 1 }, { trace: 'on' }, { video: 'on' }, { session: 's' }, { skip: true }, { fail: true }, { only: true }]) {
      await expect(
        collectModule(async () => {
          test.describe('unit', { serial: true }, () => {
            test('member', options as never, noop);
          });
        }),
      ).rejects.toThrow(/serial group/);
    }
  });

  it('allows member tags, timeout, and agent context', async () => {
    const registration = await collectModule(async () => {
      test.describe('unit', { serial: true }, () => {
        test('member', { tags: ['a'], timeout: 5000, agentContext: 'ctx' }, noop);
      });
    });
    expect(registration.tests).toHaveLength(1);
  });
});

describe('test.extend', () => {
  const fixture = async (_fixtures: unknown, use: (value: string) => Promise<void>) => {
    await use('value');
  };

  it('without definitions returns the same test object', () => {
    expect(test.extend<{ web: unknown }>()).toBe(test);
  });

  it('returns a new test whose registrations carry the accumulated chain in order', async () => {
    const first = test.extend<{ one: string }>({ one: fixture });
    const second = first.extend<{ two: string }>({ two: fixture });
    expect(first).not.toBe(test);
    expect(second).not.toBe(first);
    const registration = await collectModule(async () => {
      test('plain', noop);
      first('one', noop);
      second('two', noop);
      second.skip('skipped', noop);
      second.only('focused', noop);
      second.setup('auth', { sessions: ['member'] }, noop);
      second.beforeEach(noop);
      second.afterEach(noop);
      first.afterAll(noop);
    });
    const chains = registration.tests.map((item) => item.fixtures.map((definition) => definition.name));
    expect(chains).toEqual([[], ['one'], ['one', 'two'], ['one', 'two'], ['one', 'two'], ['one', 'two']]);
    expect(registration.tests[2]!.fixtures[1]!.fn).toBe(fixture);
    const hookChains = registration.hooks.map((hook) =>
      hook.kind === 'beforeEach' || hook.kind === 'afterEach'
        ? hook.fixtures.map((definition) => definition.name)
        : hook.kind,
    );
    expect(hookChains).toEqual([['one', 'two'], ['one', 'two'], 'afterAll']);
  });

  it('carries the chain through skipIf and runIf on an extended test', async () => {
    const extended = test.extend<{ one: string }>({ one: fixture });
    const registration = await collectModule(async () => {
      extended.skipIf(true)('skipped', noop);
      extended.runIf(true)('runs', noop);
    });
    expect(registration.tests.map((item) => [item.mode, item.fixtures.map((definition) => definition.name)])).toEqual([
      ['skip', ['one']],
      ['normal', ['one']],
    ]);
  });

  it('rejects anything but a plain object of functions', () => {
    for (const definitions of [null, [], 'workspace', new Map()]) {
      expect(() => test.extend(definitions as never)).toThrow(CollectionError);
      expect(() => test.extend(definitions as never)).toThrow(/plain object/);
    }
    expect(() => test.extend({ workspace: 'not a function' } as never)).toThrow(
      /fixture "workspace" must be a function/,
    );
    expect(() => test.extend({ '': fixture } as never)).toThrow(/must not be empty/);
  });

  it('rejects core fixture names and names an earlier extend already defined', () => {
    for (const name of ['agent', 'app', 'screen', 'platform', 'session']) {
      expect(() => test.extend({ [name]: fixture } as never)).toThrow(
        new RegExp(`"${name}" is a core fixture`),
      );
    }
    const extended = test.extend<{ workspace: string }>({ workspace: fixture });
    expect(() => extended.extend({ workspace: fixture } as never)).toThrow(
      /fixture "workspace" is already defined by an earlier test.extend\(\)/,
    );
  });
});

describe('collectFromRegistration', () => {
  it("derives each test's tags from its describe layers and its own, outermost first, each once", async () => {
    const registration = await collectModule(async () => {
      test.describe('outer', { tags: ['area', 'smoke'] }, () => {
        test.describe('inner', { tags: ['inner'] }, () => {
          test('leaf', { tags: ['smoke', 'leaf'] }, noop);
        });
        test('plain', noop);
      });
      test('untagged', noop);
    });
    const collected = collectFromRegistration('/root', '/root/tests/a.e2e.ts', registration);
    expect(collected.tests.map((item) => item.tags)).toEqual([['area', 'smoke', 'inner', 'leaf'], ['area', 'smoke'], []]);
  });

  it('derives stable IDs and detects duplicate title paths', async () => {
    const registration = await collectModule(async () => {
      test('one', noop);
      test.setup('auth', { sessions: ['member'] }, noop);
      test.describe('grp', () => {
        test('two', noop);
      });
    });
    const collected = collectFromRegistration('/root', '/root/tests/a.e2e.ts', registration);
    expect(collected.file).toBe('tests/a.e2e.ts');
    expect(collected.tests.map((item) => item.id)).toEqual([
      'tests/a.e2e.ts::one',
      'setup::tests/a.e2e.ts::auth',
      'tests/a.e2e.ts::grp::two',
    ]);

    const duplicate = await collectModule(async () => {
      test('same', noop);
      test('same', noop);
    });
    expect(() => collectFromRegistration('/root', '/root/tests/b.e2e.ts', duplicate)).toThrow(
      CollectionError,
    );
  });

  it('redacts registered secret values in test and describe titles before ids are derived, and detects a collision after', async () => {
    const value = 'sk_title_9f3Kq2';
    const redact = (title: string) => title.replaceAll(value, '<secret:probe>');
    const registration = await collectModule(async () => {
      test.describe(`suite ${value}`, { serial: true }, () => {
        test(`holds ${value}`, noop);
      });
    }, undefined, redact);
    const collected = collectFromRegistration('/root', '/root/tests/a.e2e.ts', registration);
    const [only] = collected.tests;
    expect(only!.title).toBe('holds <secret:probe>');
    expect(only!.titlePath).toEqual(['suite <secret:probe>', 'holds <secret:probe>']);
    expect(only!.group?.title).toBe('suite <secret:probe>');
    expect(only!.id).toBe('tests/a.e2e.ts::suite%20%3Csecret%3Aprobe%3E::holds%20%3Csecret%3Aprobe%3E');
    expect(only!.serialId).toBe('serial::tests/a.e2e.ts::suite%20%3Csecret%3Aprobe%3E');
    expect(JSON.stringify(collected.tests.map(({ fn: _fn, group: _group, serialRoot: _root, ...rest }) => rest))).not.toContain(value);

    const colliding = await collectModule(async () => {
      test(`token ${value}`, noop);
      test('token <secret:probe>', noop);
    }, undefined, redact);
    expect(() => collectFromRegistration('/root', '/root/tests/b.e2e.ts', colliding)).toThrow(
      'duplicate title path token <secret:probe> in tests/b.e2e.ts',
    );
  });

  it('redacts a title before normalizing it, so a value spelled in decomposed form still matches', async () => {
    const decomposed = 'café-Kq7Zr2';
    const registration = await collectModule(async () => {
      test.describe(`group ${decomposed}`, () => {
        test(`holds ${decomposed}`, noop);
      });
    }, undefined, (title) => title.replaceAll(decomposed, '<secret:probe>'));
    expect(registration.tests[0]!.titlePath).toEqual(['group <secret:probe>', 'holds <secret:probe>']);
  });

  it('checks the title limit again once a marker longer than the value replaces it', async () => {
    const value = 'Kq7Zr2';
    const title = `${'a'.repeat(512 - value.length)}${value}`;
    const redact = (text: string) => text.replaceAll(value, '<secret:probe>');
    await expect(collectModule(async () => test(title, noop), undefined, redact)).rejects.toThrow(
      'title must be 1 through 512 UTF-8 bytes after NFC, got 520 once secret values are redacted',
    );
    await expect(collectModule(async () => test.describe(title, () => undefined), undefined, redact)).rejects.toThrow(
      'once secret values are redacted',
    );
  });

  it('marks serial members with the unit source ID', async () => {
    const registration = await collectModule(async () => {
      test.describe('wizard', { serial: true }, () => {
        test('step 1', noop);
        test('step 2', noop);
      });
    });
    const collected = collectFromRegistration('/root', '/root/tests/wizard.e2e.ts', registration);
    expect(collected.tests[0]!.serialId).toBe('serial::tests/wizard.e2e.ts::wizard');
    expect(collected.tests[1]!.serialId).toBe('serial::tests/wizard.e2e.ts::wizard');
  });

  it('rejects files outside the project root', async () => {
    const registration = await collectModule(async () => {
      test('x', noop);
    });
    expect(() => collectFromRegistration('/root/app', '/elsewhere/b.e2e.ts', registration)).toThrow(
      /outside the project root/,
    );
  });
});
