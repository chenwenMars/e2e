import type { BrowserProvider } from '@e2e-dev/web';
import { moli, type MoliOptions } from '../../src/index.ts';

const options: MoliOptions = { binary: '/usr/local/bin/moli', layout: true, loadResources: false, args: ['--log-level', 'warn'] };
moli(options) satisfies BrowserProvider;

// @ts-expect-error layout is a boolean, not a CLI string
moli({ layout: 'true' });
// @ts-expect-error loadResources must be a boolean
moli({ loadResources: ['image'] });
// @ts-expect-error this provider supports worker scope only
moli({ scope: 'attempt' });
