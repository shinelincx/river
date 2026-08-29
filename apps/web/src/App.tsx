import { FormEvent, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { io, type Socket } from 'socket.io-client';
import { api, type LedgerEntry, type Member, type Player, type Room, type RoomView } from './api';
import { subscribeTableAudio, tableAudio } from './audio';
import { tableSoundEvents } from './table-sound-events';

type NoticeTone = 'success' | 'error';
type Notice = { tone: NoticeTone; text: string } | null;
type LegalActions = {
  canFold: boolean; canCheck: boolean; canCall: boolean; canRaise: boolean;
  toCall: number; callAmount: number; minRaiseTo: number; maxRaiseTo: number; raiseAllInOnly: boolean;
};
type TableSnapshot = {
  sequence: number;
  players: Array<{ id: string; nickname: string; seat: number; stack: number; connected: boolean; folded: boolean; allIn: boolean; bet: number; contribution: number; hole?: Array<{ rank: number; suit: string }> }>;
  hand?: {
    number: number; commitment: string; board: Array<{ rank: number; suit: string }>; street: string;
    dealerSeat: number; smallBlindSeat: number; bigBlindSeat: number; currentPlayerId?: string;
    currentBet: number; minRaise: number; status: 'active' | 'settled'; potTotal: number;
    pots: Array<{ amount: number; eligiblePlayerIds: string[] }>; legalActions?: LegalActions;
  };
  timing?: { serverNow: number; actionDeadlineAt?: number; nextHandStartsAt?: number; waitingForPlayers?: boolean };
};
type HandSnapshot = NonNullable<TableSnapshot['hand']>;
type TableActionType = 'fold' | 'check' | 'call' | 'raise';
type QuickBetOption = { id: string; label: string; amount: number; target: number; targetLabel?: string; valid: boolean };

function isLegalRaiseTarget(hand: HandSnapshot, legal: LegalActions, target: number): boolean {
  if (!legal.canRaise || target <= hand.currentBet || target > legal.maxRaiseTo) return false;
  return target === legal.maxRaiseTo || target >= legal.minRaiseTo;
}

function quickBetOptions(hand: HandSnapshot, legal: LegalActions, playerBet: number): QuickBetOption[] {
  if (hand.currentBet === 0) {
    return [
      { id: 'quarter', label: '1/4 池', ratio: 1 / 4 },
      { id: 'third', label: '1/3 池', ratio: 1 / 3 },
      { id: 'half', label: '1/2 池', ratio: 1 / 2 },
      { id: 'pot', label: '满池', ratio: 1 }
    ].map(({ id, label, ratio }) => {
      const target = Math.max(1, Math.round(hand.potTotal * ratio));
      return { id, label, amount: target, target, valid: isLegalRaiseTarget(hand, legal, target) };
    });
  }
  const multiples = [
    { id: 'once', label: '1 倍', ratio: 1 },
    { id: 'one-half', label: '1.5 倍', ratio: 1.5 },
    { id: 'twice', label: '2 倍', ratio: 2 }
  ].map(({ id, label, ratio }) => {
    const increment = Math.max(1, Math.round(hand.currentBet * ratio));
    const target = hand.currentBet + increment;
    return { id, label, amount: increment, target, targetLabel: `加到 ${format(target)}`, valid: isLegalRaiseTarget(hand, legal, target) };
  });
  return [...multiples, { id: 'all-in', label: '全下', amount: Math.max(0, legal.maxRaiseTo - playerBet), target: legal.maxRaiseTo, valid: isLegalRaiseTarget(hand, legal, legal.maxRaiseTo) }];
}

const cardRank = (rank: number) => rank === 14 ? 'A' : rank === 13 ? 'K' : rank === 12 ? 'Q' : rank === 11 ? 'J' : String(rank);
const cardSuit = (suit: string) => ({ S: '♠', H: '♥', D: '♦', C: '♣' }[suit] ?? '');
const format = (value: number) => new Intl.NumberFormat('zh-CN').format(value);

function Icon({ name, size = 20 }: { name: 'plus' | 'lock' | 'settings' | 'arrow' | 'users' | 'copy' | 'close' | 'history' | 'sound' | 'soundOff' | 'back' | 'more' | 'refresh'; size?: number }) {
  const paths = {
    plus: <><path d="M12 5v14M5 12h14" /></>, lock: <><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9 7 7m10 10 2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" /></>,
    arrow: <path d="m9 18 6-6-6-6" />, users: <><circle cx="9" cy="8" r="3" /><path d="M3.5 20c.6-3.2 2.5-5 5.5-5s4.9 1.8 5.5 5M17 11a3 3 0 1 0-1-5.8M16.5 15.1c2.3.3 3.7 1.9 4 4.9" /></>,
    copy: <><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" /></>, close: <path d="m6 6 12 12M18 6 6 18" />,
    history: <><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5M12 7v5l3 2" /></>, sound: <><path d="M4 10v4h4l5 4V6l-5 4zM17 9a4 4 0 0 1 0 6M19.5 6.5a7 7 0 0 1 0 11" /></>, soundOff: <><path d="M4 10v4h4l5 4V6l-5 4zM16 10l5 5m0-5-5 5" /></>,
    back: <path d="m15 18-6-6 6-6" />, more: <path d="M5 12h.01M12 12h.01M19 12h.01" />,
    refresh: <><path d="M20 6v5h-5" /><path d="M4 18v-5h5" /><path d="M6.1 9a7 7 0 0 1 11.5-2.6L20 9M4 15l2.4 2.6A7 7 0 0 0 17.9 15" /></>
  }[name];
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{paths}</svg>;
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => { const handler = (event: KeyboardEvent) => event.key === 'Escape' && onClose(); addEventListener('keydown', handler); return () => removeEventListener('keydown', handler); }, [onClose]);
  return <div className="scrim" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title"><header className="sheetHeader"><h2 id="sheet-title">{title}</h2><button className="iconButton" onClick={onClose} aria-label="关闭"><Icon name="close" /></button></header>{children}</section></div>;
}

