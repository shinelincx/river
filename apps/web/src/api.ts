export type Player = { id: string; nickname: string };
export type Room = { id: string; name: string; maxSeats: 6 | 9; smallBlind: number; bigBlind: number; inviteCode: string; inviteOpen: boolean; status: string; role?: 'host' | 'member'; memberCount?: number; chips?: number };
export type Member = { id: string; nickname: string; role: 'host' | 'member'; chips: number };
export type RoomView = Room & { members: Member[]; isHost: boolean };
export type LedgerEntry = { id: string; playerId: string; actorId: string; amount: number; reason: string; createdAt: string };
export type HandHistoryItem = { handId: string; handNumber: number; blinds: { small: number; big: number }; board: Array<{ rank: number; suit: string }>; participants: Array<{ id: string; nickname: string }>; pointDeltas: Record<string, number>; pots: Array<{ amount: number; eligiblePlayerIds: string[] }>; settledBy: 'fold' | 'showdown'; settledAt: string; expiresAt: string };
export type HandReplay = { handId: string; handNumber: number; blinds: { small: number; big: number }; board: Array<{ rank: number; suit: string }>; players: Array<{ id: string; nickname: string; pointDelta: number; hole?: Array<{ rank: number; suit: string }> }>; events: Array<{ sequence: number; type: string; payload: Record<string, unknown> }>; result: { pots: Array<{ amount: number; eligiblePlayerIds: string[] }>; payouts: Record<string, number>; settledBy: 'fold' | 'showdown' }; settledAt: string; expiresAt: string };
export type HandAuditMaterial = { handId: string; handNumber: number; algorithmVersion: string; serverSeed: string; commitment: string; expiresAt: string; [key: string]: unknown };

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body != null && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(`/api${path}`, { ...init, credentials: 'include', headers });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? '请求失败');
  return data;
}
export const api = {
  me: () => request<{ player: Player | null }>('/me'),
  guest: (nickname: string) => request<{ player: Player }>('/guests', { method: 'POST', body: JSON.stringify({ nickname }) }),
  rooms: () => request<{ rooms: Room[] }>('/rooms'),
  room: (roomId: string) => request<{ room: RoomView }>(`/rooms/${roomId}`),
  createRoom: (input: { name: string; maxSeats: 6 | 9; smallBlind: number; initialChips: number }) => request<{ room: Room }>('/rooms', { method: 'POST', body: JSON.stringify(input) }),
  join: (code: string) => request<{ room: Room }>(`/invites/${encodeURIComponent(code)}/join`, { method: 'POST' }),
  invite: (roomId: string, open: boolean) => request<{ room: Room }>(`/rooms/${roomId}/invite`, { method: 'PATCH', body: JSON.stringify({ open }) }),
  rotateInvite: (roomId: string) => request<{ room: Room }>(`/rooms/${roomId}/invite/rotate`, { method: 'POST' }),
  pause: (roomId: string) => request<{ room: Room }>(`/rooms/${roomId}/pause`, { method: 'POST' }),
  resume: (roomId: string) => request<{ room: Room }>(`/rooms/${roomId}/resume`, { method: 'POST' }),
  removeMember: (roomId: string, playerId: string) => request<{ membership: unknown }>(`/rooms/${roomId}/members/${playerId}/remove`, { method: 'POST' }),
  sitIn: (roomId: string) => request<{ ok: true }>(`/rooms/${roomId}/sit-in`, { method: 'POST' }),
  sitOut: (roomId: string) => request<{ ok: true }>(`/rooms/${roomId}/sit-out`, { method: 'POST' }),
  ledger: (roomId: string) => request<{ entries: LedgerEntry[] }>(`/rooms/${roomId}/ledger`),
  credit: (roomId: string, playerId: string, amount: number) => request<{ entry: LedgerEntry }>(`/rooms/${roomId}/credits`, { method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ playerId, amount }) }),
  dissolve: (roomId: string) => request<{ room: Room }>(`/rooms/${roomId}/dissolve`, { method: 'POST' }),
  table: (roomId: string, version?: number) => request<{ snapshot: unknown; unchanged: boolean }>(`/rooms/${roomId}/table${version === undefined ? '' : `?version=${version}`}`),
  hands: (roomId: string) => request<{ hands: HandHistoryItem[] }>(`/rooms/${roomId}/hands`),
  replay: (roomId: string, handId: string) => request<{ replay: HandReplay }>(`/rooms/${roomId}/hands/${handId}/replay`),
  audit: (roomId: string, handId: string) => request<{ audit: HandAuditMaterial }>(`/rooms/${roomId}/hands/${handId}/audit`),
  verifyAudit: (roomId: string, handId: string) => request<{ verified: boolean; expiresAt: string; algorithmVersion: string }>(`/rooms/${roomId}/hands/${handId}/audit/verify`),
  history: () => request<{ settlements: { roomId: string; finalChips: number; createdAt: string; room?: Room }[] }>('/history')
};
