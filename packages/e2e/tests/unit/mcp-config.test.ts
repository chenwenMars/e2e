import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MCP_LOCATIONS } from '../../src/cli/init/choices.ts';
import { findRegisteredMcpFiles, planMcpRegistration } from '../../src/cli/init/mcp-config.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-mcp-config-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Whether this host lets the tests create file symlinks; Windows needs a privilege for them. */
const symlinks = ((): boolean => {
  const probe = mkdtempSync(path.join(os.tmpdir(), 'e2e-mcp-symlink-'));
  try {
    writeFileSync(path.join(probe, 'file'), '');
    symlinkSync(path.join(probe, 'file'), path.join(probe, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

// A junction works on Windows without the symlink privilege, and a symlink on POSIX; POSIX needs the privilege.
const canLinkDir = process.platform === 'win32' || symlinks;

const ENTRY = { command: 'npx', args: ['e2e', 'mcp'] };

const NPM = { manager: 'npm', yarnBerry: false } as const;

describe('planMcpRegistration', () => {
  it('creates each missing file with the e2e server entry', () => {
    const { registrations } = planMcpRegistration(dir, MCP_LOCATIONS.map((location) => location.file), NPM);
    expect(registrations.map((plan) => [plan.relative, plan.existing])).toEqual([
      ['.mcp.json', false],
      ['.cursor/mcp.json', false],
      ['.codex/config.toml', false],
    ]);
    expect(JSON.parse(registrations[0]!.content)).toEqual({ mcpServers: { e2e: ENTRY } });
    expect(registrations[0]!.content.endsWith('\n')).toBe(true);
  });

  it.each([
    ['npm', false, 'npx', ['e2e', 'mcp']],
    ['pnpm', false, 'pnpm', ['exec', 'e2e', 'mcp']],
    // Never `yarn run`: it would run a package.json script named e2e instead of the binary.
    ['yarn', false, 'yarn', ['--silent', 'exec', '--', 'e2e', 'mcp']],
    ['yarn', true, 'yarn', ['exec', 'e2e', 'mcp']],
    ['bun', false, 'bunx', ['e2e', 'mcp']],
  ] as const)("starts the server with the project's own manager: %s (Yarn 2 or later: %s)", (manager, yarnBerry, command, args) => {
    const [json, toml] = planMcpRegistration(dir, ['.mcp.json', '.codex/config.toml'], { manager, yarnBerry }).registrations;
    expect(JSON.parse(json!.content)).toEqual({ mcpServers: { e2e: { command, args } } });
    expect(toml!.content).toBe(`[mcp_servers.e2e]\nargs = ${JSON.stringify(args)}\ncommand = ${JSON.stringify(command)}\n`);
  });

  it("moves an npx entry to the project's manager, keeping its other settings", () => {
    writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { e2e: { command: 'npx', args: ['-y', 'e2e', 'mcp'], env: { APP_ENV: 'staging' } } } }));
    mkdirSync(path.join(dir, '.codex'));
    writeFileSync(path.join(dir, '.codex/config.toml'), '# Keep this comment\n[mcp_servers.e2e]\ncommand = "npx"\nargs = ["e2e", "mcp"]\nstartup_timeout_sec = 30\n');
    const [json, toml] = planMcpRegistration(dir, ['.mcp.json', '.codex/config.toml'], { manager: 'pnpm', yarnBerry: false }).registrations;
    expect(json!.existing).toBe(true);
    expect(JSON.parse(json!.content)).toEqual({ mcpServers: { e2e: { command: 'pnpm', args: ['exec', 'e2e', 'mcp'], env: { APP_ENV: 'staging' } } } });
    expect(toml!.content).toBe('# Keep this comment\n[mcp_servers.e2e]\ncommand = "pnpm"\nargs = ["exec","e2e","mcp"]\nstartup_timeout_sec = 30\n');
  });

  it('keeps what an entry passes to e2e mcp, and drops what it passed to its old launcher', () => {
    writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { e2e: { command: 'npx', args: ['-y', 'e2e', 'mcp', '--target', 'web', '--headed'] } } }));
    mkdirSync(path.join(dir, '.codex'));
    writeFileSync(path.join(dir, '.codex/config.toml'), '[mcp_servers.e2e]\ncommand = "npx"\nargs = ["e2e", "mcp", "--target", "web"]\n');
    const [json, toml] = planMcpRegistration(dir, ['.mcp.json', '.codex/config.toml'], { manager: 'pnpm', yarnBerry: false }).registrations;
    expect(JSON.parse(json!.content)).toEqual({ mcpServers: { e2e: { command: 'pnpm', args: ['exec', 'e2e', 'mcp', '--target', 'web', '--headed'] } } });
    expect(toml!.content).toBe('[mcp_servers.e2e]\ncommand = "pnpm"\nargs = ["exec","e2e","mcp","--target","web"]\n');
    writeFileSync(path.join(dir, '.mcp.json'), json!.content);
    expect(planMcpRegistration(dir, ['.mcp.json'], { manager: 'pnpm', yarnBerry: false }).registrations).toEqual([]);
  });

  it.each([
    ['a versioned package', ['-y', 'e2e@0.25.0', 'mcp', '--target', 'web'], ['exec', 'e2e', 'mcp', '--target', 'web']],
    ['a launcher init does not write', ['node_modules/e2e/dist/cli/bin.js', 'mcp', '--headed'], ['exec', 'e2e', 'mcp']],
    ['another package that takes an mcp argument', ['-y', 'other-e2e', 'mcp', '--x'], ['exec', 'e2e', 'mcp']],
  ] as const)('reads the arguments to keep after the e2e package and mcp: %s', (_name, existing, args) => {
    writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { e2e: { command: 'npx', args: existing } } }));
    const [json] = planMcpRegistration(dir, ['.mcp.json'], { manager: 'pnpm', yarnBerry: false }).registrations;
    expect(JSON.parse(json!.content)).toEqual({ mcpServers: { e2e: { command: 'pnpm', args } } });
  });

  it('registers Codex in its project TOML config and discovers it on the next run', () => {
    const [plan] = planMcpRegistration(dir, ['.codex/config.toml'], NPM).registrations;
    expect(plan!.content).toContain('[mcp_servers.e2e]');
    expect(plan!.content).toContain('command = "npx"');
    expect(plan!.content).toContain('"e2e"');
    mkdirSync(path.join(dir, '.codex'));
    writeFileSync(path.join(dir, '.codex/config.toml'), plan!.content);
    expect(findRegisteredMcpFiles(dir)).toEqual(['.codex/config.toml']);
    expect(planMcpRegistration(dir, ['.codex/config.toml'], NPM).registrations).toEqual([]);
  });

  it.each([
    '# My settings\nmodel = "custom"\n',
    '# My settings\n[mcp_servers.other]\ncommand = "other"\n',
    '# My settings\n[mcp_servers."e2e"] # server\ncommand = "e2e" # launch\nargs = [\n  "e2e",\n  "mcp",\n]\nenabled = false\n[mcp_servers.e2e.env]\nAPP_ENV = "staging"\n',
    '# My settings\n[mcp_servers]\ne2e.command = "e2e"\ne2e.args = ["e2e", "mcp"]\n',
    '# My settings\nmcp_servers = { e2e = { command = "e2e", env = { APP_ENV = "staging" } }, other = { command = "other" } }\n',
    '# My settings\nmcp_servers.e2e.env.APP_ENV = "staging"\n',
    '# My settings\n[mcp_servers.e2e.env]\nAPP_ENV = "staging"\n',
    '# My settings\r\n[mcp_servers.e2e]\r\ncommand = "e2e" # launch\r\n',
  ])('preserves Codex settings and comments when repairing or adding a server: %s', (original) => {
    mkdirSync(path.join(dir, '.codex'));
    writeFileSync(path.join(dir, '.codex/config.toml'), original);
    const [plan] = planMcpRegistration(dir, ['.codex/config.toml'], NPM).registrations;
    const before = getStaticTOMLValue(parseTOML(original));
    const after = getStaticTOMLValue(parseTOML(plan!.content));
    const servers = before.mcp_servers as Record<string, object> | undefined;
    expect(after).toEqual({ ...before, mcp_servers: { ...servers, e2e: { ...servers?.e2e, ...ENTRY } } });
    for (const setting of ['APP_ENV = "staging"', 'command = "other"', 'enabled = false', '# My settings', '# server', '# launch']) {
      if (original.includes(setting)) expect(plan!.content).toContain(setting);
    }
    expect(plan!.existing).toBe(true);
    writeFileSync(path.join(dir, '.codex/config.toml'), plan!.content);
    expect(planMcpRegistration(dir, ['.codex/config.toml'], NPM).registrations).toEqual([]);
  });

  it('leaves a current Codex registration byte-for-byte unchanged', () => {
    const original = '# Keep this comment\n[mcp_servers.e2e]\nargs = [\'e2e\', \'mcp\']\ncommand = \'npx\'\nstartup_timeout_sec = 30\n';
    mkdirSync(path.join(dir, '.codex'));
    writeFileSync(path.join(dir, '.codex/config.toml'), original);
    expect(planMcpRegistration(dir, ['.codex/config.toml'], NPM).registrations).toEqual([]);
    expect(readFileSync(path.join(dir, '.codex/config.toml'), 'utf8')).toBe(original);
  });

  it('refuses invalid Codex TOML without changing it', () => {
    const original = '[mcp_servers.e2e\ncommand = "node"\n';
    mkdirSync(path.join(dir, '.codex'));
    writeFileSync(path.join(dir, '.codex/config.toml'), original);
    expect(() => planMcpRegistration(dir, ['.codex/config.toml'], NPM)).toThrow(/is not valid TOML/);
    expect(findRegisteredMcpFiles(dir)).toEqual([]);
    expect(readFileSync(path.join(dir, '.codex/config.toml'), 'utf8')).toBe(original);
  });

  it.each(['mcp_servers = []\n', 'mcp_servers.e2e = []\n', '[mcp_servers.e2e.command]\ninvalid = true\n'])(
    'refuses an invalid Codex server structure without writing broken TOML: %s',
    (original) => {
      mkdirSync(path.join(dir, '.codex'));
      writeFileSync(path.join(dir, '.codex/config.toml'), original);
      expect(() => planMcpRegistration(dir, ['.codex/config.toml'], NPM)).toThrow();
      expect(readFileSync(path.join(dir, '.codex/config.toml'), 'utf8')).toBe(original);
    },
  );

  it('merges into an existing file, keeping other servers, keys, and indentation', () => {
    const existing = '{\n    "mcpServers": {\n        "figma": { "command": "figma-mcp" }\n    },\n    "other": true\n}\n';
    writeFileSync(path.join(dir, '.mcp.json'), existing);
    const [plan] = planMcpRegistration(dir, ['.mcp.json'], NPM).registrations;
    expect(plan!.existing).toBe(true);
    expect(JSON.parse(plan!.content)).toEqual({ mcpServers: { figma: { command: 'figma-mcp' }, e2e: ENTRY }, other: true });
    expect(plan!.content).toContain('\n    "mcpServers"');
  });

  it('plans nothing for a file that already registers the same entry, and finds it', () => {
    mkdirSync(path.join(dir, '.cursor'));
    writeFileSync(path.join(dir, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { e2e: ENTRY } }));
    expect(planMcpRegistration(dir, ['.cursor/mcp.json'], NPM).registrations).toEqual([]);
    expect(findRegisteredMcpFiles(dir)).toEqual(['.cursor/mcp.json']);
    // A stale entry is repaired, not treated as registered.
    writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { e2e: { command: 'e2e', args: ['mcp'] } } }));
    expect(planMcpRegistration(dir, ['.mcp.json'], NPM).registrations).toHaveLength(1);
    expect(findRegisteredMcpFiles(dir)).toEqual(['.mcp.json', '.cursor/mcp.json']);
  });

  it('keeps extra settings on an already current server without rewriting the file', () => {
    const entry = { ...ENTRY, env: { APP_ENV: 'staging' }, timeout: 30_000 };
    const original = JSON.stringify({ mcpServers: { e2e: entry } }, null, 4) + '\n';
    writeFileSync(path.join(dir, '.mcp.json'), original);
    expect(planMcpRegistration(dir, ['.mcp.json'], NPM).registrations).toEqual([]);
    expect(readFileSync(path.join(dir, '.mcp.json'), 'utf8')).toBe(original);
  });

  it('repairs a stale launch command without dropping environment or client settings', () => {
    writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({
      mcpServers: { e2e: { command: 'e2e', args: ['mcp'], env: { APP_ENV: 'staging' }, timeout: 30_000 } },
      other: true,
    }));
    const [plan] = planMcpRegistration(dir, ['.mcp.json'], NPM).registrations;
    expect(JSON.parse(plan!.content)).toEqual({ mcpServers: { e2e: { ...ENTRY, env: { APP_ENV: 'staging' }, timeout: 30_000 } }, other: true });
  });

  it('refuses to overwrite a file that is not JSON', () => {
    writeFileSync(path.join(dir, '.mcp.json'), '{ not json');
    expect(() => planMcpRegistration(dir, ['.mcp.json'], NPM)).toThrow(/is not valid JSON/);
    expect(findRegisteredMcpFiles(dir)).toEqual([]);
    expect(readFileSync(path.join(dir, '.mcp.json'), 'utf8')).toBe('{ not json');
  });

  it.skipIf(!canLinkDir).each(['.cursor', '.codex'])('never plans a write through a linked %s directory, and reports the link', (directory) => {
    // A junction works on Windows without the symlink privilege, and a symlink on POSIX.
    const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'e2e-mcp-elsewhere-'));
    try {
      // The target already registers e2e: discovery must not follow the link and call it registered.
      const file = directory === '.cursor' ? 'mcp.json' : 'config.toml';
      writeFileSync(path.join(elsewhere, file), file.endsWith('.json') ? JSON.stringify({ mcpServers: { e2e: ENTRY } }) : '[mcp_servers.e2e]\ncommand = "node"\n');
      symlinkSync(elsewhere, path.join(dir, directory), 'junction');
      const { registrations, links } = planMcpRegistration(dir, [`${directory}/${file}`], NPM);
      expect(registrations).toEqual([]);
      expect(links).toEqual([{ relative: directory, target: realpathSync(elsewhere) }]);
      // Nothing was written through the link, and it is not counted as registered.
      expect(readdirSync(elsewhere)).toEqual([file]);
      expect(findRegisteredMcpFiles(dir)).toEqual([]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it.skipIf(!symlinks)('never plans a write through a linked file, and reports the link', () => {
    const elsewhere = mkdtempSync(path.join(os.tmpdir(), 'e2e-mcp-elsewhere-'));
    try {
      const target = path.join(elsewhere, 'real.json');
      // The target already registers e2e: discovery must not follow the link and call it registered.
      const original = JSON.stringify({ mcpServers: { e2e: ENTRY, other: { command: 'x' } } });
      writeFileSync(target, original);
      symlinkSync(target, path.join(dir, '.mcp.json'), 'file');
      const { registrations, links } = planMcpRegistration(dir, ['.mcp.json'], NPM);
      expect(registrations).toEqual([]);
      expect(links).toEqual([{ relative: '.mcp.json', target: realpathSync(target) }]);
      // The target is untouched: nothing was read or written through the link, and it is not counted as registered.
      expect(readFileSync(target, 'utf8')).toBe(original);
      expect(lstatSync(path.join(dir, '.mcp.json')).isSymbolicLink()).toBe(true);
      expect(findRegisteredMcpFiles(dir)).toEqual([]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
