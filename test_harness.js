'use strict';
// Headless protocol/game-loop test. Drives a full game with 1 scripted client
// + 5 server bots, then asserts the game reaches a valid gameOver.
const WebSocket = require('ws');

const URL = 'ws://localhost:8080';
const SUITS = ['S', 'H', 'D', 'C'];
const LOW = ['2', '3', '4', '5', '6', '7'], HIGH = ['9', '10', 'J', 'Q', 'K', 'A'];
function cardHalf(c) { if (c === 'JR' || c === 'JB') return 'EIGHTS'; const r = c.slice(1); if (r === '8') return 'EIGHTS'; return c[0] + (LOW.includes(r) ? '_LOW' : '_HIGH'); }
function setCards(h) { if (h === 'EIGHTS') return ['S8', 'H8', 'D8', 'C8', 'JR', 'JB']; const s = h[0]; const ranks = h.endsWith('_LOW') ? LOW : HIGH; return ranks.map(r => s + r); }

const MODE = 6; // Fish is 6-player only.
let seat = null, code = null, token = null, hand = [], pub = null;
let started = false, acting = false, gotGameOver = false;
const log = (...a) => console.log('[test]', ...a);
let actionCount = 0;
const MAX_ACTIONS = 2000;

const ws = new WebSocket(URL);
ws.on('open', () => {
  log('connected; creating ' + MODE + '-player room');
  send({ cmd: 'create', name: 'Tester', teamMode: 'random' });
});
ws.on('message', (raw) => { let m; try { m = JSON.parse(raw); } catch (_) { return; } onMsg(m); });
ws.on('close', () => log('socket closed'));
ws.on('error', (e) => { log('WS ERROR', e.message); });

function send(o) { ws.send(JSON.stringify(o)); }

function onMsg(m) {
  switch (m.type) {
    case 'created': seat = m.seat; code = m.code; token = m.token; afterCreated(); break;
    case 'publicState': pub = m; logState('PS'); maybeAct(); break;
    case 'privateState': if (m.seat === seat) { hand = m.hand; } break;
    case 'dealt': log('DEALT — dealer seat', m.dealerSeat); break;
    case 'askResult': log('ask', m.askerSeat, '->', m.targetSeat, m.cardId, m.got ? 'GOT' : 'no'); break;
    case 'declarationResult': log('DECLARE seat', m.declarerSeat, 'set', m.hsId, m.success ? 'OK' : 'MISS', '-> team', m.winnerTeam); break;
    case 'gameOver': onGameOver(m); break;
    case 'playerDisconnected': log('disconnect', m.seat); break;
    case 'error': log('ERROR', m.code, m.msg); break;
  }
}

let botsAdded = 0;
function afterCreated() {
  if (started) return;
  log('created room', code, 'seat', seat);
  // add bots to fill the table, then start
  const need = MODE - 1;
  for (let i = 0; i < need; i++) send({ cmd: 'addBot' });
  // start after bots register
  setTimeout(() => { started = true; log('starting game'); send({ cmd: 'startGame' }); }, 300);
}

function maybeAct() {
  if (!pub || pub.status !== 'playing') return;
  if (++actionCount > MAX_ACTIONS) { log('!! exceeded MAX_ACTIONS — likely stalled'); dump(); process.exit(2); }
  // pending pass to me?
  if (pub.pendingPass && pub.pendingPass.seat === seat) {
    const mate = pub.seats.find(s => s.team === seat % 2 && s.seat !== seat && s.handCount > 0);
    if (mate) { send({ cmd: 'passTurn', toSeat: mate.seat }); }
    return;
  }
  // endgame: my team is out — choose an opponent to declare the rest
  if (pub.pendingFinalChooser && pub.pendingFinalChooser.seat === seat) {
    const opp = pub.seats.find(s => s.team !== seat % 2 && s.handCount > 0);
    if (opp) { log('choosing final declarer', opp.seat); send({ cmd: 'chooseFinalDeclarer', toSeat: opp.seat }); }
    return;
  }
  if (pub.declaration || pub.pause || pub.pendingPass || pub.pendingFinalChooser) return;
  if (pub.turnSeat !== seat) return;
  // my turn — small delay to avoid tight loop
  setTimeout(doMyTurn, 30);
}

