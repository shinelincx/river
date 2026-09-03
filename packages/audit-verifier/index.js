export const AUDIT_PACKAGE_VERSION = 'river-audit-package-v1';
const ALGORITHM_VERSION = 'river-shuffle-v1';
const suits = ['S', 'H', 'D', 'C'];

const cardText = (card) => `${card.rank}${card.suit}`;
const sortedRecord = (record) => Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

async function sha256(text) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return new Uint8Array(digest);
}

async function sha256Hex(text) {
  return [...await sha256(text)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function deterministicDeck(serverSeed, playerContributions, handId) {
  const deck = suits.flatMap((suit) => Array.from({ length: 13 }, (_, index) => ({ rank: index + 2, suit })));
  const entropy = Object.entries(playerContributions).sort(([left], [right]) => left.localeCompare(right)).map(([id, value]) => `${id}:${value}`).join('|');
  for (let index = deck.length - 1; index > 0; index--) {
    const bytes = await sha256(`${ALGORITHM_VERSION}:${serverSeed}:${handId}:${entropy}:${index}`);
    const random = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0) % (index + 1);
    [deck[index], deck[random]] = [deck[random], deck[index]];
  }
  return deck;
}

function combinations(items, size) {
  if (size === 0) return [[]];
  if (items.length < size) return [];
  const [head, ...tail] = items;
  return [...combinations(tail, size - 1).map((part) => [head, ...part]), ...combinations(tail, size)];
}

function compareRanks(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) > (right[index] ?? 0) ? 1 : -1;
  }
  return 0;
}

function evaluateFive(cards) {
  const ranks = cards.map((card) => card.rank).sort((left, right) => right - left);
  const counts = [...new Map(ranks.map((rank) => [rank, ranks.filter((value) => value === rank).length])).entries()]
    .sort((left, right) => right[1] - left[1] || right[0] - left[0]);
  const flush = cards.every((card) => card.suit === cards[0].suit);
  const unique = [...new Set(ranks)];
  const wheel = unique.length === 5 && unique.join(',') === '14,5,4,3,2';
  const straightHigh = unique.length === 5 && (unique[0] - unique[4] === 4 || wheel) ? (wheel ? 5 : unique[0]) : 0;
  if (flush && straightHigh) return [8, straightHigh];
  if (counts[0][1] === 4) return [7, counts[0][0], counts[1][0]];
  if (counts[0][1] === 3 && counts[1][1] === 2) return [6, counts[0][0], counts[1][0]];
  if (flush) return [5, ...ranks];
  if (straightHigh) return [4, straightHigh];
  if (counts[0][1] === 3) return [3, counts[0][0], ...counts.slice(1).map(([rank]) => rank)];
  if (counts[0][1] === 2 && counts[1][1] === 2) return [2, counts[0][0], counts[1][0], counts[2][0]];
  if (counts[0][1] === 2) return [1, counts[0][0], ...counts.slice(1).map(([rank]) => rank)];
  return [0, ...ranks];
}

function evaluateSeven(cards) {
  if (cards.length < 5) throw new Error('至少需要五张牌');
  return combinations(cards, 5).map(evaluateFive).reduce((best, next) => compareRanks(next, best) > 0 ? next : best);
}

function potBreakdown(contributions, folded) {
  const levels = [...new Set(Object.values(contributions).filter((amount) => amount > 0))].sort((left, right) => left - right);
  let previous = 0;
  return levels.map((level) => {
    const involved = Object.entries(contributions).filter(([, amount]) => amount >= level).map(([id]) => id);
    const amount = (level - previous) * involved.length;
    previous = level;
    return { amount, eligiblePlayerIds: involved.filter((id) => !folded.has(id)) };
  }).filter((pot) => pot.amount > 0);
}

function buttonDistance(seat, dealerSeat, maxSeats) {
  return (seat - dealerSeat + maxSeats) % maxSeats || maxSeats;
}