function GuestGate({ onCreated }: { onCreated: (player: Player) => void }) {
  const [nickname, setNickname] = useState(''); const [error, setError] = useState(''); const [working, setWorking] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setError(''); setWorking(true); try { onCreated((await api.guest(nickname)).player); } catch (reason) { setError((reason as Error).message); } finally { setWorking(false); } };
  return <main className="gate"><div className="orb orbOne" /><div className="orb orbTwo" /><section className="gateCard"><span className="brandMark"><Icon name="lock" size={24} /></span><p className="eyebrow">INVITATION ONLY</p><h1>River Table</h1><p className="lead">只和熟悉的人一起玩。创建一个设备身份，即可进入受邀制私人牌局。</p><form onSubmit={submit} noValidate><label htmlFor="nickname">你的牌桌昵称</label><input id="nickname" value={nickname} maxLength={16} autoFocus placeholder="例如 深海玩家" onChange={(event) => setNickname(event.target.value)} aria-describedby={error ? 'nickname-error' : undefined} /><p className="helper">仅保存在本设备；清理浏览器数据后无法找回。</p>{error && <p id="nickname-error" className="fieldError">{error}</p>}<button className="primary wide" disabled={working}>{working ? '正在创建…' : '开始我的私人牌局'} <Icon name="arrow" /></button></form></section></main>;
}

export function App() {
  const [player, setPlayer] = useState<Player | null | undefined>(undefined); const [rooms, setRooms] = useState<Room[]>([]);
  const [selectedRoom, setSelectedRoom] = useState<RoomView | null>(null); const [tableOpen, setTableOpen] = useState(false); const [sheet, setSheet] = useState<'create' | 'join' | 'history' | 'settings' | null>(null); const [notice, setNotice] = useState<Notice>(null);
  const audioEnabled = useSyncExternalStore(subscribeTableAudio, tableAudio.getEnabled, tableAudio.getEnabled);
  const notify = useCallback((tone: NoticeTone, text: string) => { setNotice({ tone, text }); setTimeout(() => setNotice(null), 3200); }, []);
  const refreshRooms = async () => { try { setRooms((await api.rooms()).rooms); } catch (reason) { if ((reason as Error).message.includes('游客')) setPlayer(null); else notify('error', (reason as Error).message); } };
  useEffect(() => { api.me().then(({ player }) => { setPlayer(player); if (player) void refreshRooms(); }).catch(() => setPlayer(null)); }, []);
  const refreshRoom = async (id: string) => { setSelectedRoom((await api.room(id)).room); };
  const openRoom = async (id: string) => { try { setTableOpen(false); await refreshRoom(id); } catch (reason) { notify('error', (reason as Error).message); } };
  if (player === undefined) return <div className="loading">正在连接 River Table…</div>;
  if (!player) return <GuestGate onCreated={(next) => { setPlayer(next); void refreshRooms(); }} />;
  return <main className={tableOpen ? 'appShell tableMode' : 'appShell'}>{!tableOpen && <header className="topbar"><button className="iconButton" aria-label="打开设置" onClick={() => setSheet('settings')}><Icon name="settings" /></button><div className="wordmark"><strong>RIVER TABLE</strong><span>受邀制私人牌局</span></div><button className="avatarButton" aria-label="查看个人资料" onClick={() => setSheet('settings')}>{player.nickname.slice(0, 1)}</button></header>}
    {selectedRoom ? <RoomScreen player={player} room={selectedRoom} onBack={() => { setTableOpen(false); setSelectedRoom(null); void refreshRooms(); }} onRefresh={() => refreshRoom(selectedRoom.id)} onTableChange={setTableOpen} notify={notify} /> : <Dashboard rooms={rooms} onCreate={() => setSheet('create')} onJoin={() => setSheet('join')} onOpen={openRoom} />}
    {notice && <div className={`toast ${notice.tone}`} role="status">{notice.text}</div>}
    {sheet === 'create' && <CreateRoomSheet onClose={() => setSheet(null)} onCreated={(room) => { setSheet(null); void refreshRooms(); void openRoom(room.id); notify('success', '私人房已创建'); }} notify={notify} />}
    {sheet === 'join' && <JoinRoomSheet onClose={() => setSheet(null)} onJoined={(room) => { setSheet(null); void refreshRooms(); void openRoom(room.id); notify('success', '已加入私人房'); }} />}
    {sheet === 'history' && <HistorySheet onClose={() => setSheet(null)} />}
    {sheet === 'settings' && <Sheet title="设备与偏好" onClose={() => setSheet(null)}><div className="settings"><div className="settingsIdentity"><span className="avatarLarge">{player.nickname.slice(0, 1)}</span><div><strong>{player.nickname}</strong><p>设备游客身份 · 仅本机可用</p></div></div><div className="settingLine"><span><strong>音效与背景音乐</strong><small>发牌、下注、轮到你和轻柔牌桌音乐</small></span><button className={audioEnabled ? 'switch on' : 'switch'} aria-label={`音效与背景音乐已${audioEnabled ? '开启' : '关闭'}`} aria-pressed={audioEnabled} onClick={() => tableAudio.setEnabled(!audioEnabled)}><i /></button></div><button className="textAction" onClick={() => setSheet('history')}><Icon name="history" /> 查看历史结算 <Icon name="arrow" /></button></div></Sheet>}
  </main>;
}

