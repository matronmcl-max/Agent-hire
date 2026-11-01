// Bridge game state — hands are PERSISTED, not just in memory.
// Uses bridge-engine (MIT, Kingston Duffie, 2022) via dist/lib — NOT the
// package main entry, which runs the author's 24-board sample on require.
// No database, no money, no job/MCP routes touched. One hand at a time per
// session.
//
// How it works: BridgeTable.playBoard() runs in the background for a session
// and pauses whenever it asks the human player to bid or play, because the
// human player's bid()/play() return promises that only resolve when the
// browser posts that bid/card. Bots (BbsBidder + BasicCardPlayer) answer at
// once, so the loop races on to the next human turn on its own.
//
// Persistence: after every state change, serialize() snapshots the hand
// (original deal + bids + plays in order) and hands it to a save function
// supplied by server.js (Turso live, local SQLite locally). On a server
// restart, restoreSession() rebuilds the same deal and replays the recorded
// bids/plays through a fresh playBoard() loop, then hands control back to
// the human/robot players at exactly the point the hand stopped. A restart
// therefore resumes the hand instead of wiping it.

const crypto = require('crypto');
const {
  BridgeTable, BridgePlayer, BridgePlayerBase, Board, Hand,
  Bid, BidWithSeat, RandomGeneratorImpl,
  getPartnerBySeat, getSeatFollowing,
} = require('bridge-engine/dist/lib');
const { Card } = require('bridge-engine/dist/card');

// Save function supplied by server.js: saveSnapshot(snapshot) => Promise.
// Null when no persistence is wired (tests that do not need it).
let saveFn = null;
function setSaveFn(fn) { saveFn = fn; }
// The robot bidder/player are NOT re-exported from dist/lib — they live
// in dist/robots/ and must be imported directly.
const { BbsBidder } = require('bridge-engine/dist/robots/bbs-bidder');
const { BasicCardPlayer } = require('bridge-engine/dist/robots/basic-player');

// ---------------------------------------------------------------- human ---
class HumanPlayer extends BridgePlayerBase {
  constructor(session) { super(); this.session = session; }
  bid(board, hand) {
    return new Promise((resolve) => {
      this.session.pending = { kind: 'bid', board, hand, resolve };
    });
  }
  play(board, hand, dummy) {
    return new Promise((resolve) => {
      this.session.pending = { kind: 'play', board, hand, dummy, resolve };
    });
  }
  playFromDummy(board, dummy, hand) {
    return new Promise((resolve) => {
      this.session.pending = { kind: 'playFromDummy', board, dummy, hand, resolve };
    });
  }
}

// Bots answer instantly, so a hand where you are dummy (or between your
// turns) used to race to the finish before you could see a single trick.
// Slow every robot card play down so the table is actually watchable.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitWhilePaused(getPaused) {
  while (getPaused && getPaused()) await sleep(500);
}
class SlowCardPlayer {
  constructor(inner, getPaused) { this._inner = inner; this._getPaused = getPaused; }
  get seat() { return this._inner.seat; }
  set seat(v) { this._inner.seat = v; }
  startPlay(c) { return this._inner.startPlay(c); }
  finishPlay(c) { return this._inner.finishPlay(c); }
  async play(c, hand, dummy) { await waitWhilePaused(this._getPaused); await sleep(1100); await waitWhilePaused(this._getPaused); return this._inner.play(c, hand, dummy); }
  async playFromDummy(c, dummy, hand) { await waitWhilePaused(this._getPaused); await sleep(1100); await waitWhilePaused(this._getPaused); return this._inner.playFromDummy(c, dummy, hand); }
}
// Robot bidding is instant, so a paused hand would otherwise bid on
// while the user is away. Make the bidder wait while paused, too.
class PausingBidder {
  constructor(inner, getPaused) { this._inner = inner; this._getPaused = getPaused; }
  get seat() { return this._inner.seat; }
  set seat(v) { this._inner.seat = v; }
  get conventionCard() { return this._inner.conventionCard; }
  acceptConventions(c) { return this._inner.acceptConventions(c); }
  async startBoard() {}
  async bid(board, hand) { await waitWhilePaused(this._getPaused); await waitWhilePaused(this._getPaused); return this._inner.bid(board, hand); }
}