const invalid = (reason, checks = {}) => ({ verified: false, reason, checks: { package: true, commitment: false, deck: false, deal: false, contributions: false, settlement: false, ...checks } });

export async function verifyAuditMaterial(audit, publicCommitment) {
  if (!audit || typeof audit !== 'object' || audit.algorithmVersion !== ALGORITHM_VERSION) return invalid('不支持的审计算法版本', { package: false });
  const commitment = await sha256Hex(`${audit.algorithmVersion}:${audit.serverSeed}`);
  const commitmentMatches = commitment === audit.commitment && (publicCommitment === undefined || publicCommitment === audit.commitment);
  if (!commitmentMatches) return invalid('洗牌承诺不匹配', { commitment: false });
  const shuffleEvents = audit.events.filter((event) => event.type === 'shuffle_committed');
  const startedEvents = audit.events.filter((event) => event.type === 'hand_started');
  const settlementEvents = audit.events.filter((event) => event.type === 'hand_settled');
  if (shuffleEvents.length !== 1 || startedEvents.length !== 1 || settlementEvents.length !== 1) return invalid('手牌事件不完整', { commitment: true });
  const identityEvents = [shuffleEvents[0], startedEvents[0], settlementEvents[0]];
  if (identityEvents.some((event) => event.payload.handId !== audit.handId || event.payload.commitment !== audit.commitment)
    || shuffleEvents[0].payload.number !== audit.handNumber || startedEvents[0].payload.number !== audit.handNumber
    || shuffleEvents[0].payload.algorithmVersion !== audit.algorithmVersion || startedEvents[0].payload.algorithmVersion !== audit.algorithmVersion
    || startedEvents[0].payload.dealerSeat !== audit.dealerSeat) return invalid('手牌身份不一致', { commitment: true });
  const committedParticipants = shuffleEvents[0].payload.participantIds;
  if (!Array.isArray(committedParticipants) || !equal([...committedParticipants].sort(), [...audit.participantIds].sort())) return invalid('参与者承诺不一致', { commitment: true });
  const reconstructed = await deterministicDeck(audit.serverSeed, audit.playerContributions, audit.handId);
  if (!equal(reconstructed.map(cardText), audit.deck.map(cardText))) return invalid('牌堆重建失败', { commitment: true });
  const deck = structuredClone(reconstructed);
  for (const playerId of audit.dealOrder) {
    const expected = [deck.pop(), deck.pop()];
    if (!equal(expected.map(cardText), audit.holeCards[playerId]?.map(cardText))) return invalid('底牌发放不一致', { commitment: true, deck: true });
  }
  const expectedBoard = Array.from({ length: audit.board.length }, () => deck.pop());
  if (!equal(expectedBoard.map(cardText), audit.board.map(cardText))) return invalid('公共牌发放不一致', { commitment: true, deck: true });
  const contributions = Object.fromEntries(audit.participantIds.map((id) => [id, 0]));
  const actionIds = new Set();
  const folded = new Set();
  for (const event of audit.events) {
    if (event.type === 'blinds_posted') {
      contributions[event.payload.smallBlindPlayerId] = Number(event.payload.smallBlindAmount);
      contributions[event.payload.bigBlindPlayerId] = Number(event.payload.bigBlindAmount);
    }
    if (event.type === 'action') {
      const key = `${event.payload.playerId}:${event.payload.actionId}`;
      const committed = Number(event.payload.committedAmount);
      if (!event.payload.actionId || actionIds.has(key) || !Number.isSafeInteger(committed) || committed < 0 || !(event.payload.playerId in contributions)) return invalid('行动记录不一致', { commitment: true, deck: true, deal: true });
      actionIds.add(key);
      contributions[event.payload.playerId] += committed;
      if (contributions[event.payload.playerId] !== event.payload.contributionAfter) return invalid('行动贡献不一致', { commitment: true, deck: true, deal: true });
      if (event.payload.type === 'fold') folded.add(event.payload.playerId);
    }
  }
  if (!equal(sortedRecord(contributions), sortedRecord(audit.contributionsBeforeRefund))) return invalid('贡献复算失败', { commitment: true, deck: true, deal: true });
  const ranked = Object.entries(audit.contributionsBeforeRefund).filter(([, amount]) => amount > 0).sort(([, left], [, right]) => right - left);
  const finalContributions = { ...audit.contributionsBeforeRefund };
  const refund = ranked.length > 0 && ranked[0][1] > (ranked[1]?.[1] ?? 0) ? { playerId: ranked[0][0], amount: ranked[0][1] - (ranked[1]?.[1] ?? 0) } : undefined;
  if (refund) finalContributions[refund.playerId] -= refund.amount;
  if (!equal(refund, audit.result.refund) || !equal(sortedRecord(finalContributions), sortedRecord(audit.finalContributions)) || !equal([...folded].sort(), [...audit.foldedPlayerIds].sort())) return invalid('结算前状态不一致', { commitment: true, deck: true, deal: true, contributions: true });
  const remaining = audit.participantIds.filter((id) => !folded.has(id));
  const settledBy = remaining.length === 1 ? 'fold' : 'showdown';
  if (audit.result.settledBy !== settledBy || (settledBy === 'showdown' && audit.board.length !== 5) || settlementEvents[0].payload.settledBy !== settledBy) return invalid('结算方式不一致', { commitment: true, deck: true, deal: true, contributions: true });
  const pots = potBreakdown(audit.finalContributions, folded);
  if (!equal(pots, audit.result.pots)) return invalid('底池复算失败', { commitment: true, deck: true, deal: true, contributions: true });
  const payouts = {};
  for (const pot of pots) {
    if (pot.eligiblePlayerIds.length === 0) return invalid('底池没有合格玩家', { commitment: true, deck: true, deal: true, contributions: true });
    const winners = pot.eligiblePlayerIds.length === 1 ? pot.eligiblePlayerIds : (() => {
      const ranks = pot.eligiblePlayerIds.map((id) => ({ id, rank: evaluateSeven([...(audit.holeCards[id] ?? []), ...audit.board]) }));
      const best = ranks.reduce((winner, item) => compareRanks(item.rank, winner) > 0 ? item.rank : winner, ranks[0].rank);
      return ranks.filter((item) => compareRanks(item.rank, best) === 0).map((item) => item.id);
    })();
    const ordered = [...winners].sort((left, right) => buttonDistance(audit.seatByPlayerId[left], audit.dealerSeat, audit.maxSeats) - buttonDistance(audit.seatByPlayerId[right], audit.dealerSeat, audit.maxSeats));
    const share = Math.floor(pot.amount / ordered.length);
    let remainder = pot.amount % ordered.length;
    for (const winner of ordered) payouts[winner] = (payouts[winner] ?? 0) + share + (remainder-- > 0 ? 1 : 0);
  }
  const settlement = settlementEvents[0].payload;
  if (!equal(sortedRecord(payouts), sortedRecord(audit.result.payouts)) || !settlement.payouts || typeof settlement.payouts !== 'object'
    || !equal(settlement.board, audit.board) || !equal(settlement.pots, pots) || !equal(settlement.refund, refund) || !equal(sortedRecord(settlement.payouts), sortedRecord(payouts))) return invalid('派奖复算失败', { commitment: true, deck: true, deal: true, contributions: true });
  return { verified: true, checks: { package: true, commitment: true, deck: true, deal: true, contributions: true, settlement: true } };
}

export function createVerificationPackage(audit, publicCommitment) {
  return { formatVersion: AUDIT_PACKAGE_VERSION, publicCommitment, audit: structuredClone(audit) };
}

export async function verifyVerificationPackage(value) {
  if (!value || typeof value !== 'object' || value.formatVersion !== AUDIT_PACKAGE_VERSION || typeof value.publicCommitment !== 'string' || !value.audit) return invalid('验证包格式无效', { package: false });
  return verifyAuditMaterial(value.audit, value.publicCommitment);
}