function Dashboard({ rooms, onCreate, onJoin, onOpen }: { rooms: Room[]; onCreate: () => void; onJoin: () => void; onOpen: (id: string) => void }) {
  return <div className="page"><section className="hero"><p className="eyebrow">只和熟悉的人一起玩</p><h1>你的私人牌局<br />从一个邀请开始</h1><p>不会出现陌生人的牌桌。通过邀请码或链接邀请好友加入。</p><div className="buttonRow"><button className="primary" onClick={onCreate}><Icon name="plus" /> 创建房间</button><button className="secondary" onClick={onJoin}><Icon name="lock" /> 输入邀请码</button></div></section><section className="sectionHeader"><div><h2>我的牌局</h2><p>仅受邀房间</p></div><span>{rooms.length} 个房间</span></section><div className="roomList">{rooms.length ? rooms.map((room) => <button key={room.id} className="roomCard" onClick={() => onOpen(room.id)}><div className="roomMeta"><span className="privatePill"><Icon name="lock" size={12} /> {room.role === 'host' ? '我的房间' : '受邀房间'}</span><span className={room.status === 'active' ? 'statusPill' : 'statusPill muted'}>{room.status === 'active' ? `${room.memberCount} / ${room.maxSeats} 已加入` : '已结束'}</span></div><h3>{room.name}</h3><p>{room.smallBlind} / {room.bigBlind} · {room.maxSeats} 人桌 · {room.role === 'host' ? '你管理积分' : `我的积分 ${format(room.chips ?? 0)}`}</p><span className="roomGo">进入房间 <Icon name="arrow" size={16} /></span></button>) : <div className="emptyState"><Icon name="users" size={28} /><h3>还没有私人牌局</h3><p>创建房间，或输入好友分享的邀请码。</p><button className="secondary" onClick={onCreate}>创建第一个房间</button></div>}</div><div className="trustNote"><Icon name="lock" /><p>纯娱乐虚拟积分，不支持充值、提现或真实货币兑换。</p></div></div>;
}

function CreateRoomSheet({ onClose, onCreated, notify }: { onClose: () => void; onCreated: (room: Room) => void; notify: (tone: 'success' | 'error', text: string) => void }) {
  const [name, setName] = useState('好友夜牌局'); const [seats, setSeats] = useState<6 | 9>(6); const [blind, setBlind] = useState(20); const [chips, setChips] = useState(1500); const [working, setWorking] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setWorking(true); try { onCreated((await api.createRoom({ name, maxSeats: seats, smallBlind: blind, initialChips: chips })).room); } catch (reason) { notify('error', (reason as Error).message); } finally { setWorking(false); } };
  return <Sheet title="创建私人房" onClose={onClose}><p className="sheetIntro">你会成为房主，可分配初始积分、在牌局中补充积分，并控制邀请权限。</p><form onSubmit={submit} className="form"><label>房间名称<input value={name} maxLength={20} onChange={(e) => setName(e.target.value)} /></label><fieldset><legend>人数</legend><div className="choiceGrid">{([6, 9] as const).map((value) => <button type="button" key={value} className={seats === value ? 'choice selected' : 'choice'} aria-pressed={seats === value} onClick={() => setSeats(value)}>{value} 人桌</button>)}</div></fieldset><fieldset><legend>小盲 / 大盲</legend><div className="choiceGrid">{[10, 20, 50, 100].map((value) => <button type="button" key={value} className={blind === value ? 'choice selected' : 'choice'} aria-pressed={blind === value} onClick={() => setBlind(value)}>{value} / {value * 2}</button>)}</div></fieldset><label>你的初始积分<input type="number" min={blind * 2} step={blind} value={chips} onChange={(e) => setChips(Number(e.target.value))} /></label><button className="primary wide" disabled={working}>{working ? '正在创建…' : '生成邀请码'} <Icon name="arrow" /></button></form></Sheet>;
}

