/**
 * Refuses to publish a platform package whose native addon was not built
 * for the version being published: the `prepublishOnly` of a platform
 * package such as `@e2e-dev/desktop-darwin-*`, the counterpart of
 * `scripts/check-dist.ts`. `build-native.ts --out <package>` and
 * `place-native.ts` write the addon and its stamp. The addon is the
 * package's `main`, which npm packs whatever `files` says.
 *
 * Usage: `node ../../../../scripts/native/check-native.ts <addon>`, from the platform package directory.
 */

import { existsSync, readFileSync } from 'node:fs';
import { findAddon, scriptArgs } from './addons.ts';

const addon = findAddon(scriptArgs()[0]);
const { name, version, main } = JSON.parse(readFileSync('package.json', 'utf8')) as { name: string; version: string; main: string };
if (!existsSync(main)) {
  process.stderr.write(`${name}@${version}: ${main} is missing; build it with \`node scripts/native/build-native.ts ${addon.name} --target <triple> --out <this package>\` first\n`);
  process.exit(1);
}
// The addon links MIT and Apache-2.0 crates, whose notices must go with every copy (`native-licenses.ts`).
if (!existsSync('THIRD_PARTY_LICENSES.md')) {
  process.stderr.write(`${name}@${version}: THIRD_PARTY_LICENSES.md is missing; write it with \`node scripts/native/native-licenses.ts ${addon.name}\`\n`);
  process.exit(1);
}
const stamp = existsSync('.build.json') ? (JSON.parse(readFileSync('.build.json', 'utf8')) as { version?: string }) : {};
if (stamp.version !== version) {
  process.stderr.write(`${name}@${version}: ${main} was built for ${stamp.version ?? 'an unknown version'}; build it again first\n`);
  process.exit(1);
}