function doMyTurn() {
  if (!pub || pub.status !== 'playing' || pub.turnSeat !== seat || pub.declaration || pub.pendingPass) return;
  // 1) declare any complete set I hold
  const unclaimed = pub.halfSuits.filter(h => !pub.claimed[0].includes(h) && !pub.claimed[1].includes(h));
  for (const h of unclaimed) {
    if (setCards(h).every(c => hand.includes(c))) {
      log('I hold complete set', h, '-> declaring');
      declareComplete(h);
      return;
    }
  }
  // 2) otherwise ask a valid question
  const ask = chooseAsk();
  if (ask) { send({ cmd: 'ask', targetSeat: ask.target, cardId: ask.card }); return; }
  // 3) no valid ask (e.g. only have base cards I fully hold) — declare a set I have a card in (best effort)
  for (const h of unclaimed) {
    if (hand.some(c => cardHalf(c) === h)) { log('no ask available, declaring (best effort)', h); declareComplete(h); return; }
  }
  log('NO action available on my turn — possible stall'); dump();
}

function chooseAsk() {
  const myTeam = seat % 2;
  const opps = pub.seats.filter(s => s.team !== myTeam && s.handCount > 0).map(s => s.seat);
  if (!opps.length) return null;
  const mySets = new Set(hand.map(cardHalf));
  for (const h of mySets) {
    for (const c of setCards(h)) {
      if (!hand.includes(c)) {
        return { target: opps[Math.floor(Math.random() * opps.length)], card: c };
      }
    }
  }
  return null;
}

function declareComplete(h) {
  send({ cmd: 'declareStart', hsId: h });
  // build assignment from true knowledge of my own hand; cards I don't hold -> guess a teammate (best effort)
  const myTeam = seat % 2;
  const mates = pub.seats.filter(s => s.team === myTeam).map(s => s.seat);
  const assignments = {};
  for (const c of setCards(h)) {
    assignments[c] = hand.includes(c) ? seat : mates[0];
  }
  setTimeout(() => send({ cmd: 'declareSubmit', assignments }), 50);
}

function onGameOver(m) {
  gotGameOver = true;
  const total = m.score[0] + m.score[1];
  const expectedSets = MODE === 8 ? 8 : 9;
  log('=== GAME OVER ===');
  log('winner:', m.winner, 'score A:', m.score[0], 'B:', m.score[1], 'total sets:', total);
  const pass = total === expectedSets;
  log(pass ? 'PASS: all sets accounted for (' + total + '/' + expectedSets + ')'
    : 'FAIL: expected ' + expectedSets + ' sets, got ' + total);
  setTimeout(() => { try { ws.close(); } catch (_) {} process.exit(pass ? 0 : 1); }, 200);
}

let _lastTurn = -99;
function logState(tag) {
  if (!pub || pub.status !== 'playing') return;
  const key = pub.turnSeat + '|' + (pub.declaration ? 'D' : '') + (pub.pendingPass ? 'P' + pub.pendingPass.seat : '') + (pub.pause ? 'Z' : '');
  if (key !== _lastTurn) {
    log(tag, 'turn=' + pub.turnSeat, pub.declaration ? 'DECL' : '', pub.pendingPass ? 'PASS:' + pub.pendingPass.seat : '',
      'counts=' + pub.seats.map(s => s.handCount).join(','), 'claimed=' + (pub.claimed[0].length + pub.claimed[1].length));
    _lastTurn = key;
  }
}
function dump() {
  if (!pub) return;
  log('STATE turn=' + pub.turnSeat + ' endgame=' + pub.endgame + ' claimed=' + JSON.stringify(pub.claimed) +
    ' counts=' + pub.seats.map(s => s.handCount).join(','));
}

// Global timeout. Non-cheating bots play longer games, so run the server with a
// small BOT_DELAY_MS (e.g. BOT_DELAY_MS=30) when driving this harness.
setTimeout(() => { if (!gotGameOver) { log('!! TIMEOUT — no gameOver in time'); dump(); process.exit(3); } }, 180000);