function JoinRoomSheet({ onClose, onJoined }: { onClose: () => void; onJoined: (room: Room) => void }) {
  const [code, setCode] = useState(''); const [error, setError] = useState(''); const [working, setWorking] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setError(''); setWorking(true); try { onJoined((await api.join(code)).room); } catch (reason) { setError((reason as Error).message); } finally { setWorking(false); } };
  return <Sheet title="加入私人房" onClose={onClose}><p className="sheetIntro">输入好友分享的邀请码。加入后，你可以在“我的牌局”中再次进入。</p><form onSubmit={submit} className="form"><label htmlFor="inviteCode">邀请码<input id="inviteCode" value={code} placeholder="例如 RIVER-ABCDE" maxLength={12} autoCapitalize="characters" onChange={(event) => setCode(event.target.value.toUpperCase())} /></label>{error && <p className="fieldError">{error}</p>}<button className="primary wide" disabled={working}>{working ? '正在验证…' : '加入牌局'} <Icon name="arrow" /></button></form></Sheet>;
}

function RoomScreen({ player, room, onBack, onRefresh, onTableChange, notify }: {
  player: Player;
  room: RoomView;
  onBack: () => void;
  onRefresh: () => Promise<void>;
  onTableChange: (open: boolean) => void;
  notify: (tone: 'success' | 'error', text: string) => void;
}) {
  const [screen, setScreen] = useState<'room' | 'table'>('room');
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [working, setWorking] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const memberNames = useMemo(() => new Map(room.members.map((member) => [member.id, member.nickname])), [room.members]);
  const visibleMembers = room.members.filter((member) => room.isHost || member.id === player.id);

  useEffect(() => { onTableChange(screen === 'table'); return () => onTableChange(false); }, [onTableChange, screen]);
  useEffect(() => { api.ledger(room.id).then((result) => setLedger(result.entries)).catch(() => undefined); }, [room.id]);

  const copy = async (value: string, label: string) => {
    try { await navigator.clipboard.writeText(value); notify('success', `${label}已复制`); }
    catch { notify('error', '当前浏览器不支持复制'); }
  };
  const syncRoomData = async () => {
    const [, ledgerResult] = await Promise.all([onRefresh(), api.ledger(room.id)]);
    setLedger(ledgerResult.entries);
  };
  const refreshMembers = async () => {
    setRefreshing(true);
    try {
      await syncRoomData();
      notify('success', '成员和当前积分已刷新');
    } catch (reason) {
      notify('error', (reason as Error).message);
    } finally {
      setRefreshing(false);
    }
  };
  const creditValue = (memberId: string) => amounts[memberId] ?? '500';
  const validCreditAmount = (memberId: string) => {
    const value = creditValue(memberId).trim();
    const amount = Number(value);
    return value !== '' && Number.isSafeInteger(amount) && amount > 0;
  };
  const credit = async (member: Member) => {
    const amount = Number(creditValue(member.id));
    if (!validCreditAmount(member.id)) { notify('error', '请输入大于 0 的整数积分'); return; }
    setWorking(true);
    try {
      await api.credit(room.id, member.id, amount);
      await syncRoomData();
      notify('success', `已向 ${member.nickname} 补充 ${format(amount)} 积分`);
    } catch (reason) {
      notify('error', (reason as Error).message);
    } finally {
      setWorking(false);
    }
  };
  const dissolve = async () => {
    if (!confirm('解散后邀请码会立即失效，并在本手结束后生成结算记录。确定继续吗？')) return;
    setWorking(true);
    try {
      const result = await api.dissolve(room.id);
      notify('success', result.room.status === 'closing' ? '将于本手结束后解散' : '房间已解散');
      await onRefresh();
    } catch (reason) {
      notify('error', (reason as Error).message);
    } finally {
      setWorking(false);
    }
  };
  const toggleInvite = async () => {
    try {
      await api.invite(room.id, !room.inviteOpen);
      notify('success', room.inviteOpen ? '已关闭邀请' : '已开启邀请');
      await onRefresh();
    } catch (reason) {
      notify('error', (reason as Error).message);
    }
  };

  if (screen === 'table') return <TableScreen room={room} player={player} onBack={() => { onTableChange(false); setScreen('room'); void onRefresh(); }} notify={notify} />;

  return <div className="page roomPage">
    <header className="roomTop">
      <button className="iconButton" onClick={onBack} aria-label="返回我的牌局"><Icon name="back" /></button>
      <div><p className="eyebrow">{room.isHost ? 'ROOM ADMIN' : 'INVITED PLAYER'}</p><h1>{room.name}</h1><p>{room.smallBlind} / {room.bigBlind} · {room.maxSeats} 人桌</p></div>
    </header>
    <section className="inviteCard">
      <div><p className="eyebrow">仅受邀玩家可进入</p><strong>{room.inviteCode}</strong><p>{room.inviteOpen ? '邀请码有效，可分享给熟悉的好友' : '邀请已关闭'}</p></div>
      <div className="inviteActions"><button className="iconButton" aria-label="复制邀请码" onClick={() => copy(room.inviteCode, '邀请码')}><Icon name="copy" /></button><button className="secondary small" onClick={() => copy(`${location.origin}/join/${room.inviteCode}`, '邀请链接')}>复制链接</button></div>
    </section>
    <div className="roomButtons">
      <button className="primary" disabled={room.status !== 'active'} onClick={() => { tableAudio.enterTable(); setScreen('table'); }}>进入牌桌 <Icon name="arrow" /></button>
      {room.isHost && <button className={room.inviteOpen ? 'secondary' : 'secondary selectedOutline'} disabled={working} onClick={toggleInvite}><Icon name="lock" /> {room.inviteOpen ? '关闭邀请' : '开启邀请'}</button>}
    </div>
    <section className="sectionHeader memberSectionHeader">
      <div><h2>成员积分</h2><p>{room.isHost ? '房主可为自己和其他玩家补充积分' : '仅显示你的个人积分'}</p></div>
      <div className="memberHeaderActions">
        <span aria-live="polite">{room.members.length} 位成员</span>
        {room.isHost && <button type="button" className={`memberRefreshButton ${refreshing ? 'refreshing' : ''}`} disabled={refreshing || working} onClick={refreshMembers} aria-label="刷新成员和当前积分"><Icon name="refresh" size={15} /><span>{refreshing ? '刷新中' : '刷新'}</span></button>}
      </div>
    </section>
    <div className="memberList">
      {visibleMembers.map((member) => <article className="memberRow" key={member.id}>
        <span className="memberAvatar">{member.nickname.slice(0, 1)}</span>
        <div className="memberInfo"><strong>{member.nickname}{member.id === player.id && '（你）'}</strong><small>{member.role === 'host' ? '房主 · 管理积分' : '受邀成员'}</small></div>
        <span className="memberChips"><small>当前积分</small><strong>{format(member.chips)}</strong></span>
        {room.isHost && <div className="creditControl"><input aria-label={`向 ${member.nickname} 补充积分`} type="number" inputMode="numeric" min="1" step="100" placeholder="输入积分" value={creditValue(member.id)} onChange={(event) => setAmounts((state) => ({ ...state, [member.id]: event.target.value }))} /><button className="secondary compact" disabled={working || !validCreditAmount(member.id)} onClick={() => credit(member)}>补充</button></div>}
      </article>)}
    </div>
    <section className="sectionHeader slim"><div><h2>积分记录</h2><p>追加式记录，不可直接修改余额</p></div></section>
    <div className="ledgerList">
      {ledger.length ? ledger.slice(0, 8).map((entry) => {
        const targetName = memberNames.get(entry.playerId) ?? '玩家';
        return <div className="ledgerItem" key={entry.id}><span className="ledgerGlyph"><Icon name="history" size={16} /></span><div><strong>{entry.reason === 'initial' ? `${targetName} · 初始积分` : `已向 ${targetName} 补充`}</strong><small>{new Date(entry.createdAt).toLocaleString('zh-CN')}</small></div><b>+{format(entry.amount)}</b></div>;
      }) : <p className="emptyInline">暂无积分记录</p>}
    </div>
    {room.isHost && <button className="danger" disabled={working || room.status !== 'active'} onClick={dissolve}>解散房间并生成结算记录</button>}
  </div>;
}

