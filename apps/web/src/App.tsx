import { FormEvent, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { io, type Socket } from 'socket.io-client';
import { api, subscribeSessionExpired, type HandHistoryItem, type HandReplay, type LedgerEntry, type Member, type Player, type Room, type RoomView } from './api';
import { subscribeTableAudio, tableAudio } from './audio';
import { copyText } from './clipboard';
import { bindTableSession, type TableSession, type TableSessionSocket } from './table-session';
import { tableSoundEvents } from './table-sound-events';
import { inviteCodeFromInput, inviteCodeFromPath } from './invite-route';
import { buildReplayStages, describeReplayMoment, type ReplayCard } from './hand-replay';
import { seatBorderState, seatLayout, settlementWinners } from './table-view';
import { createVerificationPackage, verifyAuditMaterial } from '../../../packages/audit-verifier/index.js';

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
    lastAction?: { sequence: number; playerId: string; type: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allIn' };
    pots: Array<{ amount: number; eligiblePlayerIds: string[] }>;
    settlement?: { settledBy: 'fold' | 'showdown'; payouts: Record<string, number> };
    legalActions?: LegalActions;
  };
  timing?: { serverNow: number; actionDeadlineAt?: number; nextHandStartsAt?: number; reconnectDeadlines?: Record<string, number>; waitingForReconnect?: boolean; waitingForPlayers?: boolean };
};
type HandSnapshot = NonNullable<TableSnapshot['hand']>;
type TableActionType = 'fold' | 'check' | 'call' | 'raise';
type QuickBetOption = { id: string; label: string; target: number };

function roundUpToChipUnit(value: number, chipUnit: number): number {
  return Math.ceil(value / chipUnit) * chipUnit;
}

function isLegalRaiseTarget(hand: HandSnapshot, legal: LegalActions, target: number, chipUnit: number): boolean {
  if (!legal.canRaise || target <= hand.currentBet || target > legal.maxRaiseTo) return false;
  return target === legal.maxRaiseTo || (target >= legal.minRaiseTo && target % chipUnit === 0);
}

export function quickBetOptions(hand: HandSnapshot, legal: LegalActions, smallBlind: number): QuickBetOption[] {
  if (!legal.canRaise) return [];
  const normalTarget = (candidate: number): number | undefined => {
    const target = roundUpToChipUnit(Math.max(candidate, legal.minRaiseTo), smallBlind);
    return target < legal.maxRaiseTo ? target : undefined;
  };
  const presets = hand.currentBet === 0
    ? [
      { id: 'third', label: '1/3 池', target: hand.potTotal / 3 },
      { id: 'half', label: '1/2 池', target: hand.potTotal / 2 },
      { id: 'two-thirds', label: '2/3 池', target: hand.potTotal * 2 / 3 },
      { id: 'pot', label: '满池', target: hand.potTotal }
    ]
    : hand.street === 'preflop' && hand.currentBet === smallBlind * 2
      ? [
        { id: 'two-half-bb', label: '2.5 BB', target: smallBlind * 5 },
        { id: 'three-bb', label: '3 BB', target: smallBlind * 6 },
        { id: 'four-bb', label: '4 BB', target: smallBlind * 8 }
      ]
      : [
        { id: 'minimum', label: '最小加注', target: legal.minRaiseTo },
        { id: 'two-half', label: '2.5 倍', target: hand.currentBet * 2.5 },
        { id: 'pot-raise', label: '底池加注', target: hand.currentBet + hand.potTotal + legal.toCall }
      ];
  const normalOptions = presets.flatMap((preset) => {
    const target = normalTarget(preset.target);
    if (target === undefined) return [];
    const label = hand.currentBet === 0 && preset.target < legal.minRaiseTo ? '最小下注' : preset.label;
    return [{ ...preset, label, target }];
  }).filter((option, index, options) => options.findIndex((candidate) => candidate.target === option.target) === index);
  return normalOptions.length >= 4
    ? normalOptions
    : [...normalOptions, { id: 'all-in', label: '全下', target: legal.maxRaiseTo }];
}

const cardRank = (rank: number) => rank === 14 ? 'A' : rank === 13 ? 'K' : rank === 12 ? 'Q' : rank === 11 ? 'J' : String(rank);
const cardSuit = (suit: string) => ({ S: '♠', H: '♥', D: '♦', C: '♣' }[suit] ?? '');
const format = (value: number) => new Intl.NumberFormat('zh-CN').format(value);
const randomContribution = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) => value.toString(16).padStart(2, '0')).join('');

