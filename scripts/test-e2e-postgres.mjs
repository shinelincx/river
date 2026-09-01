import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import process from 'node:process';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function dockerArguments(args) {
  return process.platform === 'win32'
    ? { command: 'wsl', args: ['-d', process.env.RIVER_WSL_DISTRO ?? 'Debian', '--', 'docker', ...args] }
    : { command: 'docker', args };
}

function docker(args, options = {}) {
  const invocation = dockerArguments(args);
  return run(invocation.command, invocation.args, options);
}

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

const port = Number(process.env.RIVER_POSTGRES_E2E_PORT ?? await availablePort());
if (!Number.isSafeInteger(port) || port <= 0) throw new Error('Unable to allocate a PostgreSQL E2E port');
const containerName = `river-e2e-${process.pid}`;
const password = 'river-e2e-password';
const image =
  process.env.POSTGRES_TEST_IMAGE ??
  (process.platform === 'win32'
    ? 'docker.m.daocloud.io/library/postgres:16-alpine'
    : 'postgres:16-alpine');
let containerStarted = false;

try {
  const started = docker([
    'run', '--detach', '--rm', '--name', containerName,
    '--env', 'POSTGRES_DB=river',
    '--env', 'POSTGRES_USER=river',
    '--env', `POSTGRES_PASSWORD=${password}`,
    '--publish', `${port}:5432`,
    image
  ]);
  if (started !== 0) process.exit(started);
  containerStarted = true;

  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (docker(['exec', containerName, 'pg_isready', '--username', 'river', '--dbname', 'river'], { stdio: 'ignore' }) === 0) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error('PostgreSQL E2E container did not become ready');

  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Run this command through npm run test:e2e:postgres');
  const status = run(process.execPath, [npmCli, 'exec', '--', 'playwright', 'test', '--config=playwright.postgres.config.ts'], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      DATABASE_URL: `postgresql://river:${password}@127.0.0.1:${port}/river`,
      INVITE_CREDENTIAL_KEY: 'river-production-e2e-invite-key-32-bytes',
      RIVER_PRODUCTION_E2E: '1',
      PORT: '3000',
      RIVER_E2E_CONTROL_PORT: '3101'
    }
  });
  process.exitCode = status;
} finally {
  if (containerStarted) docker(['stop', '--time', '3', containerName], { stdio: 'ignore' });
}
