/**
 * The `e2e init` step that registers the `e2e mcp` server with the coding
 * agents that read a project-level MCP config file. JSON clients use a
 * `mcpServers` map; Codex uses TOML. Every other server is left
 * exactly as it was. A file reached through a symlink, or under a linked
 * directory, is never read or written through: init reports the link and
 * skips it.
 */

import { existsSync, lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { execArgv, type ProjectManager } from '../../internal/package-manager.ts';
import { isPlainObject } from '@e2e-dev/core/lib/internal/options';
import { realpathOfExisting } from '@e2e-dev/core/lib/internal/paths';
import { MCP_LOCATIONS } from './choices.ts';
import { readCodexConfig, updateCodexConfig } from './codex-config.ts';

const MCP_SERVER_NAME = 'e2e';

type McpProject = Pick<ProjectManager, 'manager' | 'yarnBerry'>;

export interface McpRegistration {
  /** Project-relative file, e.g. `.mcp.json`. */
  readonly relative: string;
  /** True when the file already existed, so the write is an update. */
  readonly existing: boolean;
  readonly absolute: string;
  readonly content: string;
}

/** A symlink on the way to a config file, each once: a file or a directory init will not write through. */
export interface McpLink {
  /** Project-relative path of the link with `/` separators, e.g. `.cursor`. */
  readonly relative: string;
  /** Absolute path the link leads to; the path as written when it dangles. */
  readonly target: string;
}

/** What init plans for the chosen config files: the writes, and the links it leaves alone. */
export interface McpPlan {
  readonly registrations: readonly McpRegistration[];
  readonly links: readonly McpLink[];
}

interface McpConfigDocument {
  mcpServers?: Record<string, unknown>;
  mcp_servers?: Record<string, unknown>;
  [key: string]: unknown;
}

function readDocument(absolute: string): McpConfigDocument | undefined {
  if (!existsSync(absolute)) return undefined;
  const text = readFileSync(absolute, 'utf8');
  let parsed: unknown;
  const toml = absolute.endsWith('.toml');
  try {
    parsed = toml ? readCodexConfig(text) : text.trim() === '' ? {} : JSON.parse(text);
  } catch (cause) {
    throw new Error(`${absolute} is not valid ${toml ? 'TOML' : 'JSON'}; fix it or remove it before registering the MCP server`, { cause });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${absolute} must hold a JSON object with a "mcpServers" map`);
  }
  return parsed as McpConfigDocument;
}

/**
 * The first symlink between the project root and `target`, or undefined when
 * every existing component is a plain entry. A component past the link is not
 * inspected: it lives wherever the link points.
 */
export function linkOnPath(cwd: string, target: string): McpLink | undefined {
  let current = cwd;
  for (const segment of path.relative(cwd, target).split(path.sep)) {
    current = path.join(current, segment);
    let entry;
    try {
      entry = lstatSync(current);
    } catch {
      return undefined;
    }
    if (entry.isSymbolicLink()) {
      return { relative: path.relative(cwd, current).split(path.sep).join('/'), target: realpathOfExisting(current) };
    }
  }
  return undefined;
}

/** Known config files that already register the e2e server. A file reached through a symlink is not read. */
export function findRegisteredMcpFiles(cwd: string): string[] {
  return MCP_LOCATIONS.map((location) => location.file).filter((file) => {
    if (linkOnPath(cwd, path.join(cwd, file)) !== undefined) return false;
    try {
      const document = readDocument(path.join(cwd, file));
      const servers = file.endsWith('.toml') ? document?.mcp_servers : document?.mcpServers;
      return typeof servers === 'object' && servers !== null && MCP_SERVER_NAME in servers;
    } catch {
      return false;
    }
  });
}

/**
 * How a client starts the server from the project with e2e installed: through
 * the project's own package manager. `npx` exits before the handshake in a
 * project whose `devEngines` pins another manager, and finds no binary in a
 * Yarn Plug'n'Play install; a Bun project may have no Node.js for it at all.
 */
function mcpLaunch(project: McpProject, existing: unknown): { readonly command: string; readonly args: readonly string[] } {
  const { command, args } = execArgv(project);
  return { command, args: [...args, 'e2e', 'mcp', ...serverArguments(existing)] };
}

/** What an existing entry passes to `e2e mcp` itself, after a launcher that names the package, as `npx -y e2e@0.25.0 mcp` does. */
function serverArguments(existing: unknown): readonly string[] {
  const args: unknown = isPlainObject(existing) ? existing['args'] : undefined;
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) return [];
  const server = args.findIndex((arg, index) => /^e2e(?:@.+)?$/u.test(arg) && args[index + 1] === 'mcp');
  return server === -1 ? [] : args.slice(server + 2);
}

/**
 * Plans the writes for the given files. A file without the entry gets it
 * merged in; one whose entry already matches needs nothing and is left out.
 * Extra settings on the e2e entry, the arguments it passes to `e2e mcp`,
 * other servers, other keys, and the file's indentation are preserved. A file reached through a symlink is never read;
 * it is returned among `links` for the caller to report and skip.
 */
export function planMcpRegistration(cwd: string, files: readonly string[], project: McpProject): McpPlan {
  const registrations: McpRegistration[] = [];
  const links: McpLink[] = [];
  for (const file of files) {
    const link = linkOnPath(cwd, path.join(cwd, file));
    if (link !== undefined) {
      links.push(link);
      continue;
    }
    const absolute = path.join(cwd, file);
    const document = readDocument(absolute) ?? {};
    const serverKey = file.endsWith('.toml') ? 'mcp_servers' : 'mcpServers';
    const servers =
      typeof document[serverKey] === 'object' && document[serverKey] !== null && !Array.isArray(document[serverKey])
        ? document[serverKey]
        : {};
    const existing = servers[MCP_SERVER_NAME];
    const launch = mcpLaunch(project, existing);
    const entry = isPlainObject(existing) ? { ...existing, ...launch } : launch;
    if (JSON.stringify(existing) === JSON.stringify(entry)) continue;
    const merged: McpConfigDocument = { ...document, mcpServers: { ...servers, [MCP_SERVER_NAME]: entry } };
    const original = existsSync(absolute) ? readFileSync(absolute, 'utf8') : undefined;
    const indent = original?.match(/\n([\t ]+)"/)?.[1] ?? '  ';
    registrations.push({
      relative: file,
      existing: original !== undefined,
      absolute,
      content: file.endsWith('.toml') ? updateCodexConfig(original ?? '', launch) : `${JSON.stringify(merged, null, indent)}\n`,
    });
  }
  return { registrations, links };
}
