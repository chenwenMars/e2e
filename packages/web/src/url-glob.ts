/**
 * The web engine's one URL pattern grammar, Playwright's. `browser.waitForURL`,
 * `route`, `unroute`, `waitForResponse`, and `waitForRequest` read every string as a URL glob,
 * so one with no wildcard matches that URL exactly, and a RegExp against the
 * full URL. `expect(browser).toHaveURL` compares a string exactly
 * (`urlMatches` in core): Playwright's `toHaveURL` never reads a glob, so only
 * these read one.
 */

import { TestError, type TextPattern } from '@e2e-dev/core/engine';

/** Schemes whose URLs Playwright never resolves against a base, so a glob that starts with one stays as written. */
const UNRESOLVED_GLOB_SCHEMES = ['about:', 'data:', 'chrome:', 'edge:', 'file:'];

/** A URL pattern compiled once against the base URL. */
export interface UrlPattern {
  /** Whether a URL matches the pattern. */
  readonly matches: (url: string) => boolean;
  /** The pattern as a failed wait prints it: a string resolved against the base, a RegExp as written. */
  readonly label: string;
}

/**
 * Compiles a `waitForURL`, `route`, `unroute`, `waitForResponse`, or `waitForRequest`
 * string pattern in Playwright's URL glob grammar. The empty string matches
 * any URL, and a RegExp tests the full URL. A string with no `*`, `{`,
 * `}`, or `\` matches the one URL it resolves to. `base` is read only for a
 * string that needs it, so a target with no app URL takes every other pattern.
 * A glob that nests a `{` or leaves one unmatched is `INVALID_ARGUMENT` here,
 * before it is resolved or anything is matched.
 */
export function urlPattern(expected: TextPattern, base: () => string): UrlPattern {
  if (expected.kind === 'regexp') {
    return {
      matches: (url) => new RegExp(expected.source, expected.flags).test(serialized(url)),
      label: String(new RegExp(expected.source, expected.flags)),
    };
  }
  if (expected.value === '') return { matches: () => true, label: '' };
  // Refuse a bad `{` in the glob as written, before resolving: `..` can drop the segment that holds it (`/{bad/../x`).
  urlGlobSource(expected.value);
  if (!/[*{}\\]/.test(expected.value)) {
    // The URL parser normalizes the whole string, query included, as it does the browser's URL, so the two compare as they are.
    const baseHref = baseFor(expected.value, base);
    const exact = URL.canParse(expected.value, baseHref) ? new URL(expected.value, baseHref).href : expected.value;
    return { matches: (url) => serialized(url) === exact, label: exact };
  }
  const glob = resolveUrlGlob(expected.value, base);
  const pattern = new RegExp(urlGlobSource(glob));
  return { matches: (url) => pattern.test(serialized(url)), label: glob };
}

/**
 * The expected URL as `toHaveURL` compares it: a string resolved against the
 * base, the way `urlMatches` resolves it, so it reads beside the absolute
 * observed URL. A string that does not parse, and a RegExp, print as written.
 */
export function describeExpectedUrl(expected: string | RegExp, baseHref: string): string {
  if (typeof expected !== 'string') return String(expected);
  try {
    return new URL(expected, baseHref).href;
  } catch {
    return expected;
  }
}

/**
 * Whether a glob's first segment is in a scheme's place: it ends in `:` and
 * holds no `?` or `#`, so `login?next=https:` is a relative path whose query
 * holds a URL.
 */
