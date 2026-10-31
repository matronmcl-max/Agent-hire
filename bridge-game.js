// Bridge prototype game state — server side, in memory only.
// Uses bridge-engine (MIT, Kingston Duffie, 2022) via dist/lib — NOT the
// package main entry, which runs the author's 24-board sample on require.
// No database, no money, no job/MCP routes touched. One hand at a time per
// session; a server restart ends any hand in progress (prototype limit).
//
// How it works: BridgeTable.playBoard() runs in the background for a session
// and pauses whenever it asks the human player to bid or play, because the
// human player's bid()/play() return promises that only resolve when the
// browser posts that bid/card. Bots (BbsBidder + BasicCardPlayer) answer at
// once, so the loop races on to the next human turn on its own.

const crypto = require('crypto');
const {
  BridgeTable, BridgePlayer, BridgePlayerBase,
  Bid, BidWithSeat,
  getPartnerBySeat, getSeatFollowing,
} = require('bridge-engine/dist/lib');
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

function serialize(session) {
  const board = session.board;
  if (!board) return { status: 'waiting', session: session.id };
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
function newSession() {
  const id = crypto.randomBytes(8).toString('hex');
  const session = { id, pending: null, error: null, board: null, table: null };
  const human = new HumanPlayer(session);
  const table = new BridgeTable({ assignContract: false });
  // assignTeam, not assignPlayer: assignPlayer rejects a player whose
  // conventions do not match its partner's, and the human base player
  // carries approach 'none' while the bot bidder carries 'bbs'.
  table.assignTeam('NS', [
    new BridgePlayer(new BbsBidder(), new BasicCardPlayer()),
    human,
  ]);
  table.assignTeam('EW', [
    new BridgePlayer(new BbsBidder(), new BasicCardPlayer()),
    new BridgePlayer(new BbsBidder(), new BasicCardPlayer()),
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

module.exports = { newSession, startSession, getSession, serialize, submitBid, submitPlay, SEAT_NAMES };
