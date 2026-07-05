'use strict';

/*
 * Fish (Literature) — authoritative multiplayer server.
 *
 * Unlike the sibling Chess server (which trusts a client-side engine), this
 * server is the SOLE authority. It holds every player's hand secretly, validates
 * every action, and sends each client only its own hand plus public information.
 * Clients never receive another player's cards.
 *
 * In-memory only. Node.js + ws. Also serves fish.html at / so a single Render
 * web service can host both the page and the socket.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PLAYER_COUNT = 6;      // Fish is 6-player only in this build.
const DECL_MS = 120000;      // 2-minute declaration safety cap (prevents an
                             // abandoned declaration from hanging the table).
const PAUSE_MS = 60000;      // Wait/Stop auto-resume cap (anti-abuse)
// How long a bot "thinks" before acting. 5s in normal play so humans can follow
// along; overridable (e.g. BOT_DELAY_MS=50) so headless tests run fast.
const BOT_DELAY_MS = Number(process.env.BOT_DELAY_MS) || 5000;
const DISCONNECT_BOT_MS = 8000; // grace before a bot covers a disconnected player's turn
const ROOM_GC_MS = 30 * 60 * 1000;
// Non-cheating bots only declare sets they're certain of, which can livelock if
// two teammates each hold an un-asked card of the same set (neither can verify
// the other). After this many asks with no declaration, the acting bot makes
// its best-guess declaration so the game always makes progress. High enough that
// genuine deduction usually resolves a set first; low enough to guarantee an end.
const BOT_STALL_ASKS = 24;

// ---------------------------------------------------------------------------
// Cards & half-suits
// ---------------------------------------------------------------------------
const SUITS = ['S', 'H', 'D', 'C'];
const LOW_RANKS = ['2', '3', '4', '5', '6', '7'];
const HIGH_RANKS = ['9', '10', 'J', 'Q', 'K', 'A'];
const RANK_ORDER = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

// A card id is suit+rank ("S2", "H10", "CA") or a joker ("JR" / "JB").
function cardSuit(id) { return id[0]; }
function cardRank(id) { return id.slice(1); }
function isJoker(id) { return id === 'JR' || id === 'JB'; }

// '6' mode: full 54-card deck (incl. two jokers), 9 half-suits.
// '8' mode: 48-card deck (no 8s, no jokers), 8 half-suits.
function buildDeck(mode) {
  const cards = [];
  for (const s of SUITS) {
    for (const r of LOW_RANKS) cards.push(s + r);
    for (const r of HIGH_RANKS) cards.push(s + r);
    if (mode === '6') cards.push(s + '8');
  }
  if (mode === '6') { cards.push('JR'); cards.push('JB'); }
  return cards;
}

function cardHalfSuit(id) {
  if (isJoker(id)) return 'EIGHTS';
  const r = cardRank(id);
  if (r === '8') return 'EIGHTS';
  const low = LOW_RANKS.includes(r);
  return cardSuit(id) + (low ? '_LOW' : '_HIGH');
}

function allHalfSuits(mode) {
  const list = [];
  for (const s of SUITS) { list.push(s + '_LOW'); list.push(s + '_HIGH'); }
  if (mode === '6') list.push('EIGHTS');
  return list;
}

function halfSuitCards(hsId, mode) {
  if (hsId === 'EIGHTS') return ['S8', 'H8', 'D8', 'C8', 'JR', 'JB'];
  const suit = hsId[0];
  const ranks = hsId.endsWith('_LOW') ? LOW_RANKS : HIGH_RANKS;
  return ranks.map(r => suit + r);
}

function validCardSet(mode) {
  const set = new Set(buildDeck(mode));
  return set;
}

function sortHand(hand) {
  return hand.slice().sort((a, b) => {
    const ja = isJoker(a), jb = isJoker(b);
    if (ja || jb) {
      if (ja && jb) return a < b ? -1 : 1;
      return ja ? 1 : -1; // jokers last
    }
    const sa = SUITS.indexOf(cardSuit(a)), sb = SUITS.indexOf(cardSuit(b));
    if (sa !== sb) return sa - sb;
    return RANK_ORDER.indexOf(cardRank(a)) - RANK_ORDER.indexOf(cardRank(b));
  });
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------
const rooms = new Map();
const sockets = new WeakMap(); // ws -> { code, seat, token }

function generateCode() {
  for (let i = 0; i < 60; i++) {
    let code = '';
    for (let j = 0; j < 4; j++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  return crypto.randomBytes(3).toString('hex').toUpperCase();
}
function generateToken() { return crypto.randomBytes(16).toString('hex'); }

function send(ws, msg) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify(msg)); } catch (_) {}
}
function sendError(ws, code, msg) { send(ws, { type: 'error', code, msg }); }

function broadcast(room, msg) {
  for (const seat of room.seats) {
    if (seat && seat.socket) send(seat.socket, msg);
  }
}

function teamOf(seatIndex) { return seatIndex % 2; }

function freshKnowledge() {
  // Server-side public-derived knowledge used by bots (mirrors what an attentive
  // player would deduce from witnessed asks). Not sent to clients.
  return { has: {}, lacks: {}, inSet: {} }; // seat -> Set/obj
}

function emptySeats(playerCount) {
  return Array.from({ length: playerCount }, (_, i) => null);
}

// ---------------------------------------------------------------------------
// State broadcasting
// ---------------------------------------------------------------------------
function publicSeats(room) {
  return room.seats.map((s, i) => s ? {
    seat: i, name: s.name, team: teamOf(i), isBot: s.isBot,
    connected: s.isBot ? true : s.connected, handCount: s.hand.length,
    empty: false,
  } : { seat: i, name: null, team: teamOf(i), isBot: false, connected: false, handCount: 0, empty: true });
}

function publicStateMsg(room) {
  return {
    type: 'publicState',
    code: room.code,
    status: room.status,
    config: room.config,
    hostSeat: room.hostSeat,
    seats: publicSeats(room),
    dealerSeat: room.dealerSeat,
    turnSeat: room.turnSeat,
    lastQuestion: room.lastQuestion,
    claimed: { 0: room.claimed[0], 1: room.claimed[1] },
    score: { 0: room.claimed[0].length, 1: room.claimed[1].length },
    halfSuits: allHalfSuits(room.config.mode),
    endgame: room.endgame,
    declaration: room.declaration ? {
      declarerSeat: room.declaration.declarerSeat,
      hsId: room.declaration.hsId,
      deadlineAt: room.declaration.deadlineAt,
    } : null,
    pause: room.pause ? { bySeat: room.pause.bySeat, deadlineAt: room.pause.deadlineAt } : null,
    pendingPass: room.pendingPass ? { seat: room.pendingPass.seat } : null,
    pendingFinalChooser: room.pendingFinalChooser ? { seat: room.pendingFinalChooser.seat } : null,
    winner: room.winner,
  };
}

function privateStateMsg(room, seat) {
  const s = room.seats[seat];
  return { type: 'privateState', seat, hand: s ? sortHand(s.hand) : [] };
}

function sendStates(room) {
  const pub = publicStateMsg(room);
  for (let i = 0; i < room.seats.length; i++) {
    const s = room.seats[i];
    if (s && s.socket) { send(s.socket, pub); send(s.socket, privateStateMsg(room, i)); }
  }
}

function lobbyBroadcast(room) {
  broadcast(room, publicStateMsg(room));
}

// ---------------------------------------------------------------------------
// Timers (declaration safety cap + pause auto-resume only; no per-turn timer)
// ---------------------------------------------------------------------------
function clearTimer(room, key) {
  if (room.timers[key]) { clearTimeout(room.timers[key]); room.timers[key] = null; }
}

// ---------------------------------------------------------------------------
// Lobby handlers
// ---------------------------------------------------------------------------
function makeRoom() {
  return {
    code: generateCode(),
    status: 'lobby',
    // teamMode is always 'manual': the host always arranges teams (there is no
    // random-assign option).
    config: { playerCount: PLAYER_COUNT, teamMode: 'manual', mode: '6', declMs: DECL_MS },
    hostSeat: 0,
    seats: emptySeats(PLAYER_COUNT),
    dealerSeat: null,
    turnSeat: null,
    lastQuestion: null,
    claimed: { 0: [], 1: [] },
    declaration: null,
    pause: null,
    pendingPass: null,
    pendingFinalChooser: null,
    endgame: false,
    winner: null,
    knowledge: freshKnowledge(),
    asksSinceDeclare: 0,
    timers: { decl: null, pause: null },
    botTimers: {},
    disconnectTimers: {},
    createdAt: Date.now(),
    finishedExpiryHandle: null,
  };
}

function firstFreeSeat(room, parity) {
  for (let i = 0; i < room.seats.length; i++) {
    if (room.seats[i]) continue;
    if (parity != null && teamOf(i) !== parity) continue;
    return i;
  }
  return -1;
}

function handleCreate(ws, msg) {
  const name = sanitizeName(msg.name) || 'Player 1';
  const room = makeRoom();
  const token = generateToken();
  room.seats[0] = { name, token, socket: ws, isBot: false, connected: true, hand: [] };
  room.hostSeat = 0;
  rooms.set(room.code, room);
  sockets.set(ws, { code: room.code, seat: 0, token });
  send(ws, { type: 'created', code: room.code, token, seat: 0 });
  sendStates(room);
}

function handleJoin(ws, msg) {
  const code = typeof msg.code === 'string' ? msg.code.toUpperCase().trim() : '';
  const room = rooms.get(code);
  if (!room) { sendError(ws, 'NOT_FOUND', 'Game code not found.'); return; }
  if (room.status !== 'lobby') { sendError(ws, 'IN_PROGRESS', 'That game has already started.'); return; }
  const seatIdx = firstFreeSeat(room, null);
  if (seatIdx < 0) { sendError(ws, 'FULL', 'That game is full.'); return; }
  const name = sanitizeName(msg.name) || ('Player ' + (seatIdx + 1));
  const token = generateToken();
  room.seats[seatIdx] = { name, token, socket: ws, isBot: false, connected: true, hand: [] };
  sockets.set(ws, { code, seat: seatIdx, token });
  send(ws, { type: 'created', code, token, seat: seatIdx });
  sendStates(room);
}

function sanitizeName(n) {
  if (typeof n !== 'string') return '';
  return n.replace(/[^\w \-'.]/g, '').trim().slice(0, 16);
}

function requireHost(ws, room) {
  const meta = sockets.get(ws);
  return meta && room && meta.seat === room.hostSeat && !room.seats[room.hostSeat].isBot;
}

// Manual team control: ONLY the host arranges teams, by swapping two seats
// (team = seat parity). The host may never move their own seat, so their team
// never changes; they can swap any two other seats — including swapping two
// already-joined players, or moving a player into an empty seat on the other
// team. Non-hosts cannot change anyone's team.
function handleSwapSeats(ws, msg) {
  const meta = sockets.get(ws); if (!meta) return;
  const room = rooms.get(meta.code); if (!room || room.status !== 'lobby') return;
  if (!requireHost(ws, room)) { sendError(ws, 'NOT_HOST', 'Only the host can change teams.'); return; }
  const a = msg.seatA, b = msg.seatB;
  const n = room.seats.length;
  if (typeof a !== 'number' || typeof b !== 'number' || a === b || a < 0 || b < 0 || a >= n || b >= n) {
    sendError(ws, 'BAD_SWAP', 'Pick two different seats to swap.'); return;
  }
  if (a === room.hostSeat || b === room.hostSeat) {
    sendError(ws, 'NO_SELF', 'You can\'t change your own team.'); return;
  }
  const occA = room.seats[a], occB = room.seats[b];
  if (!occA && !occB) return; // both empty — nothing to do
  room.seats[a] = occB;
  room.seats[b] = occA;
  // Keep each moved human's socket→seat mapping current.
  if (occA && occA.socket) { const m = sockets.get(occA.socket); if (m) m.seat = b; }
  if (occB && occB.socket) { const m = sockets.get(occB.socket); if (m) m.seat = a; }
  sendStates(room);
}

function reassignHostIfNeeded(room) {
  // Host should point at a human seat; if vacated, pick the lowest human seat.
  const cur = room.seats[room.hostSeat];
  if (cur && !cur.isBot) return;
  for (let i = 0; i < room.seats.length; i++) {
    if (room.seats[i] && !room.seats[i].isBot) { room.hostSeat = i; return; }
  }
}

function handleAddBot(ws, msg) {
  const meta = sockets.get(ws); if (!meta) return;
  const room = rooms.get(meta.code); if (!room || room.status !== 'lobby') return;
  if (!requireHost(ws, room)) { sendError(ws, 'NOT_HOST', 'Only the host can add bots.'); return; }
  const parity = (msg.team === 0 || msg.team === 1) ? msg.team : null;
  const idx = firstFreeSeat(room, parity);
  if (idx < 0) { sendError(ws, 'NO_SEAT', 'No free seat for a bot.'); return; }
  room.seats[idx] = { name: 'Bot ' + (idx + 1), token: generateToken(), socket: null, isBot: true, connected: true, hand: [] };
  sendStates(room);
}

function handleRemoveBot(ws, msg) {
  const meta = sockets.get(ws); if (!meta) return;
  const room = rooms.get(meta.code); if (!room || room.status !== 'lobby') return;
  if (!requireHost(ws, room)) { sendError(ws, 'NOT_HOST', 'Only the host can remove bots.'); return; }
  const idx = msg.seat;
  if (typeof idx !== 'number' || !room.seats[idx] || !room.seats[idx].isBot) return;
  room.seats[idx] = null;
  sendStates(room);
}

function handleStartGame(ws) {
  const meta = sockets.get(ws); if (!meta) return;
  const room = rooms.get(meta.code); if (!room || room.status !== 'lobby') return;
  if (!requireHost(ws, room)) { sendError(ws, 'NOT_HOST', 'Only the host can start.'); return; }
  for (let i = 0; i < room.seats.length; i++) {
    if (!room.seats[i]) { sendError(ws, 'NOT_FULL', 'All seats must be filled (add bots if needed).'); return; }
  }
  dealAndStart(room);
}

// ---------------------------------------------------------------------------
// Deal & start
// ---------------------------------------------------------------------------
function dealAndStart(room) {
  // Seats (and therefore teams — team = seat parity) are exactly as the host
  // arranged them in the lobby; dealing never reshuffles who sits where.
  const deck = buildDeck(room.config.mode);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  const per = deck.length / room.seats.length;
  for (let i = 0; i < room.seats.length; i++) {
    room.seats[i].hand = sortHand(deck.slice(i * per, (i + 1) * per));
  }

  room.status = 'playing';
  room.dealerSeat = Math.floor(Math.random() * room.seats.length);
  room.turnSeat = room.dealerSeat;
  room.lastQuestion = null;
  room.claimed = { 0: [], 1: [] };
  room.declaration = null; room.pause = null; room.pendingPass = null;
  room.pendingFinalChooser = null;
  room.endgame = false; room.winner = null;
  room.knowledge = freshKnowledge();
  room.asksSinceDeclare = 0;

  // The host may have swapped seats in the lobby. Tell every connected human its
  // current seat so the client adopts it before receiving state (otherwise the
  // client ignores its own privateState and never sees its hand or its turn).
  for (let i = 0; i < room.seats.length; i++) {
    const s = room.seats[i];
    if (s && s.socket) send(s.socket, { type: 'created', code: room.code, token: s.token, seat: i });
  }

  broadcast(room, { type: 'dealt', dealerSeat: room.dealerSeat });
  sendStates(room);
  scheduleBotIfNeeded(room);
}

// ---------------------------------------------------------------------------
// Knowledge tracking (for bots)
// ---------------------------------------------------------------------------
function kHas(room, seat, card) {
  (room.knowledge.has[seat] = room.knowledge.has[seat] || new Set()).add(card);
  (room.knowledge.inSet[seat] = room.knowledge.inSet[seat] || new Set()).add(cardHalfSuit(card));
  if (room.knowledge.lacks[seat]) room.knowledge.lacks[seat].delete(card);
}
function kLacks(room, seat, card) {
  (room.knowledge.lacks[seat] = room.knowledge.lacks[seat] || new Set()).add(card);
}
function kInSet(room, seat, hs) {
  (room.knowledge.inSet[seat] = room.knowledge.inSet[seat] || new Set()).add(hs);
}
function recordAsk(room, askerSeat, targetSeat, cardId, got) {
  // Everything derivable here is PUBLIC — any attentive player watching the ask
  // learns the same facts. Bots use only this plus their own hand; they never
  // peek at hidden hands.
  const hs = cardHalfSuit(cardId);
  kInSet(room, askerSeat, hs);      // asker must hold another card in this half-suit
  kLacks(room, askerSeat, cardId);  // asker didn't have the asked card (they asked for it)
  if (got) {
    // Card moves target → asker: no one else can be holding it anymore.
    for (const seat in room.knowledge.has) room.knowledge.has[seat].delete(cardId);
    kHas(room, askerSeat, cardId);
    for (let i = 0; i < room.seats.length; i++) if (i !== askerSeat) kLacks(room, i, cardId);
  } else {
    kLacks(room, targetSeat, cardId); // target publicly shown not to hold it
  }
}
function clearKnowledgeForSet(room, hsId) {
  const cards = halfSuitCards(hsId, room.config.mode);
  for (const seat in room.knowledge.has) for (const c of cards) room.knowledge.has[seat].delete(c);
  for (const seat in room.knowledge.lacks) for (const c of cards) room.knowledge.lacks[seat].delete(c);
}

// ---------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------
function handHasInSet(hand, hsId, mode) {
  return halfSuitCards(hsId, mode).some(c => hand.includes(c));
}

function validateAsk(room, askerSeat, targetSeat, cardId) {
  if (room.status !== 'playing') return 'Game is not in play.';
  if (room.pause) return 'Game is paused.';
  if (room.declaration) return 'A declaration is in progress.';
  if (room.pendingPass) return 'A teammate must receive the turn first.';
  if (room.pendingFinalChooser) return 'An opponent must be chosen to declare.';
  if (room.turnSeat !== askerSeat) return 'It is not your turn.';
  if (!validCardSet(room.config.mode).has(cardId)) return 'That card is not in play.';
  const asker = room.seats[askerSeat];
  const target = room.seats[targetSeat];
  if (!target) return 'No such player.';
  if (targetSeat === askerSeat) return 'You cannot ask yourself.';
  if (teamOf(targetSeat) === teamOf(askerSeat)) return 'You may only ask opponents.';
  if (target.hand.length === 0) return 'That player has no cards.';
  if (asker.hand.includes(cardId)) return 'You already hold that card.';
  if (!handHasInSet(asker.hand, cardHalfSuit(cardId), room.config.mode)) {
    return 'You must hold another card in that set to ask.';
  }
  return null;
}

function handleAsk(ws, msg) {
  const meta = sockets.get(ws); if (!meta) return;
  const room = rooms.get(meta.code); if (!room) return;
  const err = validateAsk(room, meta.seat, msg.targetSeat, msg.cardId);
  if (err) { sendError(ws, 'BAD_ASK', err); return; }
  applyAsk(room, meta.seat, msg.targetSeat, msg.cardId);
}

function applyAsk(room, askerSeat, targetSeat, cardId) {
  const asker = room.seats[askerSeat];
  const target = room.seats[targetSeat];
  const idx = target.hand.indexOf(cardId);
  const got = idx >= 0;
  if (got) {
    target.hand.splice(idx, 1);
    asker.hand.push(cardId);
    asker.hand = sortHand(asker.hand);
  }
  recordAsk(room, askerSeat, targetSeat, cardId, got);
  room.asksSinceDeclare = (room.asksSinceDeclare || 0) + 1;
  room.lastQuestion = { askerSeat, targetSeat, cardId, result: got ? 'got' : 'denied' };
  broadcast(room, {
    type: 'askResult', askerSeat, targetSeat, cardId, got,
  });
  if (!got) room.turnSeat = targetSeat;
  // turn stays with asker on success
  const ended = checkEndConditions(room);
  if (!ended) {
    sendStates(room);
    scheduleBotIfNeeded(room);
  }
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------
function handleDeclareStart(ws, msg) {
  const meta = sockets.get(ws); if (!meta) return;
  const room = rooms.get(meta.code); if (!room || room.status !== 'playing') return;
  if (room.declaration) { sendError(ws, 'DECL_BUSY', 'Another declaration is already in progress.'); return; }
  if (room.pause) { sendError(ws, 'PAUSED', 'Game is paused.'); return; }
  if (room.pendingFinalChooser) { sendError(ws, 'CHOOSE_FIRST', 'Choose an opponent to declare the remaining sets.'); return; }
  const hsId = msg.hsId;
  if (!allHalfSuits(room.config.mode).includes(hsId)) { sendError(ws, 'BAD_SET', 'Invalid set.'); return; }
  if (room.claimed[0].includes(hsId) || room.claimed[1].includes(hsId)) {
    sendError(ws, 'CLAIMED', 'That set is already claimed.'); return;
  }
  beginDeclaration(room, meta.seat, hsId);
}

function beginDeclaration(room, declarerSeat, hsId) {
  room.declaration = {
    declarerSeat, hsId,
    deadlineAt: Date.now() + DECL_MS,
    returnTurnSeat: room.turnSeat,
  };
  room.timers.decl = setTimeout(() => onDeclareTimeout(room), DECL_MS);
  sendStates(room);
}

function onDeclareTimeout(room) {
  if (!room.declaration) return;
  // Voluntary declaration timed out → cancel, resume turn (no penalty).
  const ret = room.declaration.returnTurnSeat;
  room.declaration = null;
  clearTimer(room, 'decl');
  room.turnSeat = ret;
  sendStates(room);
  scheduleBotIfNeeded(room);
}

function handleDeclareCancel(ws) {
  const meta = sockets.get(ws); if (!meta) return;
  const room = rooms.get(meta.code); if (!room || !room.declaration) return;
  if (room.declaration.declarerSeat !== meta.seat) return;
  onDeclareTimeout(room); // same effect: cancel & resume
}

function handleDeclareSubmit(ws, msg) {
  const meta = sockets.get(ws); if (!meta) return;
  const room = rooms.get(meta.code); if (!room || !room.declaration) { sendError(ws, 'NO_DECL', 'No declaration in progress.'); return; }
  if (room.declaration.declarerSeat !== meta.seat) { sendError(ws, 'NOT_DECLARER', 'You are not the declarer.'); return; }
  const { hsId } = room.declaration;
  const team = teamOf(meta.seat);
  const cards = halfSuitCards(hsId, room.config.mode);
  const assignments = msg.assignments || {};
  // Validate the submission covers all 6 cards, each assigned to a teammate.
  for (const c of cards) {
    const a = assignments[c];
    if (typeof a !== 'number' || !room.seats[a]) { sendError(ws, 'BAD_DECL', 'Assign every card to a teammate.'); return; }
    if (teamOf(a) !== team) { sendError(ws, 'BAD_DECL', 'You can only assign cards to your own team.'); return; }
  }
  resolveDeclaration(room, meta.seat, hsId, assignments);
}

function resolveDeclaration(room, declarerSeat, hsId, assignments) {
  const team = teamOf(declarerSeat);
  const cards = halfSuitCards(hsId, room.config.mode);
  // Actual holder of each card.
  const actual = {};
  for (const c of cards) {
    for (let i = 0; i < room.seats.length; i++) {
      if (room.seats[i] && room.seats[i].hand.includes(c)) { actual[c] = i; break; }
    }
  }
  let correct = true;
  for (const c of cards) {
    if (actual[c] !== assignments[c]) { correct = false; break; }
    if (teamOf(actual[c]) !== team) { correct = false; break; }
  }
  const winner = correct ? team : (1 - team);
  // Remove the six cards from all hands.
  for (const c of cards) {
    const holder = actual[c];
    if (holder != null) {
      const h = room.seats[holder].hand;
      const k = h.indexOf(c); if (k >= 0) h.splice(k, 1);
    }
  }
  room.claimed[winner].push(hsId);
  room.asksSinceDeclare = 0;
  clearKnowledgeForSet(room, hsId);

  const reveal = cards.map(c => ({ cardId: c, actualSeat: actual[c], assignedSeat: assignments[c] }));
  const ret = room.declaration ? room.declaration.returnTurnSeat : room.turnSeat;
  clearTimer(room, 'decl');
  room.declaration = null;

  broadcast(room, {
    type: 'declarationResult',
    hsId, declarerSeat, success: correct, winnerTeam: winner, reveal,
  });

  // Resume turn (variation: same player's turn continues after declaration).
  resumeTurnAfter(room, ret);

  if (!checkEndConditions(room)) {
    sendStates(room);
    scheduleBotIfNeeded(room);
  }
}

function teammatesWithCards(room, seat) {
  const t = teamOf(seat);
  const out = [];
  for (let i = 0; i < room.seats.length; i++) {
    if (i !== seat && teamOf(i) === t && room.seats[i] && room.seats[i].hand.length > 0) out.push(i);
  }
  return out;
}

function resumeTurnAfter(room, retSeat) {
  room.pendingPass = null;
  room.pendingFinalChooser = null;
  const holder = room.seats[retSeat];
  if (holder && holder.hand.length > 0) { room.turnSeat = retSeat; return; }
  // Turn-holder emptied (e.g. by this declaration). Must pass to a teammate.
  const mates = teammatesWithCards(room, retSeat);
  if (mates.length === 1) { room.turnSeat = mates[0]; return; }
  if (mates.length > 1) { room.pendingPass = { seat: retSeat }; room.turnSeat = retSeat; return; }
  // Whole team is out of cards. If the other team still holds cards, that team
  // must declare every remaining set. Per the rules, the emptied turn-holder
  // chooses which opponent declares (chooseFinalDeclarer). If both teams are
  // empty, all sets are claimed and checkEndConditions will finish the game.
  room.turnSeat = retSeat;
  const otherTeam = 1 - teamOf(retSeat);
  if (teamCardTotal(room, otherTeam) > 0) room.pendingFinalChooser = { seat: retSeat };
}

function handlePassTurn(ws, msg) {
  const meta = sockets.get(ws); if (!meta) return;
  const room = rooms.get(meta.code); if (!room || !room.pendingPass) return;
  if (room.pendingPass.seat !== meta.seat) return;
  const to = msg.toSeat;
  if (typeof to !== 'number' || teamOf(to) !== teamOf(meta.seat) || !room.seats[to] || room.seats[to].hand.length === 0) {
    sendError(ws, 'BAD_PASS', 'Pass to a teammate who has cards.'); return;
  }
  room.pendingPass = null;
  room.turnSeat = to;
  sendStates(room);
  scheduleBotIfNeeded(room);
}

// Endgame: the emptied team's turn-holder picks an opponent (who still holds
// cards) to declare out the remaining sets. The chosen seat becomes the turn-
// holder so their team can declare each leftover half-suit.
function handleChooseFinalDeclarer(ws, msg) {
  const meta = sockets.get(ws); if (!meta) return;
  const room = rooms.get(meta.code); if (!room || !room.pendingFinalChooser) return;
  if (room.pendingFinalChooser.seat !== meta.seat) return;
  const to = msg.toSeat;
  if (typeof to !== 'number' || teamOf(to) === teamOf(meta.seat) || !room.seats[to] || room.seats[to].hand.length === 0) {
    sendError(ws, 'BAD_CHOICE', 'Choose an opponent who still has cards.'); return;
  }
  room.pendingFinalChooser = null;
  room.turnSeat = to;
  sendStates(room);
  scheduleBotIfNeeded(room);
}

// ---------------------------------------------------------------------------
// End conditions
// ---------------------------------------------------------------------------
function teamCardTotal(room, team) {
  let n = 0;
  for (let i = 0; i < room.seats.length; i++) if (teamOf(i) === team && room.seats[i]) n += room.seats[i].hand.length;
  return n;
}

function checkEndConditions(room) {
  const total = allHalfSuits(room.config.mode).length;
  if (room.claimed[0].length + room.claimed[1].length >= total) {
    finishGame(room);
    return true;
  }
  const t0 = teamCardTotal(room, 0), t1 = teamCardTotal(room, 1);
  room.endgame = (t0 === 0 || t1 === 0);
  return false;
}

function finishGame(room) {
  room.status = 'finished';
  room.endgame = false;
  room.declaration = null; room.pause = null; room.pendingPass = null;
  clearTimer(room, 'decl'); clearTimer(room, 'pause');
  for (const k in room.botTimers) { clearTimeout(room.botTimers[k]); }
  room.botTimers = {};
  const a = room.claimed[0].length, b = room.claimed[1].length;
  room.winner = a > b ? 0 : (b > a ? 1 : 'tie');
  broadcast(room, publicStateMsg(room));
  broadcast(room, { type: 'gameOver', winner: room.winner, score: { 0: a, 1: b } });
}

// ---------------------------------------------------------------------------
// Pause (Wait / Stop)
// ---------------------------------------------------------------------------
function handlePause(ws) {
  const meta = sockets.get(ws); if (!meta) return;
  const room = rooms.get(meta.code); if (!room || room.status !== 'playing') return;
  if (room.pause || room.declaration || room.pendingFinalChooser) return;
  room.pause = { bySeat: meta.seat, deadlineAt: Date.now() + PAUSE_MS };
  room.timers.pause = setTimeout(() => { if (room.pause) doResume(room); }, PAUSE_MS);
  sendStates(room);
}
function handleResume(ws) {
  const meta = sockets.get(ws); if (!meta) return;
  const room = rooms.get(meta.code); if (!room || !room.pause) return;
  if (room.pause.bySeat !== meta.seat) return;
  doResume(room);
}
function doResume(room) {
  clearTimer(room, 'pause');
  room.pause = null;
  sendStates(room);
  scheduleBotIfNeeded(room);
}

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------
function scheduleBotIfNeeded(room) {
  if (room.status !== 'playing') return;
  if (room.pendingFinalChooser) { maybeBotChooseFinal(room); return; }
  if (room.pause || room.declaration || room.pendingPass) {
    if (room.pendingPass) maybeBotPass(room);
    return;
  }
  const seat = room.turnSeat;
  const s = room.seats[seat];
  const needsBot = s && (s.isBot || !s.connected);
  if (!needsBot) return;
  if (room.botTimers['turn']) return;
  const delay = s.isBot ? BOT_DELAY_MS : DISCONNECT_BOT_MS;
  room.botTimers['turn'] = setTimeout(() => {
    room.botTimers['turn'] = null;
    try { botAct(room, seat); }
    catch (e) { console.error('botAct error (seat ' + seat + '):', e); }
  }, delay);
}

function maybeBotPass(room) {
  const seat = room.pendingPass.seat;
  const s = room.seats[seat];
  if (!s || (!s.isBot && s.connected)) return;
  if (room.botTimers['pass']) return;
  room.botTimers['pass'] = setTimeout(() => {
    room.botTimers['pass'] = null;
    if (!room.pendingPass || room.pendingPass.seat !== seat) return;
    const mates = teammatesWithCards(room, seat);
    if (mates.length) {
      room.pendingPass = null;
      room.turnSeat = mates[Math.floor(Math.random() * mates.length)];
      sendStates(room); scheduleBotIfNeeded(room);
    }
  }, BOT_DELAY_MS);
}

function maybeBotChooseFinal(room) {
  const seat = room.pendingFinalChooser.seat;
  const s = room.seats[seat];
  if (!s || (!s.isBot && s.connected)) return; // a human chooser acts for themselves
  if (room.botTimers['final']) return;
  room.botTimers['final'] = setTimeout(() => {
    room.botTimers['final'] = null;
    if (!room.pendingFinalChooser || room.pendingFinalChooser.seat !== seat) return;
    const opps = [];
    for (let i = 0; i < room.seats.length; i++) {
      if (teamOf(i) !== teamOf(seat) && room.seats[i] && room.seats[i].hand.length > 0) opps.push(i);
    }
    if (!opps.length) return;
    room.pendingFinalChooser = null;
    room.turnSeat = opps[Math.floor(Math.random() * opps.length)];
    sendStates(room); scheduleBotIfNeeded(room);
  }, BOT_DELAY_MS);
}

// Bots know ONLY their own hand plus what any attentive player could deduce from
// witnessed asks/declarations (room.knowledge). They never look at hidden hands.
function botAct(room, seat) {
  if (room.status !== 'playing' || room.turnSeat !== seat) return;
  if (room.pause || room.declaration || room.pendingPass) return;
  const s = room.seats[seat];
  if (!s || (!s.isBot && s.connected)) return; // human reconnected

  // 1) Declare a set the bot is CERTAIN of — every card is either in its own
  //    hand or was publicly seen to land with a specific teammate. Always exact,
  //    so it never gives a set away by guessing.
  const sure = findConfidentSet(room, seat);
  if (sure) { autoDeclareWith(room, seat, sure.hsId, sure.assignments); return; }

  // 2) Otherwise ask — unless play has stalled (lots of asks, no declaration:
  //    two teammates each sitting on an un-asked card of a set can circle
  //    forever). chooseAsk uses only own hand + public history: a card the bot
  //    lacks in one of its sets, preferring one a specific opponent was seen to
  //    hold and avoiding opponents publicly shown to lack it.
  const stalled = (room.asksSinceDeclare || 0) >= BOT_STALL_ASKS;
  if (!stalled) {
    const ask = chooseAsk(room, seat, true);
    if (ask) { applyAsk(room, seat, ask.targetSeat, ask.cardId); return; }
  }

  // 3) No legal ask left (endgame: opponents are out of cards) OR play has
  //    stalled. The bot declares to make progress, deducing what it can and
  //    guessing the rest — sometimes wrong, just like a real player forced to
  //    call a set they aren't fully sure of.
  const guess = chooseGuessDeclare(room, seat);
  if (guess) { autoDeclareWith(room, seat, guess.hsId, guess.assignments); return; }

  // 4) Fallback (bot momentarily has no cards in any remaining set): just ask.
  const ask = chooseAsk(room, seat, true);
  if (ask) { applyAsk(room, seat, ask.targetSeat, ask.cardId); return; }
}

function remainingSets(room) {
  return allHalfSuits(room.config.mode).filter(h => !room.claimed[0].includes(h) && !room.claimed[1].includes(h));
}

// Seat publicly known to hold `card` (from a witnessed successful ask), or -1.
function knownHolder(room, card) {
  for (const seat in room.knowledge.has) {
    if (room.knowledge.has[seat].has(card)) return Number(seat);
  }
  return -1;
}

// A set is "confident" iff every card is either in the bot's own hand or was
// seen to land with a specific teammate — so the exact declaration is certain.
function findConfidentSet(room, seat) {
  const mode = room.config.mode;
  const myTeam = teamOf(seat);
  const hand = room.seats[seat].hand;
  for (const h of remainingSets(room)) {
    const cards = halfSuitCards(h, mode);
    const assignments = {};
    let ok = true;
    for (const c of cards) {
      if (hand.includes(c)) { assignments[c] = seat; continue; }
      const kh = knownHolder(room, c);
      if (kh >= 0 && teamOf(kh) === myTeam) { assignments[c] = kh; continue; }
      ok = false; break;
    }
    if (ok) return { hsId: h, assignments };
  }
  return null;
}

// Forced endgame declaration: pick the remaining set the bot holds the most of,
// assign own/known cards correctly and guess a card-holding teammate for the
// rest. Only used when the bot has no legal ask, so the game always concludes.
function chooseGuessDeclare(room, seat) {
  const mode = room.config.mode;
  const myTeam = teamOf(seat);
  const hand = room.seats[seat].hand;
  let best = null, bestCount = -1;
  for (const h of remainingSets(room)) {
    const mine = halfSuitCards(h, mode).filter(c => hand.includes(c)).length;
    if (mine > bestCount) { bestCount = mine; best = h; }
  }
  if (!best) return null;
  const withCards = [];
  for (let i = 0; i < room.seats.length; i++) {
    if (teamOf(i) === myTeam && room.seats[i] && room.seats[i].hand.length > 0) withCards.push(i);
  }
  // For an unknown card, guess a teammate publicly seen collecting this set
  // (has asked in it → holds a base card), else any teammate with cards.
  const inSetMates = withCards.filter(m => m !== seat && room.knowledge.inSet[m] && room.knowledge.inSet[m].has(best));
  const guessMate = inSetMates.length ? inSetMates[0] : (withCards.length ? withCards[0] : seat);
  const assignments = {};
  for (const c of halfSuitCards(best, mode)) {
    if (hand.includes(c)) { assignments[c] = seat; continue; }
    const kh = knownHolder(room, c);
    if (kh >= 0 && teamOf(kh) === myTeam) { assignments[c] = kh; continue; }
    assignments[c] = guessMate;
  }
  return { hsId: best, assignments };
}

function autoDeclareWith(room, seat, hsId, assignments) {
  beginDeclaration(room, seat, hsId);
  resolveDeclaration(room, seat, hsId, assignments);
}

// Non-cheating ask chooser, shared by bots and human turn-timeouts.
function chooseAsk(room, seat, useMemory) {
  const mode = room.config.mode;
  const hand = room.seats[seat].hand;
  const myTeam = teamOf(seat);
  const opponents = [];
  for (let i = 0; i < room.seats.length; i++) {
    if (teamOf(i) !== myTeam && room.seats[i] && room.seats[i].hand.length > 0) opponents.push(i);
  }
  if (!opponents.length) return null;

  // Sets I have a base card in.
  const mySets = new Set(hand.map(cardHalfSuit));
  // Candidate cards: in one of my sets, not in my hand.
  const candidates = [];
  for (const hs of mySets) {
    for (const c of halfSuitCards(hs, mode)) {
      if (!hand.includes(c)) candidates.push(c);
    }
  }
  if (!candidates.length) return null;

  // Prefer a card we know a specific opponent holds.
  if (useMemory) {
    for (const c of candidates) {
      for (const opp of opponents) {
        if (room.knowledge.has[opp] && room.knowledge.has[opp].has(c)) return { targetSeat: opp, cardId: c };
      }
    }
  }
  // Otherwise ask a random opponent for a candidate they aren't known to lack.
  shuffleInPlace(candidates);
  const oppOrder = opponents.slice(); shuffleInPlace(oppOrder);
  for (const c of candidates) {
    for (const opp of oppOrder) {
      if (useMemory && room.knowledge.lacks[opp] && room.knowledge.lacks[opp].has(c)) continue;
      return { targetSeat: opp, cardId: c };
    }
  }
  // Fallback: any valid combination.
  for (const c of candidates) return { targetSeat: oppOrder[0], cardId: c };
  return null;
}

function shuffleInPlace(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
}

// ---------------------------------------------------------------------------
// Reconnect & disconnect
// ---------------------------------------------------------------------------
function handleReconnect(ws, msg) {
  const code = typeof msg.code === 'string' ? msg.code.toUpperCase().trim() : '';
  const token = typeof msg.token === 'string' ? msg.token : '';
  const room = rooms.get(code);
  if (!room) { sendError(ws, 'NOT_FOUND', 'Game no longer exists.'); return; }
  let seat = -1;
  for (let i = 0; i < room.seats.length; i++) {
    if (room.seats[i] && room.seats[i].token === token) { seat = i; break; }
  }
  if (seat < 0) { sendError(ws, 'BAD_TOKEN', 'Invalid reconnect token.'); return; }
  const s = room.seats[seat];
  if (s.socket && s.socket !== ws) { try { s.socket.close(4001, 'replaced'); } catch (_) {} }
  s.socket = ws;
  s.connected = true;
  sockets.set(ws, { code, seat, token });
  if (room.disconnectTimers[seat]) { clearTimeout(room.disconnectTimers[seat]); room.disconnectTimers[seat] = null; }
  if (room.finishedExpiryHandle) { clearTimeout(room.finishedExpiryHandle); room.finishedExpiryHandle = null; }
  send(ws, { type: 'created', code, token, seat });
  send(ws, publicStateMsg(room));
  send(ws, privateStateMsg(room, seat));
  broadcast(room, publicStateMsg(room));
}

function handleClose(ws) {
  const meta = sockets.get(ws); if (!meta) return;
  const room = rooms.get(meta.code);
  sockets.delete(ws);
  if (!room) return;
  const seat = room.seats[meta.seat];
  if (!seat || seat.socket !== ws) return; // stale (replaced by reconnect)
  seat.socket = null;
  seat.connected = false;

  if (room.status === 'lobby') {
    // Free the seat; reassign host or close empty room.
    room.seats[meta.seat] = null;
    const anyHuman = room.seats.some(s => s && !s.isBot && s.connected);
    if (!anyHuman) { cleanupRoom(room); return; }
    reassignHostIfNeeded(room);
    sendStates(room);
    return;
  }

  if (room.status === 'finished') {
    const anyHuman = room.seats.some(s => s && !s.isBot && s.connected);
    if (!anyHuman) deferCleanup(room);
    else broadcast(room, publicStateMsg(room));
    return;
  }

  // Playing: keep the seat & hand. A bot covers their turns until they return.
  broadcast(room, { type: 'playerDisconnected', seat: meta.seat });
  broadcast(room, publicStateMsg(room));
  scheduleBotIfNeeded(room);
  const anyHuman = room.seats.some(s => s && !s.isBot && s.connected);
  if (!anyHuman) deferCleanup(room);
}

function cleanupRoom(room) {
  clearTimer(room, 'decl'); clearTimer(room, 'pause');
  for (const k in room.botTimers) if (room.botTimers[k]) clearTimeout(room.botTimers[k]);
  for (const k in room.disconnectTimers) if (room.disconnectTimers[k]) clearTimeout(room.disconnectTimers[k]);
  rooms.delete(room.code);
}
function deferCleanup(room) {
  if (room.finishedExpiryHandle) clearTimeout(room.finishedExpiryHandle);
  room.finishedExpiryHandle = setTimeout(() => {
    const anyHuman = room.seats.some(s => s && !s.isBot && s.connected);
    if (!anyHuman) cleanupRoom(room);
  }, ROOM_GC_MS);
}

// ---------------------------------------------------------------------------
// Test-only hook (inert unless FISH_TEST=1). Lets headless tests overwrite the
// live position deterministically so hard-to-reach paths (e.g. the endgame
// chooseFinalDeclarer) can be forced instead of waited-for. Never enabled in a
// normal deploy.
// ---------------------------------------------------------------------------
function handleTestSetup(ws, msg) {
  if (process.env.FISH_TEST !== '1') { sendError(ws, 'NO_TEST', 'Test hook disabled.'); return; }
  const meta = sockets.get(ws); if (!meta) return;
  const room = rooms.get(meta.code); if (!room) return;
  clearTimer(room, 'turn'); clearTimer(room, 'decl'); clearTimer(room, 'pause');
  for (const k in room.botTimers) { if (room.botTimers[k]) clearTimeout(room.botTimers[k]); }
  room.botTimers = {};
  room.status = 'playing';
  const hands = Array.isArray(msg.hands) ? msg.hands : [];
  for (let i = 0; i < room.seats.length; i++) {
    if (room.seats[i]) room.seats[i].hand = sortHand((hands[i] || []).slice());
  }
  room.claimed = { 0: (msg.claimed && msg.claimed[0]) || [], 1: (msg.claimed && msg.claimed[1]) || [] };
  room.declaration = null; room.pause = null; room.pendingPass = null; room.pendingFinalChooser = null;
  room.lastQuestion = null; room.winner = null;
  room.knowledge = freshKnowledge();
  if (typeof msg.turnSeat === 'number') room.turnSeat = msg.turnSeat;
  room.endgame = (teamCardTotal(room, 0) === 0 || teamCardTotal(room, 1) === 0);
  send(ws, { type: 'testReady' });
  sendStates(room);
  scheduleBotIfNeeded(room);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
const HANDLERS = {
  __test_setup: handleTestSetup,
  create: handleCreate,
  join: handleJoin,
  reconnect: handleReconnect,
  swapSeats: handleSwapSeats,
  addBot: handleAddBot,
  removeBot: handleRemoveBot,
  startGame: handleStartGame,
  ask: handleAsk,
  declareStart: handleDeclareStart,
  declareSubmit: handleDeclareSubmit,
  declareCancel: handleDeclareCancel,
  passTurn: handlePassTurn,
  chooseFinalDeclarer: handleChooseFinalDeclarer,
  pause: handlePause,
  resume: handleResume,
};

// ---------------------------------------------------------------------------
// HTTP + WS
// ---------------------------------------------------------------------------
const FISH_HTML = path.join(__dirname, 'fish.html');

const httpServer = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  // Serve the single-page app at / (and any non-API path).
  fs.readFile(FISH_HTML, (err, data) => {
    if (err) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Fish server running. Open fish.html in your browser.');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { sendError(ws, 'BAD_JSON', 'Malformed message.'); return; }
    const handler = HANDLERS[msg && msg.cmd];
    if (!handler) { sendError(ws, 'BAD_CMD', 'Unknown command: ' + (msg && msg.cmd)); return; }
    try { handler(ws, msg); }
    catch (e) { console.error('handler error', msg && msg.cmd, e); sendError(ws, 'INTERNAL', 'Server error.'); }
  });
  ws.on('close', () => handleClose(ws));
  ws.on('error', () => {});
});

// GC stale lobby rooms.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.status === 'lobby' && now - room.createdAt > ROOM_GC_MS) {
      const anyHuman = room.seats.some(s => s && !s.isBot && s.connected);
      if (!anyHuman) cleanupRoom(room);
    }
  }
}, 60000);

httpServer.listen(PORT, () => console.log('Fish server listening on :' + PORT));
