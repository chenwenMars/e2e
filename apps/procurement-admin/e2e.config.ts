import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

export default {
  projectId: 'procurement-admin',
  tests: 'tests/**/*.e2e.ts',
  workers: 1,
  targets: [{
    name: 'web',
    engine: web(),
    app: {
      url: 'http://127.0.0.1:0',
      command: {
        executable: 'npm',
        inheritEnv: ['PROCUREMENT_DATA_DIR'],
        args: ['run', 'preview', '--', '--host', '127.0.0.1', '--port', '{port}', '--strictPort'],
        log: '.e2e/logs/preview.log',
      },
    },
  }],
} satisfies E2EConfig;