function Icon({ name, size = 20 }: { name: 'plus' | 'minus' | 'lock' | 'settings' | 'arrow' | 'users' | 'copy' | 'link' | 'close' | 'history' | 'sound' | 'soundOff' | 'back' | 'more' | 'refresh' | 'chat' | 'pause' | 'play' | 'stop' | 'chip'; size?: number }) {
  const paths = {
    plus: <><path d="M12 5v14M5 12h14" /></>, minus: <path d="M5 12h14" />, lock: <><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9 7 7m10 10 2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" /></>,
    arrow: <path d="m9 18 6-6-6-6" />, users: <><circle cx="9" cy="8" r="3" /><path d="M3.5 20c.6-3.2 2.5-5 5.5-5s4.9 1.8 5.5 5M17 11a3 3 0 1 0-1-5.8M16.5 15.1c2.3.3 3.7 1.9 4 4.9" /></>,
    copy: <><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" /></>, link: <><path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" /><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1" /></>, close: <path d="m6 6 12 12M18 6 6 18" />,
    history: <><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5M12 7v5l3 2" /></>, sound: <><path d="M4 10v4h4l5 4V6l-5 4zM17 9a4 4 0 0 1 0 6M19.5 6.5a7 7 0 0 1 0 11" /></>, soundOff: <><path d="M4 10v4h4l5 4V6l-5 4zM16 10l5 5m0-5-5 5" /></>,
    back: <path d="m15 18-6-6 6-6" />, more: <path d="M5 12h.01M12 12h.01M19 12h.01" />,
    refresh: <><path d="M20 6v5h-5" /><path d="M4 18v-5h5" /><path d="M6.1 9a7 7 0 0 1 11.5-2.6L20 9M4 15l2.4 2.6A7.4 7.4 0 0 0 17.9 15" /></>,
    chat: <><path d="M20 11.5a7.5 7.5 0 0 1-8 7.5 8.6 8.6 0 0 1-3.7-.85L4 19l.95-3.3A7.4 7.4 0 0 1 4 12a7.5 7.5 0 0 1 8-7.5 7.5 7.5 0 0 1 8 7Z" /><path d="M8 12h.01M12 12h.01M16 12h.01" /></>,
    chip: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="4" /><path d="M12 4v3m0 10v3M4 12h3m10 0h3" /></>,
    pause: <><path d="M8 5v14M16 5v14" /></>, play: <path d="m9 5 11 7-11 7z" />, stop: <rect x="6" y="6" width="12" height="12" rx="2" />
  }[name];
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{paths}</svg>;
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog) return;
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'));
    const initialFocus = dialog.querySelector<HTMLElement>('[autofocus]') ?? focusable()[0] ?? dialog;
    const focusFrame = requestAnimationFrame(() => initialFocus.focus({ preventScroll: true }));
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { onCloseRef.current(); return; }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) { event.preventDefault(); dialog.focus({ preventScroll: true }); return; }
      const first = items[0]; const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus({ preventScroll: true }); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus({ preventScroll: true }); }
    };
    addEventListener('keydown', handler);
    return () => { cancelAnimationFrame(focusFrame); removeEventListener('keydown', handler); previousFocus?.focus({ preventScroll: true }); };
  }, []);
  return <div className="scrim" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="sheet" ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="sheet-title"><header className="sheetHeader"><h2 id="sheet-title">{title}</h2><button className="iconButton" onClick={onClose} aria-label="关闭"><Icon name="close" /></button></header>{children}</section></div>;
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
      <div className="auditDetailsBody"><p>普通回放不包含原始事件；下载验证包可在离线环境核验本手。</p><button className="secondary small auditDownload" onClick={() => onDownload(replay.handId)}>下载验证包</button></div>
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
  const openRoom = async (id: string, openTable = false) => { try { setTableOpen(openTable); await refreshRoom(id); } catch (reason) { notify('error', (reason as Error).message); } };
  if (player === undefined) return <div className="loading">正在连接 River Table…</div>;
  if (!player) return <GuestGate onCreated={(next) => { setPlayer(next); void refreshRooms(); }} />;
  return <main className={tableOpen ? 'appShell tableMode' : 'appShell'}>{!tableOpen && !selectedRoom && <header className="topbar"><button className="iconButton" aria-label="打开设置" onClick={() => setSheet('settings')}><Icon name="settings" /></button><div className="wordmark"><strong>RIVER TABLE</strong><span>受邀制私人牌局</span></div><button className="avatarButton" aria-label="查看个人资料" onClick={() => setSheet('settings')}>{player.nickname.slice(0, 1)}</button></header>}
    {selectedRoom ? <RoomScreen key={selectedRoom.id} initialScreen={tableOpen ? 'table' : 'room'} player={player} room={selectedRoom} onBack={() => { setTableOpen(false); setSelectedRoom(null); void refreshRooms(); }} onRefresh={() => refreshRoom(selectedRoom.id)} onTableChange={setTableOpen} notify={notify} /> : <Dashboard rooms={rooms} onCreate={() => setSheet('create')} onJoin={() => setSheet('join')} onOpen={openRoom} />}
    {notice && <div className={`toast ${notice.tone}`} role="status">{notice.text}</div>}
    {sheet === 'create' && <CreateRoomSheet onClose={() => setSheet(null)} onCreated={(room) => { setSheet(null); void refreshRooms(); void openRoom(room.id); notify('success', '私人房已创建'); }} notify={notify} />}
    {sheet === 'join' && <JoinRoomSheet initialCode={pendingInviteCode} onClose={() => setSheet(null)} onJoined={(room) => { setPendingInviteCode(undefined); history.replaceState(null, '', '/'); setSheet(null); void refreshRooms(); void openRoom(room.id, true); notify('success', '已加入私人房'); }} />}
    {sheet === 'history' && <HistorySheet onClose={() => setSheet(null)} />}
    {sheet === 'settings' && <Sheet title="设备与偏好" onClose={() => setSheet(null)}><div className="settings"><div className="settingsIdentity"><span className="avatarLarge">{player.nickname.slice(0, 1)}</span><div><strong>{player.nickname}</strong><p>设备游客身份 · 仅本机可用</p></div></div><div className="settingLine"><span><strong>音效、音乐与语音播报</strong><small>发牌、下注、轮到你、牌局语音和轻柔牌桌音乐</small></span><button className={audioEnabled ? 'switch on' : 'switch'} aria-label={`牌桌音效与语音播报已${audioEnabled ? '开启' : '关闭'}`} aria-pressed={audioEnabled} onClick={() => tableAudio.setEnabled(!audioEnabled)}><i /></button></div><button className="textAction" onClick={() => setSheet('history')}><Icon name="history" /> 查看历史结算 <Icon name="arrow" /></button></div></Sheet>}
  </main>;
}

function Dashboard({ rooms, onCreate, onJoin, onOpen }: { rooms: Room[]; onCreate: () => void; onJoin: () => void; onOpen: (id: string) => void }) {
  const resumeRoom = rooms.find((room) => room.status === 'active' && !(room.role === 'member' && (room.chips ?? 0) === 0)) ?? rooms.find((room) => !['dissolved', 'closing'].includes(room.status));
  return <div className="page"><section className={`hero ${resumeRoom ? 'heroReturn' : ''}`}>
    {resumeRoom ? <><p className="eyebrow">我的私人牌局</p><h1>继续 {resumeRoom.name}</h1><p>{roomStatus(resumeRoom).description}</p><button className="primary wide heroContinue" onClick={() => onOpen(resumeRoom.id)}>继续牌局 <Icon name="arrow" /></button><div className="heroSecondaryActions"><button className="secondary" onClick={onCreate}><Icon name="plus" /> 创建房间</button><button className="secondary" onClick={onJoin}><Icon name="lock" /> 加入牌局</button></div></> : <><p className="eyebrow">只和熟悉的人一起玩</p><h1>你的私人牌局<br />从一个邀请开始</h1><p>不会出现陌生人的牌桌。通过邀请码或链接邀请好友加入。</p><div className="buttonRow"><button className="primary" onClick={onCreate}><Icon name="plus" /> 创建房间</button><button className="secondary" onClick={onJoin}><Icon name="lock" /> 输入邀请码</button></div></>}
  </section><section className="sectionHeader"><div><h2>我的牌局</h2><p>仅受邀房间</p></div><span>{rooms.length} 个房间</span></section><div className="roomList">{rooms.length ? rooms.map((room) => {
    const status = roomStatus(room);
    return <button key={room.id} className="roomCard" onClick={() => onOpen(room.id)}><div className="roomMeta"><span className="privatePill"><Icon name="lock" size={12} /> {room.role === 'host' ? '我的房间' : '受邀房间'}</span><span className={`statusPill ${status.tone}`}>{status.label}</span></div><h3>{room.name}</h3><p>{room.smallBlind} / {room.bigBlind} · {room.maxSeats} 人桌 · {room.role === 'host' ? '你管理积分' : `我的积分 ${format(room.chips ?? 0)}`}</p><span className="roomGo">{status.action} <Icon name="arrow" size={16} /></span></button>;
  }) : <div className="emptyState"><Icon name="users" size={28} /><h3>还没有私人牌局</h3><p>创建房间，或输入好友分享的邀请码。</p><button className="secondary" onClick={onCreate}>创建第一个房间</button></div>}</div><div className="trustNote"><Icon name="lock" /><p>纯娱乐虚拟积分，不支持充值、提现或真实货币兑换。</p></div></div>;
}

