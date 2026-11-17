/**
 * The CI services and MCP config files `e2e init` offers, kept apart from
 * `ci.ts` and `mcp-config.ts`: the CLI adds the init flags at every start, and
 * those modules load the YAML and TOML parsers that only init's writes need.
 */

/** The CI services init writes a pipeline for, in the order the flag and the prompt list them. */
export const CI_IDS = ['github-actions', 'gitlab'] as const;

export type CiId = (typeof CI_IDS)[number];
export type CiChoice = CiId | 'none';

interface McpLocation {
  /** Project-relative config file with `/` separators. */
  readonly file: string;
  /** The agents that read it, shown as the prompt hint. */
  readonly hint: string;
}

/** Where project-scoped MCP servers are declared. */
export const MCP_LOCATIONS = [
  { file: '.mcp.json', hint: 'Claude Code' },
  { file: '.cursor/mcp.json', hint: 'Cursor' },
  { file: '.codex/config.toml', hint: 'Codex' },
] as const satisfies readonly McpLocation[];
