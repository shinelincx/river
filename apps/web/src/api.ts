export type Player = { id: string; nickname: string };
export type Room = { id: string; name: string; maxSeats: 6 | 9; smallBlind: number; bigBlind: number; inviteCode: string; inviteOpen: boolean; status: string; role?: 'host' | 'member'; memberCount?: number; chips?: number };
export type Member = { id: string; nickname: string; role: 'host' | 'member'; chips: number };
export type RoomView = Room & { members: Member[]; isHost: boolean };
export type LedgerEntry = { id: string; playerId: string; actorId: string; amount: number; reason: string; createdAt: string };

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
  ledger: (roomId: string) => request<{ entries: LedgerEntry[] }>(`/rooms/${roomId}/ledger`),
  credit: (roomId: string, playerId: string, amount: number) => request<{ entry: LedgerEntry }>(`/rooms/${roomId}/credits`, { method: 'POST', headers: { 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ playerId, amount }) }),
  dissolve: (roomId: string) => request<{ room: Room }>(`/rooms/${roomId}/dissolve`, { method: 'POST' }),
  history: () => request<{ settlements: { roomId: string; finalChips: number; createdAt: string; room?: Room }[] }>('/history')
};
