import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export default async function globalTeardown() {
  execFileSync('npm', ['run', 'test:seed-ui', '--', '--cleanup'], {
    cwd: fileURLToPath(new URL('../../backend', import.meta.url)),
    env: {
      ...process.env,
      JWT_SECRET: 'acceptance-test-secret',
    },
    stdio: 'inherit',
  });
}
