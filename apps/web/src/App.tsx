import { FormEvent, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { io, type Socket } from 'socket.io-client';
import { api, subscribeSessionExpired, type HandHistoryItem, type HandReplay, type LedgerEntry, type Member, type Player, type Room, type RoomView } from './api';
import { subscribeTableAudio, tableAudio } from './audio';
import { copyText } from './clipboard';
import { bindTableSession, type TableSession, type TableSessionSocket } from './table-session';
import { tableSoundEvents } from './table-sound-events';
import { inviteCodeFromPath } from './invite-route';
import { buildReplayStages, describeReplayMoment, type ReplayCard } from './hand-replay';
import { participantStatus, seatLayout } from './table-view';

type NoticeTone = 'success' | 'error';
type Notice = { tone: NoticeTone; text: string } | null;
type LegalActions = {
  canFold: boolean; canCheck: boolean; canCall: boolean; canRaise: boolean;
  toCall: number; callAmount: number; minRaiseTo: number; maxRaiseTo: number; raiseAllInOnly: boolean;
};
type TableSnapshot = {
  sequence: number;
  players: Array<{ id: string; nickname: string; seat: number; stack: number; connected: boolean; participation: 'seated' | 'waiting' | 'sitting-out'; folded: boolean; allIn: boolean; bet: number; contribution: number; hole?: Array<{ rank: number; suit: string }> }>;
  preparing?: { id: string; number: number; commitment: string; participantIds: string[]; readyPlayerIds: string[] };
  hand?: {
    id: string; number: number; commitment: string; board: Array<{ rank: number; suit: string }>; street: string;
    dealerSeat: number; smallBlindSeat: number; bigBlindSeat: number; currentPlayerId?: string;
    currentBet: number; minRaise: number; status: 'active' | 'settled'; potTotal: number;
    pots: Array<{ amount: number; eligiblePlayerIds: string[] }>; legalActions?: LegalActions;
  };
  timing?: { serverNow: number; actionDeadlineAt?: number; nextHandStartsAt?: number; reconnectDeadlines?: Record<string, number>; waitingForReconnect?: boolean; waitingForPlayers?: boolean };
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
const randomContribution = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) => value.toString(16).padStart(2, '0')).join('');

