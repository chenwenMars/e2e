/**
 * Puts the builds of a native addon a release made into its platform
 * packages (`packages/desktop/npm/darwin-*` for the desktop driver), each
 * stamped with its package's version, so their `prepublishOnly`
 * (`check-native.ts`) passes. Run after the version step, right before
 * publishing.
 *
 * Usage: `node scripts/native/place-native.ts <addon> <directory with the addon's .node files>`.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { findAddon, addonFile, platformPackageDir, replaceAddon, scriptArgs } from './addons.ts';

const [name, source] = scriptArgs();
const addon = findAddon(name);
if (source === undefined) throw new Error(`usage: place-native.ts ${addon.name} <directory with ${addon.file}.*.node>`);
for (const platform of Object.values(addon.targets)) {
  const file = path.join(source, addonFile(addon, platform));
  if (!existsSync(file)) throw new Error(`${file} is missing: the native build did not make it`);
  const target = platformPackageDir(addon, platform);
  replaceAddon(file, path.join(target, addonFile(addon, platform)));
  const { version } = JSON.parse(readFileSync(path.join(target, 'package.json'), 'utf8')) as { version: string };
  writeFileSync(path.join(target, '.build.json'), `${JSON.stringify({ version })}\n`);
  process.stdout.write(`placed ${file} in ${target} for ${version}\n`);
}