// ------------------------------------------------------- replay player ---
// Used only when restoring a persisted hand. It replays recorded bids and
// plays in order, instantly, and once the recording runs out it delegates
// to the real player (human for South, slow robot for the other seats).
// That is what makes a restored hand continue exactly where it stopped.
class ReplayPlayer {
  constructor(inner, replay) { this._inner = inner; this._replay = replay; this._seat = 'N'; }
  get seat() { return this._seat; }
  set seat(v) { this._seat = v; if (this._inner) this._inner.seat = v; }
  get conventionCard() { return this._inner ? this._inner.conventionCard : null; }
  acceptConventions(c) { return this._inner ? this._inner.acceptConventions(c) : true; }
  async startBoard() {}
  async startPlay() {}
  async finishPlay() {}
  async bid(board, hand) {
    const r = this._replay;
    if (r.bidIndex < r.bids.length && r.bids[r.bidIndex].by === this._seat) {
      const b = r.bids[r.bidIndex++];
      return new Bid(b.type, b.type === 'normal' ? b.count : undefined, b.type === 'normal' ? b.strain : undefined);
    }
    return this._inner.bid(board, hand);
  }
  async play(board, hand, dummy) {
    const r = this._replay;
    if (r.playIndex < r.plays.length && r.plays[r.playIndex].by === this._seat) {
      const p = r.plays[r.playIndex++];
      const card = findCard(hand, p.card);
      if (card) return card;
    }
    return this._inner.play(board, hand, dummy);
  }
  async playFromDummy(board, dummy, hand) {
    const r = this._replay;
    if (r.playIndex < r.plays.length) {
      const p = r.plays[r.playIndex++];
      const card = findCard(dummy, p.card);
      if (card) return card;
    }
    return this._inner.playFromDummy(board, dummy, hand);
  }
}

// -------------------------------------------------------------- helpers ---
const SEATS = ['N', 'E', 'S', 'W'];
const SEAT_NAMES = { N: 'North', E: 'East', S: 'South', W: 'West' };
const SUIT_SYMBOLS = { C: '♣', D: '♦', H: '♥', S: '♠', N: 'NT' };

function cardText(card) {
  const rank = card.rank === 'T' ? '10' : card.rank;
  return card.suit === 'N' ? rank : rank + SUIT_SYMBOLS[card.suit];
}
function cardId(card) { return card.rank + card.suit; } // e.g. "AH", "TS"
function handCards(hand) {
  // CardSet.cards is already ordered S, H, D, C, high to low.
  return hand.unplayed.cards.map((c) => ({ id: cardId(c), text: cardText(c), suit: c.suit, rank: c.rank }));
}
function findCard(hand, id) {
  // Do NOT use Card.parse: in bridge-engine 0.1.0 it parses K/Q/J/T all as
  // 'A'. Match the live card object by rank + suit instead.
  return hand.unplayed.cards.find((c) => cardId(c) === id) || null;
}
function bidText(bid) {
  if (bid.type === 'pass') return 'Pass';
  if (bid.type === 'double') return 'Double';
  if (bid.type === 'redouble') return 'Redouble';
  return `${bid.count}${SUIT_SYMBOLS[bid.strain]}`;
}
function bidId(bid) {
  if (bid.type === 'pass') return 'pass';
  if (bid.type === 'double') return 'dbl';
  if (bid.type === 'redouble') return 'rdbl';
  return `${bid.count}${bid.strain.toLowerCase()}`;
}

// Legal bids for South right now, computed against the live board so the
// buttons can never offer an illegal bid (the engine asserts on illegal
// bids, which would kill the hand).
function legalBids(board) {
  const out = [{ id: 'pass', text: 'Pass', type: 'pass' }];
  const lastNormal = board.getLastNormalBid();
  for (let count = 1; count <= 7; count++) {
    for (const strain of ['C', 'D', 'H', 'S', 'N']) {
      const bid = new Bid('normal', count, strain);
      if (!lastNormal || bid.isLarger(lastNormal)) {
        out.push({ id: `${count}${strain.toLowerCase()}`, text: `${count}${SUIT_SYMBOLS[strain]}`, type: 'normal', count, strain });
      }
    }
  }
  for (const type of ['double', 'redouble']) {
    const probe = new BidWithSeat('S', type);
    if (board.isLegalFollowing(probe)) {
      out.push({ id: type === 'double' ? 'dbl' : 'rdbl', text: type === 'double' ? 'Double' : 'Redouble', type });
    }
  }
  return out;
}

// Snapshot: everything needed to rebuild this hand from scratch.
// Original deal = allCards (not unplayed, which shrinks as cards go out).
function snapshot(session) {
  const board = session.board;
  if (!board) return null;
  const plays = [];
  for (const t of board.tricks) for (const p of t.plays) plays.push({ by: p.by, card: cardId(p.card) });
  const hands = {};
  for (const s of SEATS) hands[s] = board.getHand(s).allCards.cards.map((c) => cardId(c));
  return {
    id: session.id,
    dealer: board.dealer,
    vulnerability: board.vulnerability,
    hands,
    bids: board.bids.map((b) => ({ by: b.by, type: b.type, count: b.type === 'normal' ? b.count : null, strain: b.type === 'normal' ? b.strain : null })),
    plays,
  };
}