function roomStatus(room: Room): { label: string; description: string; action: string; tone: 'active' | 'muted' | 'attention' } {
  if (room.status === 'active' && room.role === 'member' && (room.chips ?? 0) === 0) return { label: '等待房主补分', description: '该私人房正在进行中；补分后即可在下一手坐入。', action: '查看房间', tone: 'attention' };
  if (room.status === 'active') return { label: '牌局进行中', description: `${room.memberCount ?? 0} / ${room.maxSeats} 位成员已加入，随时继续查看牌桌。`, action: '继续牌局', tone: 'active' };
  if (room.status === 'paused' || room.status === 'pausing') return { label: room.status === 'paused' ? '牌局已暂停' : '本手结束后暂停', description: '牌局会保留在这里，等待房主恢复。', action: '查看房间', tone: 'attention' };
  if (room.status === 'closing') return { label: '本手结束后关闭', description: '当前手牌结算后，房间将仅保留最终积分和补码积分。', action: '查看房间', tone: 'attention' };
  return { label: '已关闭', description: '仅可查看成员最终积分和补码积分。', action: '查看记录', tone: 'muted' };
}

function CreateRoomSheet({ onClose, onCreated, notify }: { onClose: () => void; onCreated: (room: Room) => void; notify: (tone: 'success' | 'error', text: string) => void }) {
  const [name, setName] = useState('好友夜牌局'); const [seats, setSeats] = useState<6 | 9>(6); const [blind, setBlind] = useState(20); const [startingStackBb, setStartingStackBb] = useState(75); const [customChips, setCustomChips] = useState<number | null>(null); const [working, setWorking] = useState(false);
  const bigBlind = blind * 2; const chips = customChips ?? bigBlind * startingStackBb; const chipDepth = chips / bigBlind;
  const submit = async (event: FormEvent) => { event.preventDefault(); setWorking(true); try { onCreated((await api.createRoom({ name, maxSeats: seats, smallBlind: blind, initialChips: chips })).room); } catch (reason) { notify('error', (reason as Error).message); } finally { setWorking(false); } };
  return <Sheet title="创建私人房" onClose={onClose}><p className="sheetIntro">你会成为房主，可分配初始娱乐积分、在牌局中补分，并控制邀请权限。</p><form onSubmit={submit} className="form"><label>房间名称<input value={name} maxLength={20} onChange={(e) => setName(e.target.value)} /></label><fieldset><legend>人数</legend><div className="choiceGrid">{([6, 9] as const).map((value) => <button type="button" key={value} className={seats === value ? 'choice selected' : 'choice'} aria-pressed={seats === value} onClick={() => setSeats(value)}>{value} 人桌</button>)}</div></fieldset><fieldset><legend>小盲 / 大盲</legend><div className="choiceGrid">{[10, 20, 50, 100].map((value) => <button type="button" key={value} className={blind === value ? 'choice selected' : 'choice'} aria-pressed={blind === value} onClick={() => setBlind(value)}>{value} / {value * 2}</button>)}</div></fieldset><fieldset><legend>初始娱乐积分</legend><p className="fieldHint">按大盲选择深度；推荐 75–100 BB。</p><div className="choiceGrid stackDepthChoices">{[50, 75, 100, 150].map((value) => <button type="button" key={value} className={customChips === null && startingStackBb === value ? 'choice selected' : 'choice'} aria-pressed={customChips === null && startingStackBb === value} onClick={() => { setStartingStackBb(value); setCustomChips(null); }}>{value} BB</button>)}</div></fieldset><label>自定义娱乐积分<input type="number" min={bigBlind} step={bigBlind} value={customChips ?? ''} placeholder={String(chips)} onChange={(event) => { const value = event.target.value; setCustomChips(value === '' ? null : Math.max(bigBlind, Number(value))); }} /></label><p className="fieldHint" aria-live="polite">当前 {format(chips)} 娱乐积分 = {chipDepth % 1 === 0 ? chipDepth : chipDepth.toFixed(1)} BB。</p><button className="primary wide" disabled={working}>{working ? '正在创建…' : '生成邀请码'} <Icon name="arrow" /></button></form></Sheet>;
}

function JoinRoomSheet({ initialCode, onClose, onJoined }: { initialCode?: string; onClose: () => void; onJoined: (room: Room) => void }) {
  const [code, setCode] = useState(initialCode ?? ''); const [error, setError] = useState(''); const [working, setWorking] = useState(false);
  const pasteInvite = async () => { try { const pasted = await navigator.clipboard?.readText(); if (!pasted) throw new Error('empty'); setCode(pasted); setError(''); } catch { setError('无法读取剪贴板，请手动粘贴邀请码或邀请链接。'); } };
  const submit = async (event: FormEvent) => { event.preventDefault(); setError(''); const inviteCode = inviteCodeFromInput(code); if (!inviteCode) { setError('请输入有效的邀请码或邀请链接。'); return; } setWorking(true); try { onJoined((await api.join(inviteCode)).room); } catch (reason) { setError((reason as Error).message); } finally { setWorking(false); } };
  return <Sheet title="加入私人房" onClose={onClose}><p className="sheetIntro">粘贴好友分享的邀请码或完整邀请链接。加入后，你可以在“我的牌局”中再次进入。</p><form onSubmit={submit} className="form"><label htmlFor="inviteCode">邀请码或邀请链接</label><div className="inviteInputRow"><input id="inviteCode" value={code} placeholder="例如 7KQ3X9MP 或 https://…/join/…" maxLength={240} autoCapitalize="none" onChange={(event) => setCode(event.target.value)} /><button className="secondary pasteInviteButton" type="button" onClick={() => void pasteInvite()}>粘贴</button></div><p className="fieldHint">支持 8 位邀请码和 River Table 邀请链接。</p>{error && <p className="fieldError" role="alert">{error}</p>}<button className="primary wide" disabled={working}>{working ? '正在验证…' : '加入牌局'} <Icon name="arrow" /></button></form></Sheet>;
}