const secondsUntil = (deadline?: number) => deadline === undefined ? undefined : Math.max(0, Math.ceil((deadline - Date.now()) / 1_000));

function useCountdown(deadline?: number): number | undefined {
  const [seconds, setSeconds] = useState<number | undefined>(() => secondsUntil(deadline));
  useEffect(() => {
    const update = () => setSeconds(secondsUntil(deadline));
    update();
    if (deadline === undefined) return;
    const timer = window.setInterval(update, 200);
    return () => window.clearInterval(timer);
  }, [deadline]);
  return seconds;
}

function localDeadline(serverDeadline?: number, serverNow?: number): number | undefined {
  return serverDeadline === undefined || serverNow === undefined ? undefined : Date.now() + Math.max(0, serverDeadline - serverNow);
}

function SeatActionClock({ timing, isMine }: { timing: TableSnapshot['timing']; isMine: boolean }) {
  const deadline = useMemo(() => localDeadline(timing?.actionDeadlineAt, timing?.serverNow), [timing?.actionDeadlineAt, timing?.serverNow]);
  const seconds = useCountdown(deadline);
  const lastTick = useRef<number | undefined>(undefined);
  useEffect(() => { lastTick.current = undefined; }, [deadline]);
  useEffect(() => {
    if (seconds === undefined || seconds < 1 || seconds > 5 || lastTick.current === seconds) return;
    lastTick.current = seconds;
    tableAudio.play('tick');
  }, [seconds]);
  return <span className={`seatCountdown ${seconds !== undefined && seconds <= 5 ? 'urgent' : ''}`} role="timer" aria-live="polite" data-phase="action" aria-label={`${isMine ? '你的' : '当前玩家'}行动剩余 ${seconds ?? '未知'} 秒`}><strong>{seconds ?? '—'}</strong><small>秒</small></span>;
}