function serialize(session) {
  const board = session.board;
  if (!board) return { status: 'waiting', session: session.id };
  // Persist on change: every poll that sees a new bid/play saves it, so
  // a restart never loses more than the very latest move in flight.
  if (saveFn) {
    const snap = snapshot(session);
    const snapJson = JSON.stringify(snap);
    if (snap && snapJson !== session.lastSavedJson) {
      session.lastSavedJson = snapJson;
      Promise.resolve().then(() => saveFn(snap)).catch(() => { session.lastSavedJson = null; });
    }
  }
  const contract = board.contract;
  const tricks = board.tricks || [];
  const currentTrick = tricks.length ? tricks[tricks.length - 1] : null;
  const openingLeadPlayed = tricks.length > 0 && tricks[0].plays.length > 0;
  const dummySeat = contract ? getPartnerBySeat(contract.declarer) : null;
  const pending = session.pending;
  let pendingInfo = null;
  if (pending) {
    if (pending.kind === 'bid') {
      pendingInfo = { kind: 'bid', seat: 'S', seatName: 'South', legalBids: legalBids(board) };
    } else {
      const playingHand = pending.kind === 'playFromDummy' ? pending.dummy : pending.hand;
      const playingSeat = pending.kind === 'playFromDummy' ? dummySeat : 'S';
      const leadSuit = currentTrick ? currentTrick.getLeadSuit() : null;
      const eligible = playingHand.getEligibleToPlay(leadSuit).cards;
      pendingInfo = {
        kind: pending.kind,
        seat: playingSeat,
        seatName: SEAT_NAMES[playingSeat],
        playingDummy: pending.kind === 'playFromDummy',
        eligibleCards: eligible.map((c) => ({ id: cardId(c), text: cardText(c), suit: c.suit, rank: c.rank })),
      };
    }
  }
  return {
    session: session.id,
    status: board.status, // created | bidding | play | complete
    passedOut: !!board.passedOut,
    dealer: board.dealer,
    dealerName: SEAT_NAMES[board.dealer],
    vulnerability: board.vulnerability,
    bids: board.bids.map((b) => ({ by: b.by, byName: SEAT_NAMES[b.by], text: bidText(b) })),
    contract: contract ? {
      text: `${contract.count}${SUIT_SYMBOLS[contract.strain]}${contract.doubling === 'doubled' ? ' doubled' : contract.doubling === 'redoubled' ? ' redoubled' : ''}`,
      declarer: contract.declarer,
      declarerName: SEAT_NAMES[contract.declarer],
      dummySeat,
      dummyName: dummySeat ? SEAT_NAMES[dummySeat] : null,
      count: contract.count,
      strain: contract.strain,
      vulnerable: contract.vulnerable,
      tricksNeeded: contract.count + 6,
    } : null,
    // South's own hand is always visible; other hands are counts only,
    // except the dummy hand, which is face-up for everyone once the
    // opening lead has been played (real bridge rule).
    southHand: handCards(board.getHand('S')),
    handCounts: Object.fromEntries(SEATS.map((s) => [s, board.getHand(s).unplayed.length])),
    dummyHand: (contract && openingLeadPlayed) ? handCards(board.getHand(dummySeat)) : null,
    currentTrick: currentTrick ? currentTrick.plays.map((p) => ({ by: p.by, byName: SEAT_NAMES[p.by], text: cardText(p.card) })) : [],
    completedTricks: board.completedTricks.map((t) => ({
      plays: t.plays.map((p) => ({ by: p.by, text: cardText(p.card) })),
      winner: t.winner ? t.winner.by : null,
    })),
    declarerTricks: board.declarerTricks,
    defenseTricks: board.defenseTricks,
    pending: pendingInfo,
    paused: !!session.paused,
    error: session.error || null,
    result: board.status === 'complete' && contract ? {
      declarerTricks: board.declarerTricks,
      tricksNeeded: contract.count + 6,
      made: board.declarerTricks >= contract.count + 6,
      // Engine score is from the declarer's point of view.
      declarerScore: board.declarerScore,
      yourTeamScore: contract.partnership === 'NS' ? board.declarerScore : -board.declarerScore,
    } : null,
  };
}

