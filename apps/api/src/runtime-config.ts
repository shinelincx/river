export type RuntimeEnvironment = Record<string, string | undefined>;

export function validateRuntimeConfiguration(environment: RuntimeEnvironment = process.env): void {
  const explicitlyUnsafe = environment.NODE_ENV === 'development' || environment.NODE_ENV === 'test';
  if (explicitlyUnsafe) return;
  if (!environment.DATABASE_URL) throw new Error('非开发/测试环境必须配置 DATABASE_URL');
  if (!environment.INVITE_CREDENTIAL_KEY) throw new Error('非开发/测试环境必须配置 INVITE_CREDENTIAL_KEY');
}
