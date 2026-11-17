/**
 * The asks for a GitHub star: a gold strip under `e2e init`, a line under the
 * update notice, and the gold wordmark after `e2e upgrade`. Each caller prints
 * them only where a person reads a terminal.
 */

import picocolors from 'picocolors';
import { visibleWidth } from '../report/format.ts';
import { REPOSITORY_URL } from './docs-url.ts';
import { wordmarkBanner, type WordmarkStream } from './wordmark.ts';

const ESC = '\u001b';
const SHORT_URL = REPOSITORY_URL.replace(/^https:\/\//u, '');
/** Gold for each wordmark row, top to bottom, warming toward amber. */
const GRADIENT: readonly (readonly [number, number, number])[] = [
  [255, 214, 10],
  [255, 200, 0],
  [255, 186, 0],
  [252, 170, 0],
  [246, 154, 0],
  [238, 138, 0],
];

function styled(env: NodeJS.ProcessEnv): boolean {
  return picocolors.isColorSupported && env['TERM'] !== 'dumb';
}

function truecolor(env: NodeJS.ProcessEnv): boolean {
  return env['COLORTERM'] === 'truecolor' || env['COLORTERM'] === '24bit';
}

/** Styles that follow `env`, not only the environment picocolors read at import. */
function colors(env: NodeJS.ProcessEnv): ReturnType<typeof picocolors.createColors> {
  return picocolors.createColors(styled(env));
}

function rgb(env: NodeJS.ProcessEnv, [r, g, b]: readonly [number, number, number]): (text: string) => string {
  if (!styled(env)) return (text) => text;
  return truecolor(env) ? (text) => `${ESC}[38;2;${r};${g};${b}m${text}${ESC}[39m` : colors(env).yellow;
}

/** Windows' legacy console prints link escapes as text; Windows Terminal sets `WT_SESSION`. */
function hyperlinks(env: NodeJS.ProcessEnv): boolean {
  return styled(env) && (process.platform !== 'win32' || env['WT_SESSION'] !== undefined);
}

/** The repository as `github.com/e2e-inc/e2e`, a clickable link where the terminal supports one. */
function repositoryLink(env: NodeJS.ProcessEnv): string {
  const c = colors(env);
  const text = c.underline(c.cyan(SHORT_URL));
  return hyperlinks(env) ? `${ESC}]8;;${REPOSITORY_URL}${ESC}\\${text}${ESC}]8;;${ESC}\\` : text;
}

/**
 * The strip `e2e init` ends with: one line in a gold box, then a blank line.
 * A terminal too narrow for the box gets the line alone.
 */
export function initStarStrip(columns: number | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const gold = rgb(env, GRADIENT[1]!);
  const c = colors(env);
  const line = `${gold('★')}  ${c.bold("You're all set!")}  Star e2e on GitHub ${c.dim('→')} ${repositoryLink(env)}`;
  const width = visibleWidth(line) + 4;
  if ((columns || 80) < width + 4) return `${line}\n\n`;
  const border = (left: string, right: string): string => `  ${gold(`${left}${'─'.repeat(width)}${right}`)}`;
  return [border('╭', '╮'), `  ${gold('│')}  ${line}  ${gold('│')}`, border('╰', '╯'), '', ''].join('\n');
}

/** The line under the update notice, a blank line above and below it. */
export function updateStarLine(env: NodeJS.ProcessEnv = process.env): string {
  const gold = rgb(env, GRADIENT[1]!);
  const c = colors(env);
  return `\n${gold('★')} ${c.bold('Enjoying e2e?')} Star us on GitHub ${c.dim('→')} ${repositoryLink(env)}\n\n`;
}

/**
 * What `e2e upgrade` ends with once the install worked: the wordmark in gold
 * when the terminal is wide enough for it, then the ask.
 */
export function upgradeCelebration(stream: WordmarkStream, version: string, env: NodeJS.ProcessEnv = process.env): string {
  const logo = wordmarkBanner(stream, (row, index) => rgb(env, GRADIENT[index] ?? GRADIENT.at(-1)!)(row));
  const gold = rgb(env, GRADIENT[1]!);
  const c = colors(env);
  return [
    '',
    ...(logo === '' ? [] : [logo]),
    `${gold('★')}  ${c.bold(`You're on e2e ${version}.`)} Enjoying it? Star us on GitHub ${c.dim('→')} ${repositoryLink(env)}`,
    '',
    '',
  ].join('\n');
}
