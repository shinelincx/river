const INVITE_PATH = /^\/join\/([^/]+)\/?$/;

export function inviteCodeFromPath(pathname: string): string | undefined {
  const encoded = INVITE_PATH.exec(pathname)?.[1];
  if (!encoded) return undefined;
  try {
    const code = decodeURIComponent(encoded).trim().toUpperCase();
    return /^RIVER-[A-Z0-9_-]{6,58}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}