function RoomScreen({ initialScreen, player, room, onBack, onRefresh, onTableChange, notify }: {
  initialScreen: 'room' | 'table';
  player: Player;
  room: RoomView;
  onBack: () => void;
  onRefresh: () => Promise<void>;
  onTableChange: (open: boolean) => void;
  notify: (tone: 'success' | 'error', text: string) => void;
}) {
  const [screen, setScreen] = useState<'room' | 'table'>(initialScreen);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [working, setWorking] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const memberNames = useMemo(() => new Map(room.members.map((member) => [member.id, member.nickname])), [room.members]);
  const visibleMembers = room.members.filter((member) => room.isHost || member.id === player.id);
  const roomClosed = room.status === 'dissolved';
  const canManage = room.isHost && !['closing', 'dissolved'].includes(room.status);
  const topUpStep = room.bigBlind * 50;
  const defaultTopUpAmount = String(topUpStep);

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
  const creditValue = (memberId: string) => amounts[memberId] ?? defaultTopUpAmount;
  const validCreditAmount = (memberId: string) => {
    const value = creditValue(memberId).trim();
    const amount = Number(value);
    return value !== '' && Number.isSafeInteger(amount) && amount > 0;
  };
  const adjustCreditAmount = (memberId: string, delta: number) => setAmounts((state) => {
    const current = Number(state[memberId] ?? defaultTopUpAmount);
    return { ...state, [memberId]: String(Math.max(0, (Number.isFinite(current) ? current : 0) + delta)) };
  });
  const credit = async (member: Member) => {
    const amount = Number(creditValue(member.id));
    if (!validCreditAmount(member.id)) { notify('error', '请输入大于 0 的整数积分'); return; }
    setWorking(true);
    try {
      await api.credit(room.id, member.id, amount);
      await syncRoomData();
      notify('success', `已向 ${member.nickname} 补码 ${format(amount)} 积分`);
    } catch (reason) {
      notify('error', (reason as Error).message);
    } finally {
      setWorking(false);
    }
  };
  const closeRoom = async () => {
    if (!confirm('关闭后邀请码会立即失效，房间仅保留成员最终积分和补码积分。确定继续吗？')) return;
    setWorking(true);
    try {
      const result = await api.close(room.id);
      notify('success', result.room.status === 'closing' ? '将于本手结束后关闭' : '房间已关闭，可查看最终积分');
      if (result.room.status === 'closing') await onRefresh();
      else await syncRoomData();
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
      {canManage && <div className="roomTopActions"><button className="iconButton dissolveRoomButton" disabled={working || room.status === 'closing'} onClick={closeRoom} aria-label="关闭房间并保留最终积分记录" title="关闭房间"><Icon name="stop" /></button><button className="iconButton pauseRoomButton" disabled={working || !['active', 'paused'].includes(room.status)} onClick={togglePause} aria-label={room.status === 'paused' ? '恢复牌局' : room.status === 'pausing' ? '等待暂停' : '暂停牌局'} title={room.status === 'paused' ? '恢复牌局' : room.status === 'pausing' ? '等待暂停' : '暂停牌局'}><Icon name={room.status === 'paused' ? 'play' : 'pause'} /></button></div>}
    </header>
    {canManage && <section className="inviteCard">
      <button className="iconButton inviteRotateButton" disabled={working || !room.inviteOpen} onClick={rotateInvite} aria-label="轮换邀请码" title="轮换邀请码"><Icon name="refresh" /></button>
      <div className="inviteCodeContent"><p className="eyebrow">仅受邀玩家可进入</p><strong className="inviteCode">{room.inviteCode}</strong><div className="inviteActions"><button type="button" className="secondary small" aria-label="复制邀请码" onClick={() => copy(room.inviteCode, '邀请码')}><Icon name="copy" size={15} />复制</button><button type="button" className="secondary small" onClick={() => copy(`${location.origin}/join/${room.inviteCode}`, '邀请链接')}><Icon name="link" size={15} />复制链接</button></div><p>{room.inviteOpen ? '邀请码有效，可分享给熟悉的好友' : '邀请已关闭'}</p></div>
    </section>}
    {!roomClosed && <div className="roomButtons">
      <button className="primary" disabled={room.status === 'closing'} onClick={() => { tableAudio.enterTable(); setScreen('table'); }}>进入牌桌 <Icon name="arrow" /></button>
      {canManage && <button className={room.inviteOpen ? 'secondary' : 'secondary selectedOutline'} disabled={working} onClick={toggleInvite}><Icon name="lock" /> {room.inviteOpen ? '关闭邀请' : '开启邀请'}</button>}
    </div>}
    <section className="sectionHeader memberSectionHeader">
      <div><h2>{roomClosed ? '成员最终积分' : '成员积分'}</h2>{roomClosed ? <p>房间已关闭，仅保留最终积分与补码积分</p> : !room.isHost && <p>仅显示你的个人积分</p>}</div>
      <div className="memberHeaderActions">
        <span aria-live="polite">{room.members.length} 位成员</span>
        {canManage && <button type="button" className={`memberRefreshButton ${refreshing ? 'refreshing' : ''}`} disabled={refreshing || working} onClick={refreshMembers} aria-label="刷新成员和当前积分"><Icon name="refresh" size={15} /><span>{refreshing ? '刷新中' : '刷新'}</span></button>}
      </div>
    </section>
    <div className="memberList">
      {visibleMembers.map((member) => <article className="memberRow" key={member.id}>
        <span className={`memberRole ${member.role === 'host' ? 'host' : 'member'}`}>{member.role === 'host' ? '房主' : '成员'}</span>
        <div className="memberInfo"><div className="memberIdentity"><strong>{member.nickname}</strong>{canManage && member.id !== player.id && <button className="memberRemove" disabled={working} onClick={() => removeMember(member)}>移除</button>}</div></div>
        <span className="memberChips"><small>{roomClosed ? '最终积分' : '当前积分'}</small><strong>{format(member.chips)}</strong>{roomClosed && <small className="memberTopup">补码 {format(member.topupChips)}</small>}</span>
        {canManage && <div className="memberControls"><div className="creditControl"><div className="creditInputGroup"><button type="button" className="creditAdjust" disabled={working} onClick={() => adjustCreditAmount(member.id, -topUpStep)} aria-label={`向 ${member.nickname} 补码减少 ${format(topUpStep)}`}><Icon name="minus" size={18} /></button><input aria-label={`向 ${member.nickname} 补码`} type="number" inputMode="numeric" min="0" step={topUpStep} placeholder="输入补码" value={creditValue(member.id)} onChange={(event) => setAmounts((state) => ({ ...state, [member.id]: event.target.value }))} /><button type="button" className="creditAdjust" disabled={working} onClick={() => adjustCreditAmount(member.id, topUpStep)} aria-label={`向 ${member.nickname} 补码增加 ${format(topUpStep)}`}><Icon name="plus" size={18} /></button></div><button className="secondary compact creditSubmit" disabled={working || !validCreditAmount(member.id)} onClick={() => credit(member)}>补码</button></div></div>}
      </article>)}
    </div>
    <section className="sectionHeader slim"><div><h2>补码记录</h2><p>仅显示补码记录</p></div></section>
    <div className="ledgerList">
      {ledger.length ? ledger.slice(0, 8).map((entry) => {
        const targetName = memberNames.get(entry.playerId) ?? '玩家';
        const label = `已向 ${targetName} 补码`;
        return <div className="ledgerItem" key={entry.id}><span className="ledgerGlyph"><Icon name="history" size={16} /></span><div><strong>{label}</strong><small>{new Date(entry.createdAt).toLocaleString('zh-CN')}</small></div><b>{entry.amount >= 0 ? '+' : ''}{format(entry.amount)}</b></div>;
      }) : <p className="emptyInline">暂无积分记录</p>}
    </div>
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

function SeatActionClock({ timing, isMine, placement }: { timing: TableSnapshot['timing']; isMine: boolean; placement: 'seat' | 'panel' }) {
  const deadline = useMemo(() => localDeadline(timing?.actionDeadlineAt, timing?.serverNow), [timing?.actionDeadlineAt, timing?.serverNow]);
  const seconds = useCountdown(deadline);
  const lastTick = useRef<number | undefined>(undefined);
  useEffect(() => { lastTick.current = undefined; }, [deadline]);
  useEffect(() => {
    if (seconds === undefined || seconds < 1 || seconds > 5 || lastTick.current === seconds) return;
    lastTick.current = seconds;
    tableAudio.play('tick');
  }, [seconds]);
  return <span className={`seatCountdown ${placement === 'panel' ? 'panelTimer' : 'seatTimer'} ${seconds !== undefined && seconds <= 5 ? 'urgent' : ''}`} role="timer" aria-live="polite" data-phase="action" aria-label={`${isMine ? '你的' : '当前玩家'}行动剩余 ${seconds ?? '未知'} 秒`}><strong>{seconds ?? '—'}</strong><small>秒</small></span>;
}

function ReconnectClock({ playerId, timing }: { playerId: string; timing: TableSnapshot['timing'] }) {
  const serverDeadline = timing?.reconnectDeadlines?.[playerId];
  const deadline = useMemo(() => localDeadline(serverDeadline, timing?.serverNow), [serverDeadline, timing?.serverNow]);
  const seconds = useCountdown(deadline);
  if (seconds === undefined) return <i>OFFLINE</i>;
  return <i role="timer" aria-label={`重连宽限期剩余 ${seconds} 秒`}>RECONNECT {seconds}s</i>;
}

function NextHandClock({ timing, onManageChips }: { timing: TableSnapshot['timing']; onManageChips: () => void }) {
  const deadline = useMemo(() => localDeadline(timing?.nextHandStartsAt, timing?.serverNow), [timing?.nextHandStartsAt, timing?.serverNow]);
  const seconds = useCountdown(deadline);
  if (timing?.waitingForPlayers) return <div className="nextHandClock waitingForPlayers" role="status" aria-live="polite" data-phase="waiting-for-players"><div><span>本手已结算</span><strong>等待补充积分</strong><small>需至少 2 位有积分玩家</small></div><button type="button" className="tableStateAction" onClick={onManageChips}>去补分</button></div>;
  return <div className="nextHandClock" role="timer" aria-live="polite" aria-label={`下一手将在 ${seconds ?? '未知'} 秒后开始`} data-phase="next-hand"><strong>{seconds ?? '…'}</strong><small aria-hidden="true">s</small></div>;
}

function BetControls({ hand, legal, me, mine, onAction, timing, smallBlind }: {
  hand?: HandSnapshot;
  legal?: LegalActions;
  me?: TableSnapshot['players'][number];
  mine: boolean;
  onAction: (type: TableActionType, amount?: number) => void;
  timing: TableSnapshot['timing'];
  smallBlind: number;
}) {
  const options = hand && legal ? quickBetOptions(hand, legal, smallBlind) : [];
  const defaultTarget = options[0]?.target ?? legal?.maxRaiseTo ?? 0;
  const [raiseTarget, setRaiseTarget] = useState(defaultTarget);
  const [customMode, setCustomMode] = useState(false);
  const sliderMinimum = legal ? Math.min(legal.maxRaiseTo, roundUpToChipUnit(legal.minRaiseTo, smallBlind)) : 0;
  const sliderMaximum = legal?.maxRaiseTo ?? sliderMinimum;
  const targetIsValid = !!hand && !!legal && isLegalRaiseTarget(hand, legal, raiseTarget, smallBlind);
  const sliderProgress = sliderMaximum === sliderMinimum ? 100 : Math.max(0, Math.min(100, ((raiseTarget - sliderMinimum) / (sliderMaximum - sliderMinimum)) * 100));
  const middleAction: TableActionType = legal?.canCheck ? 'check' : 'call';
  const middleLabel = legal?.canCheck ? '过牌' : legal?.canCall ? `${legal.callAmount === me?.stack ? '跟注全下' : '跟注'} ${format(legal.callAmount)}` : '等待行动';
  const openingBet = (hand?.currentBet ?? 0) === 0;

  return <div className="actionControlCluster">
    <SeatActionClock timing={timing} isMine placement="panel" />
    <section className="actionDock" aria-label="当前行动操作">
      {hand && legal?.canRaise && !customMode && <div className="quickBetPanel" role="group" aria-label={openingBet ? '按底池比例快捷下注' : '按当前下注倍数快捷加注'}>{options.map((option) => <button type="button" className="quickBet" data-quick-bet={option.id} key={option.id} aria-label={`${option.label}，${openingBet ? '下注到' : '加注到'} ${format(option.target)}，点击立即行动`} title={`${openingBet ? '下注到' : '加注到'} ${format(option.target)}`} onClick={() => onAction('raise', option.target)}><strong>{option.label}</strong><span>{format(option.target)}</span></button>)}</div>}
    {hand && legal?.canRaise && customMode && <div className="customBetPanel">
      <div className="customBetHeader"><button type="button" onClick={() => setCustomMode(false)} aria-label="返回快捷码量">快捷码量</button><output aria-live="polite">{openingBet ? '下注到' : '加注到'} <b>{format(raiseTarget)}</b></output></div>
      <input className="betRange" type="range" min={sliderMinimum} max={sliderMaximum} step={smallBlind} value={raiseTarget} aria-label="自定义下注码量" style={{ background: `linear-gradient(90deg,#e6b84e 0%,#e6b84e ${sliderProgress}%,#263f54 ${sliderProgress}%,#263f54 100%)` }} onChange={(event) => setRaiseTarget(Number(event.target.value))} />
      <div className="rangeLabels"><span>{openingBet ? '0' : `跟平 ${format(sliderMinimum)}`}</span>{!targetIsValid && <strong>最小需到 {format(legal.minRaiseTo)}</strong>}<span>全下 {format(me?.stack ?? 0)}</span></div>
    </div>}
    <div className="gameActions"><button disabled={!mine || !legal?.canFold} className="foldButton" onClick={() => onAction('fold')}>弃牌</button><button disabled={!mine || (!legal?.canCheck && !legal?.canCall)} className="callButton" onClick={() => onAction(middleAction)}>{middleLabel}</button><button disabled={!mine || !legal?.canRaise || (customMode && !targetIsValid)} className="raiseButton" onClick={() => customMode ? onAction('raise', raiseTarget) : setCustomMode(true)}>{!legal?.canRaise ? '不可加注' : customMode ? `确认${openingBet ? '下注' : '加注'} ${format(raiseTarget)}` : openingBet ? '下注' : '加注'}</button></div>
    </section>
  </div>;
}

const QUICK_PHRASES = ['我要补码', '6 6 6 打得不错', '搞快点 搞快点', '我很大', '含住', '不玩啦', '跟到底！', '这手稳了'];

function TableScreen({ room, player, onBack, notify }: { room: RoomView; player: Player; onBack: () => void; notify: (tone: 'success' | 'error', text: string) => void }) {
  const [snapshot, setSnapshot] = useState<TableSnapshot | null>(null); const [starting, setStarting] = useState(false); const [auditStatus, setAuditStatus] = useState<string>(); const [handHistory, setHandHistory] = useState<HandHistoryItem[] | null>(null); const [visibleHandCount, setVisibleHandCount] = useState(30); const [selectedReplay, setSelectedReplay] = useState<HandReplay | null>(null); const [replayLoadingId, setReplayLoadingId] = useState<string>(); const [quickPhrasesOpen, setQuickPhrasesOpen] = useState(false); const socketRef = useRef<Socket | null>(null);
  const tableSessionRef = useRef<TableSession | null>(null);
  const previousSnapshot = useRef<TableSnapshot | null>(null);
  const contributedHands = useRef(new Set<string>());
  const audioEnabled = useSyncExternalStore(subscribeTableAudio, tableAudio.getEnabled, tableAudio.getEnabled);
  useEffect(() => { tableAudio.enterTable(); return () => tableAudio.leaveTable(); }, []);
  useEffect(() => { const socket = io({ path: '/socket.io', transports: ['websocket'], autoConnect: false }); socketRef.current = socket; let tableSession: TableSession | undefined; const acceptSnapshot = (next: TableSnapshot) => {
    const acceptance = tableSession?.acceptSnapshot(next);
    if (acceptance === 'stale') return;
    if (acceptance === 'conflict') { notify('error', '牌桌状态出现冲突，正在重新同步'); return; }
    const previous = previousSnapshot.current; const previousHand = previous?.hand; const nextHand = next.hand;
    if (previous && nextHand) {
      for (const cue of tableSoundEvents(previous, next, player.id)) tableAudio.play(cue);
      if (previousHand?.status !== 'settled' && nextHand.status === 'settled') notify('success', next.timing?.waitingForPlayers ? '本手已结算，等待至少两位有积分玩家' : '本手已结算，下一手即将自动开始');
    }
    const preparing = next.preparing;
    if (preparing) localStorage.setItem(`river:commitment:${room.id}:${preparing.id}`, preparing.commitment);
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
  }; const refreshSnapshot = () => api.table(room.id, previousSnapshot.current?.sequence).then((result) => acceptSnapshot(result.snapshot as TableSnapshot)); tableSession = bindTableSession({
    socket: socket as unknown as TableSessionSocket,
    roomId: room.id,
    refreshSnapshot,
    onJoinError: (message) => notify('error', message)
  }); const activeSession = tableSession; const playRemoteQuickPhrase = ({ phrase }: { phrase?: unknown }) => {
    if (typeof phrase === 'string' && QUICK_PHRASES.includes(phrase)) void tableAudio.speak(phrase);
  }; tableSessionRef.current = activeSession; socket.on('table:snapshot', acceptSnapshot); socket.on('table:quick-phrase', playRemoteQuickPhrase); socket.on('table:revoked', () => { notify('error', '你已不再是该房间成员'); onBack(); }); void refreshSnapshot().catch(() => undefined); socket.connect(); return () => { activeSession.dispose(); socket.off('table:quick-phrase', playRemoteQuickPhrase); if (tableSessionRef.current === activeSession) tableSessionRef.current = null; socket.disconnect(); }; }, [room.id, player.id, notify]);
  const me = snapshot?.players.find((item) => item.id === player.id); const hand = snapshot?.hand; const legal = hand?.legalActions; const mine = hand?.currentPlayerId === player.id && !!legal;
  const act = (type: TableActionType, amount?: number) => {
    if (!hand) return;
    if (!tableSessionRef.current?.isSynchronized()) { notify('error', '正在同步权威牌桌状态，请稍后重试'); return; }
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
  const waitingCount = snapshot?.players.filter((item) => item.seat === 0 && item.participation === 'waiting').length ?? 0;
  const seats = useMemo(() => seatLayout(room.maxSeats, snapshot?.players ?? [], player.id), [room.maxSeats, snapshot?.players, player.id]);
  const readyPlayerCount = snapshot?.players.filter((item) => item.stack > 0 && item.participation !== 'sitting-out').length ?? 0;
  const canStart = room.isHost && !hand && !snapshot?.preparing && readyPlayerCount >= 2;
  const startHand = () => { if (!socketRef.current) return; setStarting(true); socketRef.current.emit('table:start', (response: { ok: boolean; error?: string }) => { setStarting(false); if (!response.ok) notify('error', response.error ?? '无法开始牌局'); }); };
  const positionLabel = (seat: number) => {
    if (!hand) return undefined;
    return seat === hand.dealerSeat ? 'D' : undefined;
  };
  const showPotBreakdown = hand?.pots.slice(1).some((pot) => pot.eligiblePlayerIds.length > 1);
  const showdown = hand?.status === 'settled' && hand.settlement?.settledBy === 'showdown';
  const winners = settlementWinners(snapshot?.players ?? [], hand?.settlement?.payouts);
  const winnerIds = new Set(winners.map((winner) => winner.id));
  const needsChipsToSitIn = me?.participation === 'sitting-out' && (me.stack ?? 0) === 0;
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
      const publicCommitment = localStorage.getItem(`river:commitment:${room.id}:${hand.id}`);
      if (!publicCommitment) throw new Error('本设备未保存本手公开承诺，无法独立验证公平性');
      const local = await verifyAuditMaterial(audit, publicCommitment);
      if (!local.verified) throw new Error(local.reason ?? '本地审计验证失败');
      const verification = await api.verifyAudit(room.id, hand.id);
      if (!verification.verified) throw new Error('发牌、底池或派奖验证失败');
      setAuditStatus(`本地验证与服务端交叉校验通过 · ${new Date(verification.expiresAt).toLocaleDateString('zh-CN')} 前可查`);
    } catch (reason) { notify('error', (reason as Error).message); }
  };
  const openHandHistory = async () => {
    try { setVisibleHandCount(30); setHandHistory((await api.hands(room.id)).hands); }
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
      const publicCommitment = localStorage.getItem(`river:commitment:${room.id}:${handId}`);
      if (!publicCommitment) throw new Error('本设备未保存本手公开承诺，无法导出验证包');
      const verificationPackage = createVerificationPackage(audit, publicCommitment);
      const url = URL.createObjectURL(new Blob([JSON.stringify(verificationPackage, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `river-hand-${audit.handNumber}-verification.json`; link.click(); URL.revokeObjectURL(url);
    } catch (reason) { notify('error', (reason as Error).message); }
  };
  const speakQuickPhrase = async (phrase: string) => {
    setQuickPhrasesOpen(false);
    socketRef.current?.emit('table:quick-phrase', { phrase }, (response: { ok: boolean; error?: string }) => {
      if (!response.ok) notify('error', response.error ?? '常用语发送失败');
    });
    const result = await tableAudio.speak(phrase);
    if (result === 'muted') return;
    if (result === 'unsupported') { notify('error', '常用语音频无法播放，请检查设备音量'); return; }
    notify('success', `${result === 'recording' ? '已播放' : '已播报'}「${phrase}」`);
  };
  useEffect(() => {
    if (!quickPhrasesOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => event.key === 'Escape' && setQuickPhrasesOpen(false);
    addEventListener('keydown', closeOnEscape);
    return () => removeEventListener('keydown', closeOnEscape);
  }, [quickPhrasesOpen]);
  return <div className="tableScreen">
    <header className="tableHeader"><button className="iconButton" aria-label="返回房间" onClick={onBack}><Icon name="back" /></button><div><strong>{room.name}</strong><span>{room.smallBlind} / {room.bigBlind} · {hand ? `第 ${hand.number} 手` : '等待玩家入桌'}</span></div><button className="seatToggle" disabled={needsChipsToSitIn} title={needsChipsToSitIn ? '补充积分后即可坐入' : undefined} onClick={toggleParticipation}>{needsChipsToSitIn ? '补分后坐入' : me?.participation === 'sitting-out' ? '坐入' : '暂离'}</button><button className={`iconButton audioToggle ${audioEnabled ? '' : 'muted'}`} aria-label={`牌桌音效与语音播报已${audioEnabled ? '开启' : '关闭'}`} aria-pressed={audioEnabled} onClick={() => { const next = !audioEnabled; tableAudio.setEnabled(next); if (next) tableAudio.play('turn'); }}><Icon name={audioEnabled ? 'sound' : 'soundOff'} /></button></header>
    <div className="tableArea" data-table-size={room.maxSeats}>
      <div className="felt"><div className="feltInner" /></div>
      {me?.seat === 0 && me.participation === 'waiting' && <div className="waitingNotice" role="status"><strong>正在候补座位</strong><span>本手不参与发牌；结算后按进入顺序坐入{waitingCount > 1 ? ` · 当前 ${waitingCount} 人等待` : ''}</span></div>}
      {hand && <div className="pot"><span>总底池</span><b>{format(hand.potTotal)}</b>{showPotBreakdown && <small>{hand.pots.map((pot, index) => `${index === 0 ? '主池' : `边池${index}`} ${format(pot.amount)}`).join(' · ')}</small>}</div>}
      {hand?.status === 'settled' && <NextHandClock timing={snapshot?.timing} onManageChips={onBack} />}
      {hand?.status === 'settled' && winners.length > 0 && <div className="settlementBanner" role="status" aria-live="polite" aria-atomic="true"><strong>{winners.map((winner) => `${winner.nickname} 赢得 ${format(winner.amount)} 积分`).join(' · ')}</strong></div>}
      {hand?.status === 'settled' && me?.hole?.length === 2 && <button className="auditButton" onClick={verifyAudit}>{auditStatus ?? '验证本手发牌'}</button>}
      <div className="board" aria-label="公共牌">{Array.from({ length: 5 }, (_, index) => { const card = hand?.board[index]; return <div className={card ? `playingCard ${card.suit === 'H' || card.suit === 'D' ? 'red' : ''}` : 'playingCard blank'} key={index}>{card && <><span>{cardRank(card.rank)}</span><b>{cardSuit(card.suit)}</b></>}</div>; })}</div>
      <div className="seatRing">{seats.map(({ player: seat, physicalSeat, visualOffset }) => {
        const isTurn = hand?.status === 'active' && hand.currentPlayerId === seat?.id;
        const badge = positionLabel(physicalSeat);
        const circleStatus = !seat ? 'EMPTY' : winnerIds.has(seat.id) ? 'WIN' : seat.folded ? 'FOLD' : isTurn ? 'ACTION' : hand?.status !== 'active' && seat.stack === 0 ? 'RELOAD' : seat.allIn ? 'ALL IN' : seat.participation === 'waiting' ? 'WAIT' : seat.participation === 'sitting-out' ? 'AWAY' : 'READY';
        const borderState = seatBorderState({
          handActive: hand?.status === 'active',
          currentPlayer: isTurn,
          folded: !!seat?.folded,
          allIn: !!seat?.allIn,
          participation: seat?.participation ?? 'sitting-out',
          connected: !!seat?.connected
        });
        return <div className={`seat seatBorder${borderState} relativeSeat${visualOffset} ${seat?.id === player.id ? 'local' : ''} ${seat?.folded ? 'folded' : ''} ${isTurn ? 'activeTurn' : ''}`} data-physical-seat={physicalSeat} data-visual-offset={visualOffset} data-participation={seat?.participation} data-border-state={borderState} key={physicalSeat}>{seat ? <>{isTurn && seat.id !== player.id && <SeatActionClock timing={snapshot?.timing} isMine={false} placement="seat" />}<span className="seatName"><b>{seat.nickname}</b></span><span className="seatAvatarWrap"><span className={`seatAvatar seatState${circleStatus.replaceAll(' ', '')}`}>{circleStatus}</span>{badge && <span className="dealerButton" aria-label="庄位">{badge}</span>}</span>{seat.bet > 0 && <span className="seatBet" aria-label={`${seat.nickname} 本轮下注 ${format(seat.bet)}`}><Icon name="chip" size={15} />{format(seat.bet)}</span>}<span className="seatStack">{format(seat.stack)}{!seat.connected && <ReconnectClock playerId={seat.id} timing={snapshot?.timing} />}</span>{showdown && !seat.folded && seat.hole?.length === 2 && <span className="shownHoleCards" aria-label={`${seat.nickname} 亮出的手牌`}>{seat.hole.map((card, index) => <span key={index} className={`playingCard shown ${card.suit === 'H' || card.suit === 'D' ? 'red' : ''}`}><span>{cardRank(card.rank)}</span><b>{cardSuit(card.suit)}</b></span>)}</span>}</> : <span className="seatAvatarWrap"><span className="seatAvatar seatStateEMPTY">EMPTY</span></span>}</div>;
      })}</div>
      {me?.hole && !showdown && <div className="holeCards" aria-label="你的手牌">{me.hole.map((card, index) => <div key={index} className={`playingCard personal ${card.suit === 'H' || card.suit === 'D' ? 'red' : ''}`}><span>{cardRank(card.rank)}</span><b>{cardSuit(card.suit)}</b></div>)}</div>}
      {!hand && <div className="waiting"><Icon name="users" size={26} /><strong>{snapshot?.preparing ? '正在收集本手随机贡献' : canStart ? '牌桌已就绪' : '等待至少一位受邀好友入桌'}</strong><p>{snapshot?.preparing ? `服务端已提交洗牌承诺，等待 ${snapshot.preparing.participantIds.length - snapshot.preparing.readyPlayerIds.length} 位玩家完成贡献。` : canStart ? `已有 ${readyPlayerCount} 位有积分玩家入桌，请由房主开始第一手。` : '至少两位有积分的受邀玩家入桌后，房主即可开始牌局。'}</p>{room.isHost && <button className="primary tableStartButton" disabled={!canStart || starting} onClick={startHand}>{starting ? '正在开始…' : '开始第一手'} <Icon name="arrow" /></button>}</div>}
      <button className="tableUtility tableHistoryControl" aria-label="手牌记录" onClick={() => void openHandHistory()}><Icon name="history" size={18} /><span>手牌记录</span></button>
      <div className="quickPhraseControl">{quickPhrasesOpen && <div id="quick-phrase-menu" className="quickPhraseMenu" role="group" aria-label="选择要播报的常用语">{QUICK_PHRASES.map((phrase) => <button key={phrase} type="button" onClick={() => speakQuickPhrase(phrase)}>{phrase}</button>)}</div>}<button type="button" className="quickPhraseLauncher" aria-label="常用语" aria-expanded={quickPhrasesOpen} aria-controls="quick-phrase-menu" onClick={() => setQuickPhrasesOpen((open) => !open)}><Icon name="chat" size={18} /><span>常用语</span></button></div>
    </div>
    {mine && <BetControls key={`${hand?.number ?? 0}:${hand?.street ?? 'waiting'}:${hand?.currentPlayerId ?? 'none'}:${hand?.currentBet ?? 0}:${me?.bet ?? 0}`} hand={hand} legal={legal} me={me} mine={mine} onAction={act} timing={snapshot?.timing} smallBlind={room.smallBlind} />}
    {handHistory && <Sheet title={selectedReplay ? '手牌回放' : '最近手牌'} onClose={() => { setHandHistory(null); setVisibleHandCount(30); setSelectedReplay(null); setReplayLoadingId(undefined); }}>{selectedReplay ? <HandReplayDetail replay={selectedReplay} onBack={() => setSelectedReplay(null)} onDownload={(handId) => void downloadAudit(handId)} /> : <div className="historyList handHistoryList">{handHistory.length ? <><p className="historyListSummary">最近 10 天 · 显示 {Math.min(visibleHandCount, handHistory.length)} / {handHistory.length} 手</p>{handHistory.slice(0, visibleHandCount).map((item) => {
      const myDelta = item.pointDeltas[player.id] ?? 0;
      const potTotal = item.pots.reduce((sum, pot) => sum + pot.amount, 0);
      const loading = replayLoadingId === item.handId;
      return <button className="handHistoryRow" key={item.handId} disabled={!!replayLoadingId} onClick={() => void openReplay(item.handId)} aria-label={`查看第 ${item.handNumber} 手牌回放`}>
        <span className="ledgerGlyph"><Icon name="history" /></span>
        <span className="handHistoryMain"><span><strong>第 {item.handNumber} 手</strong><i className={item.settledBy}>{item.settledBy === 'showdown' ? '摊牌' : '弃牌结束'}</i></span><small>{new Date(item.settledAt).toLocaleString('zh-CN')} · {item.participants.length} 位玩家</small><ReplayCards cards={item.board} compact emptyText="未发公共牌" /></span>
        <span className="handHistoryOutcome"><strong className={myDelta > 0 ? 'positive' : myDelta < 0 ? 'negative' : 'even'}>{myDelta > 0 ? '+' : ''}{format(myDelta)}</strong><small>{loading ? '正在加载…' : '我的盈亏'}</small><b>底池 {format(potTotal)}</b></span>
      </button>;
    })}{visibleHandCount < handHistory.length && <button type="button" className="secondary wide handHistoryLoadMore" onClick={() => setVisibleHandCount((count) => Math.min(count + 30, handHistory.length))}>显示更多 30 手</button>}</> : <div className="emptyState compactEmpty"><Icon name="history" size={28} /><h3>暂无手牌记录</h3><p>结算后的手牌会在这里保留 10 天。</p></div>}</div>}</Sheet>}
  </div>;
}

function HistorySheet({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<{ roomId: string; finalChips: number; createdAt: string; room?: Room }[]>([]); useEffect(() => { api.history().then((result) => setItems(result.settlements)).catch(() => undefined); }, []);
  return <Sheet title="历史结算" onClose={onClose}><div className="historyList">{items.length ? items.map((item) => <article key={`${item.roomId}-${item.createdAt}`} className="historyRow"><span className="ledgerGlyph"><Icon name="history" /></span><div><strong>{item.room?.name ?? '已归档牌局'}</strong><small>{new Date(item.createdAt).toLocaleString('zh-CN')}</small></div><b>{format(item.finalChips)}</b></article>) : <div className="emptyState compactEmpty"><Icon name="history" size={28} /><h3>暂无历史结算</h3><p>房主关闭房间后，会在这里保留你自己的最终积分。</p></div>}</div></Sheet>;
}
