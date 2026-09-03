const INVITE_PATH = /^\/join\/([^/]+)\/?$/;
const INVITE_CODE = /^(?:[A-Z0-9]{8}|RIVER-[A-Z0-9_-]{6,58})$/;

export function inviteCodeFromPath(pathname: string): string | undefined {
  const encoded = INVITE_PATH.exec(pathname)?.[1];
  if (!encoded) return undefined;
  try {
    const code = decodeURIComponent(encoded).trim().toUpperCase();
    return INVITE_CODE.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/** Accepts either an invite code or a full River Table invite link pasted by a player. */
export function inviteCodeFromInput(input: string): string | undefined {
  const trimmed = input.trim();
  const directCode = trimmed.toUpperCase();
  if (INVITE_CODE.test(directCode)) return directCode;
  try {
    return inviteCodeFromPath(new URL(trimmed).pathname);
  } catch {
    return undefined;
  }
}
