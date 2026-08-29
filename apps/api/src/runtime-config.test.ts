import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateRuntimeConfiguration } from './runtime-config.js';

const apiDirectory = fileURLToPath(new URL('..', import.meta.url));
const validationScript = "import { validateRuntimeConfiguration } from './src/runtime-config.ts'; validateRuntimeConfiguration(process.env);";

function validateInSpawn(overrides: Record<string, string | undefined>) {
  const environment = { ...process.env, ...overrides };
  for (const [key, value] of Object.entries(environment)) if (value === undefined) delete environment[key];
  return spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', validationScript], {
    cwd: apiDirectory,
    env: environment,
    encoding: 'utf8'
  });
}

describe('runtime configuration', () => {
  it.each([undefined, 'staging'])('fails closed when NODE_ENV is %s and persistence settings are absent', (nodeEnvironment) => {
    const result = validateInSpawn({ NODE_ENV: nodeEnvironment, DATABASE_URL: undefined, INVITE_CREDENTIAL_KEY: undefined });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('非开发/测试环境必须配置 DATABASE_URL');
  });

  it('allows unsafe in-memory defaults only in explicitly development or test environments', () => {
    expect(() => validateRuntimeConfiguration({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => validateRuntimeConfiguration({ NODE_ENV: 'test' })).not.toThrow();
    expect(validateInSpawn({ NODE_ENV: 'staging', DATABASE_URL: 'postgres://river', INVITE_CREDENTIAL_KEY: 'secret' }).status).toBe(0);
  });
});