function Icon({ name, size = 20 }: { name: 'plus' | 'lock' | 'settings' | 'arrow' | 'users' | 'copy' | 'link' | 'close' | 'history' | 'sound' | 'soundOff' | 'back' | 'more' | 'refresh'; size?: number }) {
  const paths = {
    plus: <><path d="M12 5v14M5 12h14" /></>, lock: <><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9 7 7m10 10 2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" /></>,
    arrow: <path d="m9 18 6-6-6-6" />, users: <><circle cx="9" cy="8" r="3" /><path d="M3.5 20c.6-3.2 2.5-5 5.5-5s4.9 1.8 5.5 5M17 11a3 3 0 1 0-1-5.8M16.5 15.1c2.3.3 3.7 1.9 4 4.9" /></>,
    copy: <><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" /></>, link: <><path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" /><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1" /></>, close: <path d="m6 6 12 12M18 6 6 18" />,
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

function ReplayCards({ cards, compact = false, emptyText }: { cards: ReplayCard[]; compact?: boolean; emptyText?: string }) {
  if (!cards.length) return emptyText ? <span className="replayCardsEmpty">{emptyText}</span> : null;
  return <span className={`replayCards ${compact ? 'compact' : ''}`} aria-label={cards.map((card) => `${cardRank(card.rank)}${cardSuit(card.suit)}`).join(' ')}>{cards.map((card, index) => <span key={`${card.rank}-${card.suit}-${index}`} className={`replayCard ${card.suit === 'H' || card.suit === 'D' ? 'red' : ''}`}><b>{cardRank(card.rank)}</b><i>{cardSuit(card.suit)}</i></span>)}</span>;
}

function HandReplayDetail({ replay, onBack, onDownload }: { replay: HandReplay; onBack: () => void; onDownload: (handId: string) => void }) {
  const playerNames = useMemo(() => new Map(replay.players.map((item) => [item.id, item.nickname])), [replay.players]);
  const stages = useMemo(() => buildReplayStages(replay), [replay]);
  const totalPot = replay.result.pots.reduce((sum, pot) => sum + pot.amount, 0);
  const payouts = Object.entries(replay.result.payouts).filter(([, amount]) => amount > 0).sort(([, first], [, second]) => second - first);
  const winners = payouts.map(([id]) => playerNames.get(id) ?? '未知玩家');
  const sortedPlayers = [...replay.players].sort((first, second) => second.pointDelta - first.pointDelta);
  const playerName = (id?: string) => id ? playerNames.get(id) ?? '未知玩家' : '未知玩家';
  const resultText = replay.result.settledBy === 'showdown'
    ? `${winners.join('、') || '获胜玩家'} 摊牌胜出`
    : `${winners.join('、') || '获胜玩家'} 收下底池`;

  return <article className="replayDetail">
    <button className="replayBack" onClick={onBack}><Icon name="back" size={18} /> 返回手牌列表</button>
    <header className="replayHeading">
      <div><span className="replayEyebrow">HAND #{replay.handNumber}</span><h3>第 {replay.handNumber} 手回放</h3><p>{new Date(replay.settledAt).toLocaleString('zh-CN')} · 盲注 {format(replay.blinds.small)} / {format(replay.blinds.big)}</p></div>
      <span className={`replayResultBadge ${replay.result.settledBy}`}>{replay.result.settledBy === 'showdown' ? '摊牌' : '弃牌结束'}</span>
    </header>

    <section className="replayHero" aria-label="本手结果摘要">
      <div className="replayHeroPot"><span>总底池</span><strong>{format(totalPot)}</strong><small>{replay.result.pots.length > 1 ? `${replay.result.pots.length - 1} 个边池` : '单一底池'}</small></div>
      <div className="replayHeroResult"><strong>{resultText}</strong><ReplayCards cards={replay.board} emptyText="未发公共牌" /></div>
    </section>

    <section className="replaySection" aria-labelledby="replay-player-results">
      <header className="replaySectionHeader"><div><h4 id="replay-player-results">玩家结果</h4><p>按本手积分变化排序</p></div></header>
      <div className="replayPlayerList">{sortedPlayers.map((replayPlayer) => <div className="replayPlayerRow" key={replayPlayer.id}>
        <span className="replayAvatar">{replayPlayer.nickname.slice(0, 1)}</span>
        <div className="replayPlayerIdentity"><strong>{replayPlayer.nickname}</strong>{replayPlayer.hole ? <ReplayCards cards={replayPlayer.hole} compact /> : <small>手牌未公开</small>}</div>
        <strong className={`replayDelta ${replayPlayer.pointDelta > 0 ? 'positive' : replayPlayer.pointDelta < 0 ? 'negative' : 'even'}`}>{replayPlayer.pointDelta > 0 ? '+' : ''}{format(replayPlayer.pointDelta)}</strong>
      </div>)}</div>
      {replay.result.pots.length > 1 && <div className="replayPots">{replay.result.pots.map((pot, index) => <span key={index}><small>{index === 0 ? '主池' : `边池 ${index}`}</small><b>{format(pot.amount)}</b></span>)}</div>}
    </section>

    <section className="replaySection" aria-labelledby="replay-action-timeline">
      <header className="replaySectionHeader"><div><h4 id="replay-action-timeline">行动过程</h4><p>从盲注到派奖，按牌局顺序还原</p></div></header>
      <div className="replayStreetList">{stages.map((stage, stageIndex) => <section className="replayStreet" key={stage.id}>
        <header className="replayStreetHeader"><span>{stageIndex + 1}</span><div><h5>{stage.label}</h5>{stage.board.length > 0 && <ReplayCards cards={stage.board} compact />}</div></header>
        <div className="replayMoments">{stage.moments.length ? stage.moments.map((moment) => {
          const description = describeReplayMoment(moment, playerName, format);
          return <div className={`replayMoment ${description.tone}`} key={moment.sequence}><span className="replayMomentDot" /><div><strong>{description.title}</strong>{description.detail && <small>{description.detail}</small>}</div></div>;
        }) : <p className="replayNoAction">无需继续行动，公共牌自动发出</p>}</div>
      </section>)}</div>
    </section>

    <details className="auditDetails">
      <summary><span><strong>审计与技术详情</strong><small>事件编号、系统事件和原始数据</small></span><Icon name="arrow" size={17} /></summary>
      <div className="auditDetailsBody"><p>仅在核验牌局时需要查看；普通回放无需阅读这些数据。</p><button className="secondary small auditDownload" onClick={() => onDownload(replay.handId)}>下载完整审计材料</button><ol>{replay.events.map((event) => <li key={event.sequence}><strong>#{event.sequence} {event.type}</strong><code>{JSON.stringify(event.payload)}</code></li>)}</ol></div>
    </details>
  </article>;
}

function GuestGate({ onCreated }: { onCreated: (player: Player) => void }) {
  const [nickname, setNickname] = useState(''); const [error, setError] = useState(''); const [working, setWorking] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setError(''); setWorking(true); try { onCreated((await api.guest(nickname)).player); } catch (reason) { setError((reason as Error).message); } finally { setWorking(false); } };
  return <main className="gate"><div className="orb orbOne" /><div className="orb orbTwo" /><section className="gateCard"><span className="brandMark"><Icon name="lock" size={24} /></span><p className="eyebrow">INVITATION ONLY</p><h1>River Table</h1><p className="lead">只和熟悉的人一起玩。创建一个设备身份，即可进入受邀制私人牌局。</p><form onSubmit={submit} noValidate><label htmlFor="nickname">你的牌桌昵称</label><input id="nickname" value={nickname} maxLength={16} autoFocus placeholder="例如 深海玩家" onChange={(event) => setNickname(event.target.value)} aria-describedby={error ? 'nickname-error' : undefined} /><p className="helper">仅保存在本设备；清理浏览器数据后无法找回。</p>{error && <p id="nickname-error" className="fieldError">{error}</p>}<button className="primary wide" disabled={working}>{working ? '正在创建…' : '开始我的私人牌局'} <Icon name="arrow" /></button></form></section></main>;
}

export function App() {
  const [player, setPlayer] = useState<Player | null | undefined>(undefined); const [rooms, setRooms] = useState<Room[]>([]);
  const [pendingInviteCode, setPendingInviteCode] = useState(() => inviteCodeFromPath(window.location.pathname));
  const [selectedRoom, setSelectedRoom] = useState<RoomView | null>(null); const [tableOpen, setTableOpen] = useState(false); const [sheet, setSheet] = useState<'create' | 'join' | 'history' | 'settings' | null>(() => pendingInviteCode ? 'join' : null); const [notice, setNotice] = useState<Notice>(null);
  const audioEnabled = useSyncExternalStore(subscribeTableAudio, tableAudio.getEnabled, tableAudio.getEnabled);
  const notify = useCallback((tone: NoticeTone, text: string) => { setNotice({ tone, text }); setTimeout(() => setNotice(null), 3200); }, []);
  const refreshRooms = async () => { try { setRooms((await api.rooms()).rooms); } catch (reason) { if ((reason as Error).message.includes('游客')) setPlayer(null); else notify('error', (reason as Error).message); } };
  useEffect(() => { api.me().then(({ player }) => { setPlayer(player); if (player) void refreshRooms(); }).catch(() => setPlayer(null)); }, []);
  useEffect(() => subscribeSessionExpired(() => {
    setPlayer(null);
    setRooms([]);
    setSelectedRoom(null);
    setTableOpen(false);
    setSheet(null);
  }), []);
  const refreshRoom = async (id: string) => { setSelectedRoom((await api.room(id)).room); };
  const openRoom = async (id: string) => { try { setTableOpen(false); await refreshRoom(id); } catch (reason) { notify('error', (reason as Error).message); } };
  if (player === undefined) return <div className="loading">正在连接 River Table…</div>;
  if (!player) return <GuestGate onCreated={(next) => { setPlayer(next); void refreshRooms(); }} />;
  return <main className={tableOpen ? 'appShell tableMode' : 'appShell'}>{!tableOpen && <header className="topbar"><button className="iconButton" aria-label="打开设置" onClick={() => setSheet('settings')}><Icon name="settings" /></button><div className="wordmark"><strong>RIVER TABLE</strong><span>受邀制私人牌局</span></div><button className="avatarButton" aria-label="查看个人资料" onClick={() => setSheet('settings')}>{player.nickname.slice(0, 1)}</button></header>}
    {selectedRoom ? <RoomScreen player={player} room={selectedRoom} onBack={() => { setTableOpen(false); setSelectedRoom(null); void refreshRooms(); }} onRefresh={() => refreshRoom(selectedRoom.id)} onTableChange={setTableOpen} notify={notify} /> : <Dashboard rooms={rooms} onCreate={() => setSheet('create')} onJoin={() => setSheet('join')} onOpen={openRoom} />}
    {notice && <div className={`toast ${notice.tone}`} role="status">{notice.text}</div>}
    {sheet === 'create' && <CreateRoomSheet onClose={() => setSheet(null)} onCreated={(room) => { setSheet(null); void refreshRooms(); void openRoom(room.id); notify('success', '私人房已创建'); }} notify={notify} />}
    {sheet === 'join' && <JoinRoomSheet initialCode={pendingInviteCode} onClose={() => setSheet(null)} onJoined={(room) => { setPendingInviteCode(undefined); history.replaceState(null, '', '/'); setSheet(null); void refreshRooms(); void openRoom(room.id); notify('success', '已加入私人房'); }} />}
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

function JoinRoomSheet({ initialCode, onClose, onJoined }: { initialCode?: string; onClose: () => void; onJoined: (room: Room) => void }) {
  const [code, setCode] = useState(initialCode ?? ''); const [error, setError] = useState(''); const [working, setWorking] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setError(''); setWorking(true); try { onJoined((await api.join(code)).room); } catch (reason) { setError((reason as Error).message); } finally { setWorking(false); } };
  return <Sheet title="加入私人房" onClose={onClose}><p className="sheetIntro">输入好友分享的邀请码。加入后，你可以在“我的牌局”中再次进入。</p><form onSubmit={submit} className="form"><label htmlFor="inviteCode">邀请码<input id="inviteCode" value={code} placeholder="例如 RIVER-3XK9…" maxLength={40} autoCapitalize="characters" onChange={(event) => setCode(event.target.value.toUpperCase())} /></label>{error && <p className="fieldError">{error}</p>}<button className="primary wide" disabled={working}>{working ? '正在验证…' : '加入牌局'} <Icon name="arrow" /></button></form></Sheet>;
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
    const copied = await copyText(value);
    notify(copied ? 'success' : 'error', copied ? `${label}已复制` : '当前浏览器不支持复制');
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
      if (result.room.status === 'closing') await onRefresh();
      else onBack();
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
  const rotateInvite = async () => {
    setWorking(true);
    try {
      await api.rotateInvite(room.id);
      notify('success', '邀请码已轮换，旧链接立即失效');
      await onRefresh();
    } catch (reason) {
      notify('error', (reason as Error).message);
    } finally {
      setWorking(false);
    }
  };
  const togglePause = async () => {
    setWorking(true);
    try {
      const result = room.status === 'paused' ? await api.resume(room.id) : await api.pause(room.id);
      notify('success', result.room.status === 'pausing' ? '本手结束后暂停' : result.room.status === 'paused' ? '牌局已暂停' : '牌局已恢复');
      await onRefresh();
    } catch (reason) {
      notify('error', (reason as Error).message);
    } finally {
      setWorking(false);
    }
  };
  const removeMember = async (member: Member) => {
    if (!confirm(`确定移除 ${member.nickname} 吗？正在进行的手牌会先结算。`)) return;
    setWorking(true);
    try {
      await api.removeMember(room.id, member.id);
      notify('success', `${member.nickname} 已移除或将在本手结束后移除`);
      await syncRoomData();
    } catch (reason) {
      notify('error', (reason as Error).message);
    } finally {
      setWorking(false);
    }
  };

  if (screen === 'table') return <TableScreen room={room} player={player} onBack={() => { onTableChange(false); setScreen('room'); void onRefresh(); }} notify={notify} />;

  return <div className="page roomPage">
    <header className="roomTop">
      <button className="iconButton" onClick={onBack} aria-label="返回我的牌局"><Icon name="back" /></button>
      <div><p className="eyebrow">{room.isHost ? 'ROOM ADMIN' : 'INVITED PLAYER'}</p><h1>{room.name}</h1><p>{room.smallBlind} / {room.bigBlind} · {room.maxSeats} 人桌</p></div>
    </header>
    {room.isHost && <section className="inviteCard">
      <div className="inviteDetails"><p className="eyebrow">仅受邀玩家可进入</p><strong className="inviteCode">{room.inviteCode}</strong><p>{room.inviteOpen ? '邀请码有效，可分享给熟悉的好友' : '邀请已关闭'}</p></div>
      <div className="inviteActions"><button type="button" className="secondary small" onClick={() => copy(room.inviteCode, '邀请码')}><Icon name="copy" />复制邀请码</button><button type="button" className="secondary small" onClick={() => copy(`${location.origin}/join/${room.inviteCode}`, '邀请链接')}><Icon name="link" />复制链接</button></div>
    </section>}
    <div className="roomButtons">
      <button className="primary" disabled={['closing', 'dissolved'].includes(room.status)} onClick={() => { tableAudio.enterTable(); setScreen('table'); }}>进入牌桌 <Icon name="arrow" /></button>
      {room.isHost && <button className={room.inviteOpen ? 'secondary' : 'secondary selectedOutline'} disabled={working} onClick={toggleInvite}><Icon name="lock" /> {room.inviteOpen ? '关闭邀请' : '开启邀请'}</button>}
    </div>
    {room.isHost && <div className="hostControlGrid">
      <button className="secondary small" disabled={working || !room.inviteOpen} onClick={rotateInvite}>轮换邀请码</button>
      <button className="secondary small" disabled={working || !['active', 'paused'].includes(room.status)} onClick={togglePause}>{room.status === 'paused' ? '恢复牌局' : room.status === 'pausing' ? '等待暂停' : '暂停牌局'}</button>
    </div>}
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
        {room.isHost && <div className="memberControls"><div className="creditControl"><input aria-label={`向 ${member.nickname} 补充积分`} type="number" inputMode="numeric" min="1" step="100" placeholder="输入积分" value={creditValue(member.id)} onChange={(event) => setAmounts((state) => ({ ...state, [member.id]: event.target.value }))} /><button className="secondary compact" disabled={working || !validCreditAmount(member.id)} onClick={() => credit(member)}>补充</button></div>{member.id !== player.id && <button className="memberRemove" disabled={working} onClick={() => removeMember(member)}>移除</button>}</div>}
      </article>)}
    </div>
    <section className="sectionHeader slim"><div><h2>积分记录</h2><p>追加式记录，不可直接修改余额</p></div></section>
    <div className="ledgerList">
      {ledger.length ? ledger.slice(0, 8).map((entry) => {
        const targetName = memberNames.get(entry.playerId) ?? '玩家';
        const label = entry.reason === 'initial' ? `${targetName} · 初始积分` : entry.reason === 'hand-settlement' ? `${targetName} · 手牌结算` : `已向 ${targetName} 补充`;
        return <div className="ledgerItem" key={entry.id}><span className="ledgerGlyph"><Icon name="history" size={16} /></span><div><strong>{label}</strong><small>{new Date(entry.createdAt).toLocaleString('zh-CN')}</small></div><b>{entry.amount >= 0 ? '+' : ''}{format(entry.amount)}</b></div>;
      }) : <p className="emptyInline">暂无积分记录</p>}
    </div>
    {room.isHost && <button className="danger" disabled={working || ['closing', 'dissolved'].includes(room.status)} onClick={dissolve}>解散房间并生成结算记录</button>}
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

function ReconnectClock({ playerId, timing }: { playerId: string; timing: TableSnapshot['timing'] }) {
  const serverDeadline = timing?.reconnectDeadlines?.[playerId];
  const deadline = useMemo(() => localDeadline(serverDeadline, timing?.serverNow), [serverDeadline, timing?.serverNow]);
  const seconds = useCountdown(deadline);
  if (seconds === undefined) return <i>离线</i>;
  return <i role="timer" aria-label={`重连宽限期剩余 ${seconds} 秒`}>重连 {seconds}s</i>;
}

function NextHandClock({ timing }: { timing: TableSnapshot['timing'] }) {
  const deadline = useMemo(() => localDeadline(timing?.nextHandStartsAt, timing?.serverNow), [timing?.nextHandStartsAt, timing?.serverNow]);
  const seconds = useCountdown(deadline);
  if (timing?.waitingForReconnect) return <div className="nextHandClock waitingForPlayers" role="status" aria-live="polite" data-phase="waiting-for-reconnect"><span>本手已结算</span><strong>等待玩家重连</strong><small>60 秒宽限期后自动暂离</small></div>;
  if (timing?.waitingForPlayers) return <div className="nextHandClock waitingForPlayers" role="status" aria-live="polite" data-phase="waiting-for-players"><span>本手已结算</span><strong>等待补充积分</strong><small>需至少 2 位有积分玩家</small></div>;
  return <div className="nextHandClock" role="timer" aria-live="polite" data-phase="next-hand"><span>本手已结算 · 下一手</span><strong>{seconds ?? '…'}</strong><small>秒</small></div>;
}

function BetControls({ hand, legal, me, mine, playerNickname, onAction }: {
  hand?: HandSnapshot;
  legal?: LegalActions;
  me?: TableSnapshot['players'][number];
  mine: boolean;
  playerNickname: string;
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
    <div className="actionPlayerInfo" aria-label={`当前玩家 ${me?.nickname ?? playerNickname}，筹码 ${format(me?.stack ?? 0)}`}>
      <span className="actionPlayerName" title={me?.nickname ?? playerNickname}>{me?.nickname ?? playerNickname}</span>
      <span className="actionPlayerStack"><span>筹码</span><strong>{format(me?.stack ?? 0)}</strong></span>
    </div>
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
  const [snapshot, setSnapshot] = useState<TableSnapshot | null>(null); const [starting, setStarting] = useState(false); const [auditStatus, setAuditStatus] = useState<string>(); const [handHistory, setHandHistory] = useState<HandHistoryItem[] | null>(null); const [selectedReplay, setSelectedReplay] = useState<HandReplay | null>(null); const [replayLoadingId, setReplayLoadingId] = useState<string>(); const socketRef = useRef<Socket | null>(null);
  const tableSessionRef = useRef<TableSession | null>(null);
  const previousSnapshot = useRef<TableSnapshot | null>(null);
  const contributedHands = useRef(new Set<string>());
  const audioEnabled = useSyncExternalStore(subscribeTableAudio, tableAudio.getEnabled, tableAudio.getEnabled);
  useEffect(() => { tableAudio.enterTable(); return () => tableAudio.leaveTable(); }, []);
  useEffect(() => { const socket = io({ path: '/socket.io', transports: ['websocket'], autoConnect: false }); socketRef.current = socket; const acceptSnapshot = (next: TableSnapshot) => {
    const previous = previousSnapshot.current; const previousHand = previous?.hand; const nextHand = next.hand;
    if (previous && nextHand) {
      for (const cue of tableSoundEvents(previous, next, player.id)) tableAudio.play(cue);
      if (previousHand?.status !== 'settled' && nextHand.status === 'settled') notify('success', next.timing?.waitingForPlayers ? '本手已结算，等待至少两位有积分玩家' : '本手已结算，下一手即将自动开始');
    }
    const preparing = next.preparing;
    if (preparing?.participantIds.includes(player.id) && !preparing.readyPlayerIds.includes(player.id) && !contributedHands.current.has(preparing.id)) {
      contributedHands.current.add(preparing.id);
      socket.emit('shuffle:contribute', { handId: preparing.id, contribution: randomContribution() }, (response: { ok: boolean; error?: string }) => {
        if (!response.ok) {
          contributedHands.current.delete(preparing.id);
          notify('error', response.error ?? '随机贡献提交失败');
        }
      });
    }
    previousSnapshot.current = next;
    setSnapshot(next);
  }; const refreshSnapshot = () => api.table(room.id, previousSnapshot.current?.sequence).then((result) => acceptSnapshot(result.snapshot as TableSnapshot)); const tableSession = bindTableSession({
    socket: socket as unknown as TableSessionSocket,
    roomId: room.id,
    refreshSnapshot,
    onJoinError: (message) => notify('error', message)
  }); tableSessionRef.current = tableSession; socket.on('table:snapshot', acceptSnapshot); socket.on('table:revoked', () => { notify('error', '你已不再是该房间成员'); onBack(); }); void refreshSnapshot().catch(() => undefined); socket.connect(); return () => { tableSession.dispose(); if (tableSessionRef.current === tableSession) tableSessionRef.current = null; socket.disconnect(); }; }, [room.id, player.id, notify]);
  const me = snapshot?.players.find((item) => item.id === player.id); const hand = snapshot?.hand; const legal = hand?.legalActions; const mine = hand?.currentPlayerId === player.id && !!legal;
  const act = (type: TableActionType, amount?: number) => {
    if (!hand) return;
    socketRef.current?.emit('action:submit', {
      actionId: crypto.randomUUID(),
      handId: hand.id,
      version: snapshot?.sequence,
      type,
      ...(type === 'raise' ? { raiseTo: amount } : {})
    }, (response: { ok: boolean; error?: string }) => {
      if (response.ok) return;
      if (response.error === '尚未进入牌桌') {
        tableSessionRef.current?.recover();
        notify('error', '牌桌连接已恢复，请根据最新牌面重试');
        return;
      }
      notify('error', response.error ?? '操作未执行');
    });
  };
  const heroSeat = me?.seat ?? 1;
  const waitingCount = snapshot?.players.filter((item) => item.seat === 0 && item.participation === 'waiting').length ?? 0;
  const seats = useMemo(() => seatLayout(room.maxSeats, heroSeat, snapshot?.players ?? []), [heroSeat, room.maxSeats, snapshot?.players]);
  const readyPlayerCount = snapshot?.players.filter((item) => item.stack > 0 && item.participation !== 'sitting-out').length ?? 0;
  const canStart = room.isHost && !hand && !snapshot?.preparing && readyPlayerCount >= 2;
  const startHand = () => { if (!socketRef.current) return; setStarting(true); socketRef.current.emit('table:start', (response: { ok: boolean; error?: string }) => { setStarting(false); if (!response.ok) notify('error', response.error ?? '无法开始牌局'); }); };
  const positionLabel = (seat: number) => {
    if (!hand) return undefined;
    const labels = [seat === hand.dealerSeat && 'D', seat === hand.smallBlindSeat && 'SB', seat === hand.bigBlindSeat && 'BB'].filter(Boolean);
    return labels.join('·') || undefined;
  };
  const showPotBreakdown = hand?.pots.slice(1).some((pot) => pot.eligiblePlayerIds.length > 1);
  const toggleParticipation = async () => {
    try {
      if (me?.participation === 'sitting-out') await api.sitIn(room.id); else await api.sitOut(room.id);
      socketRef.current?.emit('table:sync');
    } catch (reason) { notify('error', (reason as Error).message); }
  };
  const verifyAudit = async () => {
    if (!hand) return;
    try {
      const { audit } = await api.audit(room.id, hand.id);
      const commitmentBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${audit.algorithmVersion}:${audit.serverSeed}`));
      const localCommitment = [...new Uint8Array(commitmentBytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
      if (localCommitment !== audit.commitment) throw new Error('本地洗牌承诺校验失败');
      const verification = await api.verifyAudit(room.id, hand.id);
      if (!verification.verified) throw new Error('发牌、底池或派奖验证失败');
      setAuditStatus(`本地承诺与完整复算通过 · ${new Date(verification.expiresAt).toLocaleDateString('zh-CN')} 前可查`);
    } catch (reason) { notify('error', (reason as Error).message); }
  };
  const openHandHistory = async () => {
    try { setHandHistory((await api.hands(room.id)).hands); }
    catch (reason) { notify('error', (reason as Error).message); }
  };
  const openReplay = async (handId: string) => {
    setReplayLoadingId(handId);
    try { setSelectedReplay((await api.replay(room.id, handId)).replay); }
    catch (reason) { notify('error', (reason as Error).message); }
    finally { setReplayLoadingId(undefined); }
  };
  const downloadAudit = async (handId: string) => {
    try {
      const { audit } = await api.audit(room.id, handId);
      const url = URL.createObjectURL(new Blob([JSON.stringify(audit, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `river-hand-${audit.handNumber}-audit.json`; link.click(); URL.revokeObjectURL(url);
    } catch (reason) { notify('error', (reason as Error).message); }
  };
  return <div className="tableScreen">
    <header className="tableHeader"><button className="iconButton" aria-label="返回房间" onClick={onBack}><Icon name="back" /></button><div><strong>{room.name}</strong><span>{room.smallBlind} / {room.bigBlind} · {hand ? `第 ${hand.number} 手` : '等待玩家入桌'}</span></div><button className="iconButton" aria-label="手牌记录" onClick={() => void openHandHistory()}><Icon name="history" /></button><button className="seatToggle" onClick={toggleParticipation}>{me?.participation === 'sitting-out' ? '坐入' : '暂离'}</button><button className={`iconButton audioToggle ${audioEnabled ? '' : 'muted'}`} aria-label={`音效与背景音乐已${audioEnabled ? '开启' : '关闭'}`} aria-pressed={audioEnabled} onClick={() => { const next = !audioEnabled; tableAudio.setEnabled(next); if (next) tableAudio.play('turn'); }}><Icon name={audioEnabled ? 'sound' : 'soundOff'} /></button></header>
    <div className="tableArea" data-table-size={room.maxSeats}>
      <div className="privateStrip"><Icon name="lock" size={13} /> 仅受邀玩家可进入</div><div className="felt"><div className="feltInner" /></div>
      {me?.seat === 0 && me.participation === 'waiting' && <div className="waitingNotice" role="status"><strong>正在候补座位</strong><span>本手不参与发牌；结算后按进入顺序坐入{waitingCount > 1 ? ` · 当前 ${waitingCount} 人等待` : ''}</span></div>}
      {hand && <div className="pot"><span>总底池</span><b>{format(hand.potTotal)}</b>{showPotBreakdown && <small>{hand.pots.map((pot, index) => `${index === 0 ? '主池' : `边池${index}`} ${format(pot.amount)}`).join(' · ')}</small>}</div>}
      {hand?.status === 'settled' && <NextHandClock timing={snapshot?.timing} />}
      {hand?.status === 'settled' && me?.hole?.length === 2 && <button className="auditButton" onClick={verifyAudit}>{auditStatus ?? '验证本手发牌'}</button>}
      <div className="board" aria-label="公共牌">{Array.from({ length: 5 }, (_, index) => { const card = hand?.board[index]; return <div className={card ? `playingCard ${card.suit === 'H' || card.suit === 'D' ? 'red' : ''}` : 'playingCard blank'} key={index}>{card && <><span>{cardRank(card.rank)}</span><b>{cardSuit(card.suit)}</b></>}</div>; })}</div>
      <div className="seatRing">{seats.map(({ player: seat, physicalSeat, visualOffset }) => {
        const isTurn = hand?.status === 'active' && hand.currentPlayerId === seat?.id;
        const badge = positionLabel(physicalSeat);
        const status = seat && participantStatus(seat);
        return <div className={`seat relativeSeat${visualOffset} ${seat?.id === player.id ? 'local' : ''} ${seat?.folded ? 'folded' : ''} ${isTurn ? 'activeTurn' : ''}`} data-physical-seat={physicalSeat} data-visual-offset={visualOffset} data-participation={seat?.participation} key={physicalSeat}>{seat ? <><span className="seatAvatarWrap"><span className="seatAvatar">{seat.nickname.slice(0, 1)}</span>{badge && <span className="positionBadge">{badge}</span>}{isTurn && <SeatActionClock timing={snapshot?.timing} isMine={seat.id === player.id} />}</span><span className="seatLabel"><b>{seat.nickname}{seat.id === player.id && '（你）'}</b>{seat.folded ? '已弃牌' : seat.allIn ? '全下' : format(seat.stack)}{!seat.connected ? <ReconnectClock playerId={seat.id} timing={snapshot?.timing} /> : status && <i>{status}</i>}</span>{seat.bet > 0 && <span className="seatBet">已投入 {format(seat.bet)}</span>}</> : <span className="openSeat">空位</span>}</div>;
      })}</div>
      {me?.hole && <div className="holeCards" aria-label="你的手牌">{me.hole.map((card, index) => <div key={index} className={`playingCard personal ${card.suit === 'H' || card.suit === 'D' ? 'red' : ''}`}><span>{cardRank(card.rank)}</span><b>{cardSuit(card.suit)}</b></div>)}</div>}
      {!hand && <div className="waiting"><Icon name="users" size={26} /><strong>{snapshot?.preparing ? '正在收集本手随机贡献' : canStart ? '牌桌已就绪' : '等待至少一位受邀好友入桌'}</strong><p>{snapshot?.preparing ? `服务端已提交洗牌承诺，等待 ${snapshot.preparing.participantIds.length - snapshot.preparing.readyPlayerIds.length} 位玩家完成贡献。` : canStart ? `已有 ${readyPlayerCount} 位有积分玩家入桌，请由房主开始第一手。` : '至少两位有积分的受邀玩家入桌后，房主即可开始牌局。'}</p>{room.isHost && <button className="primary tableStartButton" disabled={!canStart || starting} onClick={startHand}>{starting ? '正在开始…' : '开始第一手'} <Icon name="arrow" /></button>}</div>}
    </div>
    <BetControls key={`${hand?.number ?? 0}:${hand?.street ?? 'waiting'}:${hand?.currentPlayerId ?? 'none'}:${hand?.currentBet ?? 0}:${me?.bet ?? 0}`} hand={hand} legal={legal} me={me} mine={mine} playerNickname={player.nickname} onAction={act} />
    {handHistory && <Sheet title={selectedReplay ? '手牌回放' : '最近 10 天手牌'} onClose={() => { setHandHistory(null); setSelectedReplay(null); setReplayLoadingId(undefined); }}>{selectedReplay ? <HandReplayDetail replay={selectedReplay} onBack={() => setSelectedReplay(null)} onDownload={(handId) => void downloadAudit(handId)} /> : <div className="historyList handHistoryList">{handHistory.length ? handHistory.map((item) => {
      const myDelta = item.pointDeltas[player.id] ?? 0;
      const potTotal = item.pots.reduce((sum, pot) => sum + pot.amount, 0);
      const loading = replayLoadingId === item.handId;
      return <button className="handHistoryRow" key={item.handId} disabled={!!replayLoadingId} onClick={() => void openReplay(item.handId)} aria-label={`查看第 ${item.handNumber} 手牌回放`}>
        <span className="ledgerGlyph"><Icon name="history" /></span>
        <span className="handHistoryMain"><span><strong>第 {item.handNumber} 手</strong><i className={item.settledBy}>{item.settledBy === 'showdown' ? '摊牌' : '弃牌结束'}</i></span><small>{new Date(item.settledAt).toLocaleString('zh-CN')} · {item.participants.length} 位玩家</small><ReplayCards cards={item.board} compact emptyText="未发公共牌" /></span>
        <span className="handHistoryOutcome"><strong className={myDelta > 0 ? 'positive' : myDelta < 0 ? 'negative' : 'even'}>{myDelta > 0 ? '+' : ''}{format(myDelta)}</strong><small>{loading ? '正在加载…' : '我的盈亏'}</small><b>底池 {format(potTotal)}</b></span>
      </button>;
    }) : <div className="emptyState compactEmpty"><Icon name="history" size={28} /><h3>暂无手牌记录</h3><p>结算后的手牌会在这里保留 10 天。</p></div>}</div>}</Sheet>}
  </div>;
}

function HistorySheet({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<{ roomId: string; finalChips: number; createdAt: string; room?: Room }[]>([]); useEffect(() => { api.history().then((result) => setItems(result.settlements)).catch(() => undefined); }, []);
  return <Sheet title="历史结算" onClose={onClose}><div className="historyList">{items.length ? items.map((item) => <article key={`${item.roomId}-${item.createdAt}`} className="historyRow"><span className="ledgerGlyph"><Icon name="history" /></span><div><strong>{item.room?.name ?? '已归档牌局'}</strong><small>{new Date(item.createdAt).toLocaleString('zh-CN')}</small></div><b>{format(item.finalChips)}</b></article>) : <div className="emptyState compactEmpty"><Icon name="history" size={28} /><h3>暂无历史结算</h3><p>房主解散房间后，会在这里保留你自己的最终积分。</p></div>}</div></Sheet>;
}
