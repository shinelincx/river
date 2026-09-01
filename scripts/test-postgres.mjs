import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';

const collectCoverage = process.argv.includes('--coverage');
const vitestArguments = [
  'exec', '--', 'vitest', 'run', 'src/postgres.integration.test.ts', '--reporter=verbose',
  ...(collectCoverage ? ['--coverage'] : [])
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

if (process.platform !== 'win32') {
  process.exit(run('npm', vitestArguments, {
    cwd: resolve(process.cwd(), 'apps/api'),
    env: { ...process.env, REQUIRE_POSTGRES_TESTS: '1', ...(collectCoverage ? { POSTGRES_COVERAGE_ONLY: '1' } : {}) }
  }));
}

const distro = process.env.RIVER_WSL_DISTRO ?? 'Debian';
const windowsRepositoryPath = process.cwd().replaceAll('\\', '/');
const drivePath = windowsRepositoryPath.match(/^([A-Za-z]):\/(.*)$/);
if (!drivePath) throw new Error(`Unable to map the repository path into WSL: ${windowsRepositoryPath}`);
const sourceDirectory = `/mnt/${drivePath[1].toLowerCase()}/${drivePath[2]}`;
const postgresImage =
  process.env.POSTGRES_TEST_IMAGE ??
  (process.platform === 'win32'
    ? 'docker.m.daocloud.io/library/postgres:16-alpine'
    : 'postgres:16-alpine');
const coverageEnvironment = collectCoverage ? 'POSTGRES_COVERAGE_ONLY=1 ' : '';
const coverageArgument = collectCoverage ? ' --coverage' : '';
const script = `
set -euo pipefail
source_directory=${shellQuote(sourceDirectory)}
test_directory="$(mktemp -d /tmp/river-postgres-tests.XXXXXX)"
cleanup() { rm -rf -- "$test_directory"; }
trap cleanup EXIT
tar -C "$source_directory" \
  --exclude=.git \
  --exclude=node_modules \
  --exclude='apps/*/node_modules' \
  --exclude=dist \
  --exclude='apps/*/dist' \
  --exclude=coverage \
  --exclude='apps/*/coverage' \
  --exclude=playwright-report \
  --exclude=test-results \
  -cf - . | tar -C "$test_directory" -xf -
cd "$test_directory"
npm ci
cd apps/api
REQUIRE_POSTGRES_TESTS=1 \
TESTCONTAINERS_RYUK_DISABLED=true \
POSTGRES_TEST_IMAGE=${shellQuote(postgresImage)} \
${coverageEnvironment}npm exec -- vitest run src/postgres.integration.test.ts --reporter=verbose${coverageArgument}
`;

process.exit(run('wsl', ['-d', distro, '--', 'bash', '-s'], {
  input: script.replaceAll('\r', ''),
  stdio: ['pipe', 'inherit', 'inherit']
}));