// ------------------------------------------------------------- sessions ---
const sessions = new Map();
function setPaused(session, paused) { if (session) session.paused = !!paused; }
function makeRobot(getPaused) {
  return new BridgePlayer(new PausingBidder(new BbsBidder(), getPaused), new SlowCardPlayer(new BasicCardPlayer(), getPaused));
}
function newSession() {
  const id = crypto.randomBytes(8).toString('hex');
  const session = { id, pending: null, error: null, board: null, table: null, paused: false };
  const getPaused = () => session.paused;
  const human = new HumanPlayer(session);
  const table = new BridgeTable({ assignContract: false });
  // assignTeam, not assignPlayer: assignPlayer rejects a player whose
  // conventions do not match its partner's, and the human base player
  // carries approach 'none' while the bot bidder carries 'bbs'.
  table.assignTeam('NS', [
    makeRobot(getPaused),
    human,
  ]);
  table.assignTeam('EW', [
    makeRobot(getPaused),
    makeRobot(getPaused),
  ]);
  session.table = table;
  session.human = human;
  sessions.set(id, session);
  if (sessions.size > 20) {
    const oldest = sessions.keys().next().value;
    sessions.delete(oldest);
  }
  return session;
}

async function startSession(session) {
  const board = await session.table.startBoard();
  session.board = board;
  // Run in the background; it pauses at every human bid/play.
  session.table.playBoard().catch((e) => {
    session.error = e && e.message ? e.message : String(e);
    session.pending = null;
  });
  return board;
}

function getSession(id) { return sessions.get(id) || null; }

// Rebuild a hand from a snapshot and replay it to the saved point.
// Returns the session, or null if the snapshot is unusable.
async function restoreSession(snap) {
  try {
    if (!snap || !snap.id || !snap.hands || !snap.dealer || !snap.vulnerability) return null;
    const session = { id: snap.id, pending: null, error: null, board: null, table: null, paused: false, lastSavedJson: JSON.stringify(snap) };
    const getPaused = () => session.paused;
    const human = new HumanPlayer(session);
    const replay = { bids: snap.bids || [], bidIndex: 0, plays: snap.plays || [], playIndex: 0 };
    const robot = () => makeRobot(getPaused);
    const table = new BridgeTable({ assignContract: false });
    table.assignTeam('NS', [
      new ReplayPlayer(robot(), replay),
      new ReplayPlayer(human, replay),
    ]);
    table.assignTeam('EW', [
      new ReplayPlayer(robot(), replay),
      new ReplayPlayer(robot(), replay),
    ]);
    session.table = table;
    session.human = human;
    // Rebuild the original deal, then let startBoard copy it into a
    // fresh board (status 'created', no bids/plays yet) for replay.
    const hands = new Map();
    for (const s of SEATS) {
      const hand = new Hand();
      for (const cid of snap.hands[s]) {
        const rank = cid.slice(0, -1), suit = cid.slice(-1);
        hand.dealCard(new Card(rank, suit));
      }
      hands.set(s, hand);
    }
    const seedBoard = new Board(snap.id, snap.vulnerability, snap.dealer, hands, new RandomGeneratorImpl());
    const board = await table.startBoard(seedBoard);
    session.board = board;
    sessions.set(session.id, session);
    if (sessions.size > 20) {
      const oldest = sessions.keys().next().value;
      if (oldest !== session.id) sessions.delete(oldest);
    }
    // Replay in the background; it pauses at the first un-recorded human
    // turn, exactly where the original hand stopped.
    table.playBoard().catch((e) => {
      session.error = e && e.message ? e.message : String(e);
      session.pending = null;
    });
    return session;
  } catch (e) {
    console.error('bridge restore failed', e);
    return null;
  }
}

function submitBid(session, bidIdValue) {
  const pending = session.pending;
  if (!pending || pending.kind !== 'bid') throw new Error('It is not your turn to bid right now.');
  const legal = legalBids(session.board).map((b) => b.id);
  if (!legal.includes(bidIdValue)) throw new Error('That bid is not allowed right now.');
  session.pending = null;
  pending.resolve(Bid.parse(bidIdValue));
}

function submitPlay(session, cardIdValue) {
  const pending = session.pending;
  if (!pending || (pending.kind !== 'play' && pending.kind !== 'playFromDummy')) {
    throw new Error('It is not your turn to play a card right now.');
  }
  const playingHand = pending.kind === 'playFromDummy' ? pending.dummy : pending.hand;
  const card = findCard(playingHand, cardIdValue);
  if (!card) throw new Error('That card is not in the hand you are playing from.');
  session.pending = null;
  pending.resolve(card);
}

module.exports = { newSession, startSession, getSession, serialize, submitBid, submitPlay, restoreSession, setSaveFn, snapshot, setPaused, SEAT_NAMES };