function inSchemePlace(segment: string): boolean {
  return segment.endsWith(':') && !/[?#]/.test(segment);
}

/** Whether a scheme segment is a pattern rather than a scheme: it holds a `*` or a `{`, as Playwright reads it. */
function isSchemePattern(segment: string): boolean {
  return segment.includes('*') || segment.includes('{');
}

/** The current URL as `urlMatches` compares it: serialized by the URL parser, else as given. */
function serialized(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

/** Escapes one character for literal use inside a regexp source. */
function escapeRegexpChar(ch: string): string {
  return /[a-zA-Z0-9_-]/.test(ch) ? ch : `\\${ch}`;
}

// A glob alternative can cross a delimiter. Check the actual URL component
// only after seeing the corresponding percent-encoded bytes.
const URL_PATH = /[a-z][a-z0-9+.-]*:(?:\/\/[^/?#]*\/|\/(?!\/))[^?#]*/.source;
const URL_QUERY = /[^?#]*\?[^#]*/.source;
const URL_FRAGMENT = /[^#]*#[\s\S]*/.source;
const SPECIAL_QUERY = /(?:https?|wss?|ftp|file):[^?#]*\?[^#]*/.source;

function encodedLiteral(character: string, component: string): string {
  const encoded = character === "'" ? '%27' : encodeURIComponent(character);
  return `(?:${escapeRegexpChar(character)}|(?=${encoded})(?<=^(?:${component}))${encoded})`;
}

const PATH_QUERY_FRAGMENT = [URL_PATH, URL_QUERY, URL_FRAGMENT].join('|');
const ENCODED_LITERALS = new Map([
  ["'", encodedLiteral("'", SPECIAL_QUERY)],
  ['`', encodedLiteral('`', [URL_PATH, URL_FRAGMENT].join('|'))],
  ['"', encodedLiteral('"', PATH_QUERY_FRAGMENT)],
  ['<', encodedLiteral('<', PATH_QUERY_FRAGMENT)],
  ['>', encodedLiteral('>', PATH_QUERY_FRAGMENT)],
  ['^', encodedLiteral('^', URL_PATH)],
  ['{', encodedLiteral('{', URL_PATH)],
  ['}', encodedLiteral('}', URL_PATH)],
]);

/**
 * One literal glob character as a regexp source. Printable punctuation that
 * the browser encodes follows the rules of its URL component. Other printable
 * ASCII stays literal, and non-ASCII text and spaces match their encoding.
 */
function literalSource(ch: string): string {
  const spelling = ENCODED_LITERALS.get(ch);
  if (spelling !== undefined) return spelling;
  if (/^[\x21-\x7e]$/.test(ch)) return escapeRegexpChar(ch);
  let encoded: string;
  try {
    encoded = encodeURIComponent(ch);
  } catch {
    return escapeRegexpChar(ch);
  }
  return [...encoded].map(escapeRegexpChar).join('');
}

/**
 * The base a string resolves against, read only when the string needs one.
 * A real or globbed scheme and a full URL stand alone, while `a_b:/x` and
 * `login?next=https://...` are relative. `http:/x`, `http:x`, and a globbed
 * `http{,s}:/x` are relative to a base of that scheme, and the full URLs they
 * parse to on a target with no app URL.
 */
function baseFor(glob: string, base: () => string): string | undefined {
  const first = glob.split('/', 1)[0]!;
  const noAuthority = /^(?:https?|wss?|ftp):(?!\/\/)/i.test(glob)
    || (inSchemePlace(first) && isSchemePattern(first) && !glob.startsWith(`${first}//`));
  if (noAuthority) {
    try {
      return base();
    } catch {
      return undefined;
    }
  }
  const scheme = inSchemePlace(first) && (/^[a-z][a-z0-9+.-]*:$/i.test(first) || isSchemePattern(first));
  return scheme || URL.canParse(glob) ? undefined : base();
}

const COMPONENT_PUNCTUATION = /['`"<>^]/g;

/** Find a punctuation-bearing authority using the URL parser's slash and base rules. */
function authoritySegment(segments: readonly string[], baseHref: string | undefined, tag: string): number {
  // oxlint-disable-next-line no-control-regex -- the URL parser strips these characters at the start of its input
  const first = segments[0]!.replace(/^[\x00-\x20]+|[\t\n\r]/g, '');
  const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(first)?.[0] ?? '';
  const index = segments.findIndex((segment, segmentIndex) => segmentIndex === 0 ? first !== scheme : segment.replace(/[\t\n\r]/g, '') !== '');
  if (index < 0 || segments[index]!.search(COMPONENT_PUNCTUATION) < 0) return -1;
  const prefix = index === 0 ? scheme : `${segments.slice(0, index).join('/')}/`;
  const host = `${tag}authority`;
  return URL.parse(prefix + host, baseHref)?.hostname === host ? index : -1;
}

/**
 * Resolves a relative URL glob against the base URL, as Playwright's
 * `resolveGlobBase` does: each path segment that holds a glob character is
 * swapped for a placeholder the URL parser leaves alone, the rest resolves,
 * and the segments go back, lowercased where they landed in the origin (the
 * scheme and host match in any case). Unlike Playwright, which hides a `#`
 * in a placeholder and so lets a `..` after it eat a path segment, a fragment
 * is held behind its `#` like a query. A glob that starts with `*` matches any
 * origin and stays as written; so does one that starts with an unresolved
 * scheme, or does not parse against the base.
 */
function resolveUrlGlob(glob: string, base: () => string): string {
  if (glob.startsWith('*')) return glob;
  const baseHref = baseFor(glob, base);
  if (UNRESOLVED_GLOB_SCHEMES.some((scheme) => glob.startsWith(scheme))) return glob;
  const segments = glob.split('/');
  const first = segments[0]!;
  const schemeGlob = inSchemePlace(first) && isSchemePattern(first) ? first.toLowerCase() : undefined;
  if (schemeGlob !== undefined) segments[0] = 'http:';
  // The URL parser can create marker text, for example by decoding a hostname.
  const normalizedGlob = URL.parse(segments.join('/'), baseHref)?.href;
  const normalizedBase = baseHref === undefined ? undefined : URL.parse(baseHref)?.href;
  let tag = '$_';
  while ([glob, baseHref, normalizedGlob, normalizedBase].some((input) => input?.includes(tag))) tag += '_';
  const authority = authoritySegment(segments, baseHref, tag);
  const originals = new Map<string, string>();
  const hold = (original: string): string => {
    if (original === '') return '';
    // A marker ends without the leading '$', so adjacent input cannot start a marker inside it.
    const placeholder = `${tag}${originals.size}z`;
    originals.set(placeholder, original);
    return placeholder;
  };
  const relative = segments.map((segment, index) => {
    if (segment === '.' || segment === '..' || segment === '') return segment;
    if (index === 0 && inSchemePlace(segment)) return segment;
    if (!/[*?{}\\]/.test(segment)) {
      if (index === authority) return segment;
      // A delimiter in an earlier alternative does not determine the actual
      // component of a literal in this segment. Preserve its spelling.
      return segment.replace(COMPONENT_PUNCTUATION, hold);
    }
    // The query or fragment is held behind its own `?` or `#`, so the URL parser still sees where the path ends
    // and a later `..` stays in the query or fragment instead of eating a path segment.
    const end = segment.search(/[?#]/);
    if (end === -1) return hold(segment);
    const delimiter = segment[end]!;
    return hold(segment.slice(0, end)) + delimiter + hold(segment.slice(end + 1));
  }).join('/');
  const url = URL.parse(relative, baseHref);
  if (url === null) return glob;
  const resolved = url.href.replace(new RegExp(`\\${tag}[0-9]+z`, 'g'), (placeholder) => {
    const original = originals.get(placeholder);
    if (original === undefined) return placeholder;
    return url.origin.includes(placeholder) ? original.toLowerCase() : original;
  });
  return schemeGlob === undefined ? resolved : schemeGlob + resolved.slice(url.protocol.length);
}

/**
 * Compiles a URL glob to a regexp source matching the whole URL, in
 * Playwright's grammar: `*` matches within one path segment, `**` across `/`
 * (a `**` segment may also match none), `{a,b}` matches either, and `\`
 * escapes the next character. `?` and everything else is literal, so a query
 * string reads as written, with literals encoded by `literalSource`. A nested
 * or unbalanced `{` is `INVALID_ARGUMENT`.
 */
function urlGlobSource(glob: string): string {
  const invalid = (problem: string): TestError =>
    new TestError('INVALID_ARGUMENT', `URL glob ${JSON.stringify(glob)} ${problem}`);
  /** The whole character (code point) at `index`, so an astral one is encoded as one. */
  const charAt = (index: number): string => String.fromCodePoint(glob.codePointAt(index)!);
  let source = '^';
  let inGroup = false;
  for (let i = 0; i < glob.length; i += 1) {
    const ch = charAt(i);
    if (ch === '\\' && i + 1 < glob.length) {
      const next = charAt(i + 1);
      source += literalSource(next);
      i += next.length;
      continue;
    }
    if (ch === '*') {
      const before = glob[i - 1];
      let stars = 1;
      while (glob[i + 1] === '*') {
        stars += 1;
        i += 1;
      }
      if (stars === 1) {
        source += '([^/]*)';
      } else if (glob[i + 1] === '/') {
        source += before === '/' ? '((.+/)|)' : '(.*/)';
        i += 1;
      } else {
        source += '(.*)';
      }
      continue;
    }
    if (ch === '{') {
      if (inGroup) throw invalid("nests a '{'");
      inGroup = true;
      source += '(';
    } else if (ch === '}') {
      if (!inGroup) throw invalid("has an unmatched '}'");
      inGroup = false;
      source += ')';
    } else if (ch === ',' && inGroup) {
      source += '|';
    } else {
      source += literalSource(ch);
    }
    i += ch.length - 1;
  }
  if (inGroup) throw invalid("has an unmatched '{'");
  return `${source}$`;
}