function NextHandClock({ timing }: { timing: TableSnapshot['timing'] }) {
  const deadline = useMemo(() => localDeadline(timing?.nextHandStartsAt, timing?.serverNow), [timing?.nextHandStartsAt, timing?.serverNow]);
  const seconds = useCountdown(deadline);
  if (timing?.waitingForPlayers) return <div className="nextHandClock waitingForPlayers" role="status" aria-live="polite" data-phase="waiting-for-players"><span>本手已结算</span><strong>等待补充积分</strong><small>需至少 2 位有积分玩家</small></div>;
  return <div className="nextHandClock" role="timer" aria-live="polite" data-phase="next-hand"><span>本手已结算 · 下一手</span><strong>{seconds ?? '…'}</strong><small>秒</small></div>;
}

function BetControls({ hand, legal, me, mine, onAction }: {
  hand?: HandSnapshot;
  legal?: LegalActions;
  me?: TableSnapshot['players'][number];
  mine: boolean;
  onAction: (type: TableActionType, amount?: number) => void;
}) {
  const options = hand && legal ? quickBetOptions(hand, legal, me?.bet ?? 0) : [];
  const defaultTarget = options.find((option) => option.valid)?.target ?? legal?.maxRaiseTo ?? 0;
  const [raiseTarget, setRaiseTarget] = useState(defaultTarget);
  const [customMode, setCustomMode] = useState(false);
  const sliderMinimum = hand?.currentBet ?? 0;
  const sliderMaximum = legal?.maxRaiseTo ?? sliderMinimum;
  const targetIsValid = !!hand && !!legal && isLegalRaiseTarget(hand, legal, raiseTarget);
  const sliderProgress = sliderMaximum === sliderMinimum ? 100 : Math.max(0, Math.min(100, ((raiseTarget - sliderMinimum) / (sliderMaximum - sliderMinimum)) * 100));
  const middleAction: TableActionType = legal?.canCheck ? 'check' : 'call';
  const middleLabel = legal?.canCheck ? '过牌' : legal?.canCall ? `${legal.callAmount === me?.stack ? '跟注全下' : '跟注'} ${format(legal.callAmount)}` : '等待行动';
  const openingBet = (hand?.currentBet ?? 0) === 0;

  return <section className="actionDock">
    <div className="commitment"><span>{mine ? `待跟 ${format(legal?.toCall ?? 0)}` : '牌序承诺'}</span><code>{mine ? `本轮已投入 ${format(me?.bet ?? 0)}` : hand?.commitment?.slice(0, 12) ?? '等待发牌'}</code></div>
    {!mine || !hand || !legal?.canRaise ? <div className="betSizingIdle">轮到你时显示快捷下注码量</div> : customMode ? <div className="customBetPanel">
      <div className="customBetHeader"><button type="button" onClick={() => setCustomMode(false)} aria-label="返回快捷码量">快捷码量</button><output aria-live="polite">{openingBet ? '下注到' : '加注到'} <b>{format(raiseTarget)}</b></output></div>
      <input className="betRange" type="range" min={sliderMinimum} max={sliderMaximum} step="1" value={raiseTarget} aria-label="自定义下注码量" style={{ background: `linear-gradient(90deg,#e6b84e 0%,#e6b84e ${sliderProgress}%,#263f54 ${sliderProgress}%,#263f54 100%)` }} onChange={(event) => setRaiseTarget(Number(event.target.value))} />
      <div className="rangeLabels"><span>{openingBet ? '0' : `跟平 ${format(sliderMinimum)}`}</span>{!targetIsValid && <strong>最小需到 {format(legal.minRaiseTo)}</strong>}<span>全下 {format(me?.stack ?? 0)}</span></div>
    </div> : <div className="quickBetPanel" aria-label={openingBet ? '底池比例快捷下注' : '上一下注倍数快捷加注'}>{options.map((option) => <button type="button" key={option.id} disabled={!option.valid} className="quickBet" aria-label={`${option.label}，${format(option.amount)}${option.targetLabel ? `，${option.targetLabel}` : ''}，直接${openingBet ? '下注' : '加注'}`} onClick={() => onAction('raise', option.target)}><strong>{option.label}</strong><span>{format(option.amount)}</span>{option.targetLabel && <small>{option.targetLabel}</small>}</button>)}</div>}
    <div className="gameActions"><button disabled={!mine || !legal?.canFold} className="foldButton" onClick={() => onAction('fold')}>弃牌</button><button disabled={!mine || (!legal?.canCheck && !legal?.canCall)} className="callButton" onClick={() => onAction(middleAction)}>{middleLabel}</button><button disabled={!mine || !legal?.canRaise || (customMode && !targetIsValid)} className="raiseButton" onClick={() => customMode ? onAction('raise', raiseTarget) : setCustomMode(true)}>{!legal?.canRaise ? '不可加注' : customMode ? `确认${openingBet ? '下注' : '加注'} ${format(raiseTarget)}` : openingBet ? '下注' : '加注'}</button></div>
  </section>;
}

