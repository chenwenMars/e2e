/**
 * `@e2e-dev/revyl/web` public surface: `revylBrowsers()`, a browser provider
 * for Chrome in Revyl web sessions on `@e2e-dev/web`. Its types never
 * reference `@e2e-dev/mobile`, and the package root's never reference
 * `@e2e-dev/web`, so a project installs only the engine it uses.
 */

export { revylBrowsers } from './web/browsers.ts';
export type { RevylBrowsersOptions } from './web/browsers.ts';
