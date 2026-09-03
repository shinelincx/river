export const AUDIT_PACKAGE_VERSION: 'river-audit-package-v1';
export type VerificationChecks = { package: boolean; commitment: boolean; deck: boolean; deal: boolean; contributions: boolean; settlement: boolean };
export type VerificationResult = { verified: boolean; reason?: string; checks: VerificationChecks };
export type VerificationPackage = { formatVersion: typeof AUDIT_PACKAGE_VERSION; publicCommitment: string; audit: unknown };
export function deterministicDeck(serverSeed: string, playerContributions: Record<string, string>, handId: string): Promise<Array<{ rank: number; suit: string }>>;
export function verifyAuditMaterial(audit: unknown, publicCommitment?: string): Promise<VerificationResult>;
export function createVerificationPackage(audit: unknown, publicCommitment: string): VerificationPackage;
export function verifyVerificationPackage(value: unknown): Promise<VerificationResult>;