function TableScreen({ room, player, onBack, notify }: { room: RoomView; player: Player; onBack: () => void; notify: (tone: 'success' | 'error', text: string) => void }) {
  const [snapshot, setSnapshot] = useState<TableSnapshot | null>(null); const [starting, setStarting] = useState(false); const socketRef = useRef<Socket | null>(null);
  const previousSnapshot = useRef<TableSnapshot | null>(null);
  const audioEnabled = useSyncExternalStore(subscribeTableAudio, tableAudio.getEnabled, tableAudio.getEnabled);
  useEffect(() => { tableAudio.enterTable(); return () => tableAudio.leaveTable(); }, []);
  useEffect(() => { const socket = io({ path: '/socket.io', transports: ['websocket'] }); socketRef.current = socket; socket.on('connect', () => socket.emit('table:join', { roomId: room.id }, (response: { ok: boolean; error?: string }) => !response.ok && notify('error', response.error ?? '无法进入牌桌'))); socket.on('table:snapshot', (next: TableSnapshot) => {
    const previous = previousSnapshot.current; const previousHand = previous?.hand; const nextHand = next.hand;
    if (previous && nextHand) {
      for (const cue of tableSoundEvents(previous, next, player.id)) tableAudio.play(cue);
      if (previousHand?.status !== 'settled' && nextHand.status === 'settled') notify('success', next.timing?.waitingForPlayers ? '本手已结算，等待至少两位有积分玩家' : '本手已结算，下一手即将自动开始');
    }
    previousSnapshot.current = next;
    setSnapshot(next);
  }); return () => { socket.disconnect(); }; }, [room.id, player.id, notify]);
  const me = snapshot?.players.find((item) => item.id === player.id); const hand = snapshot?.hand; const legal = hand?.legalActions; const mine = hand?.currentPlayerId === player.id && !!legal;
  const act = (type: TableActionType, amount?: number) => socketRef.current?.emit('action:submit', type === 'raise' ? { type, amount } : { type }, (response: { ok: boolean; error?: string }) => !response.ok && notify('error', response.error ?? '操作未执行'));
  const heroSeat = me?.seat ?? 1;
  const seats = useMemo(() => Array.from({ length: room.maxSeats }, (_, index) => {
    const physicalSeat = index + 1;
    return { physicalSeat, visualOffset: (physicalSeat - heroSeat + room.maxSeats) % room.maxSeats, player: snapshot?.players.find((item) => item.seat === physicalSeat) };
  }), [heroSeat, room.maxSeats, snapshot]);
  const readyPlayerCount = snapshot?.players.filter((item) => item.stack > 0).length ?? 0;
  const canStart = room.isHost && !hand && readyPlayerCount >= 2;
  const startHand = () => { if (!socketRef.current) return; setStarting(true); socketRef.current.emit('table:start', (response: { ok: boolean; error?: string }) => { setStarting(false); if (!response.ok) notify('error', response.error ?? '无法开始牌局'); }); };
  const positionLabel = (seat: number) => {
    if (!hand) return undefined;
    const labels = [seat === hand.dealerSeat && 'D', seat === hand.smallBlindSeat && 'SB', seat === hand.bigBlindSeat && 'BB'].filter(Boolean);
    return labels.join('·') || undefined;
  };
  const showPotBreakdown = hand?.pots.slice(1).some((pot) => pot.eligiblePlayerIds.length > 1);
  return <div className="tableScreen">
    <header className="tableHeader"><button className="iconButton" aria-label="返回房间" onClick={onBack}><Icon name="back" /></button><div><strong>{room.name}</strong><span>{room.smallBlind} / {room.bigBlind} · {hand ? `第 ${hand.number} 手` : '等待玩家入桌'}</span></div><button className={`iconButton audioToggle ${audioEnabled ? '' : 'muted'}`} aria-label={`音效与背景音乐已${audioEnabled ? '开启' : '关闭'}`} aria-pressed={audioEnabled} onClick={() => { const next = !audioEnabled; tableAudio.setEnabled(next); if (next) tableAudio.play('turn'); }}><Icon name={audioEnabled ? 'sound' : 'soundOff'} /></button></header>
    <div className="tableArea" data-table-size={room.maxSeats}>
      <div className="privateStrip"><Icon name="lock" size={13} /> 仅受邀玩家可进入</div><div className="felt"><div className="feltInner" /></div>
      {hand && <div className="pot"><span>总底池</span><b>{format(hand.potTotal)}</b>{showPotBreakdown && <small>{hand.pots.map((pot, index) => `${index === 0 ? '主池' : `边池${index}`} ${format(pot.amount)}`).join(' · ')}</small>}</div>}
      {hand?.status === 'settled' && <NextHandClock timing={snapshot?.timing} />}
      <div className="board" aria-label="公共牌">{Array.from({ length: 5 }, (_, index) => { const card = hand?.board[index]; return <div className={card ? `playingCard ${card.suit === 'H' || card.suit === 'D' ? 'red' : ''}` : 'playingCard blank'} key={index}>{card && <><span>{cardRank(card.rank)}</span><b>{cardSuit(card.suit)}</b></>}</div>; })}</div>
      <div className="seatRing">{seats.map(({ player: seat, physicalSeat, visualOffset }) => {
        const isTurn = hand?.status === 'active' && hand.currentPlayerId === seat?.id;
        const badge = positionLabel(physicalSeat);
        return <div className={`seat relativeSeat${visualOffset} ${seat?.id === player.id ? 'local' : ''} ${seat?.folded ? 'folded' : ''} ${isTurn ? 'activeTurn' : ''}`} data-physical-seat={physicalSeat} data-visual-offset={visualOffset} key={physicalSeat}>{seat ? <><span className="seatAvatarWrap"><span className="seatAvatar">{seat.nickname.slice(0, 1)}</span>{badge && <span className="positionBadge">{badge}</span>}{isTurn && <SeatActionClock timing={snapshot?.timing} isMine={seat.id === player.id} />}</span><span className="seatLabel"><b>{seat.nickname}{seat.id === player.id && '（你）'}</b>{seat.folded ? '已弃牌' : seat.allIn ? '全下' : format(seat.stack)}{!seat.connected && <i>离线</i>}</span>{seat.bet > 0 && <span className="seatBet">已投入 {format(seat.bet)}</span>}</> : <span className="openSeat">空位</span>}</div>;
      })}</div>
      {me?.hole && <div className="holeCards" aria-label="你的手牌">{me.hole.map((card, index) => <div key={index} className={`playingCard personal ${card.suit === 'H' || card.suit === 'D' ? 'red' : ''}`}><span>{cardRank(card.rank)}</span><b>{cardSuit(card.suit)}</b></div>)}</div>}
      {!hand && <div className="waiting"><Icon name="users" size={26} /><strong>{canStart ? '牌桌已就绪' : '等待至少一位受邀好友入桌'}</strong><p>{canStart ? `已有 ${readyPlayerCount} 位有积分玩家入桌，请由房主开始第一手。` : '至少两位有积分的受邀玩家入桌后，房主即可开始牌局。'}</p>{room.isHost && <button className="primary tableStartButton" disabled={!canStart || starting} onClick={startHand}>{starting ? '正在开始…' : '开始第一手'} <Icon name="arrow" /></button>}</div>}
    </div>
    <BetControls key={`${hand?.number ?? 0}:${hand?.street ?? 'waiting'}:${hand?.currentPlayerId ?? 'none'}:${hand?.currentBet ?? 0}:${me?.bet ?? 0}`} hand={hand} legal={legal} me={me} mine={mine} onAction={act} />
  </div>;
}

function HistorySheet({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<{ roomId: string; finalChips: number; createdAt: string; room?: Room }[]>([]); useEffect(() => { api.history().then((result) => setItems(result.settlements)).catch(() => undefined); }, []);
  return <Sheet title="历史结算" onClose={onClose}><div className="historyList">{items.length ? items.map((item) => <article key={`${item.roomId}-${item.createdAt}`} className="historyRow"><span className="ledgerGlyph"><Icon name="history" /></span><div><strong>{item.room?.name ?? '已归档牌局'}</strong><small>{new Date(item.createdAt).toLocaleString('zh-CN')}</small></div><b>{format(item.finalChips)}</b></article>) : <div className="emptyState compactEmpty"><Icon name="history" size={28} /><h3>暂无历史结算</h3><p>房主解散房间后，会在这里保留你自己的最终积分。</p></div>}</div></Sheet>;
}
