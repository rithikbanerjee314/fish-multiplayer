'use strict';
// Focused edge-case tests:
//  A) Reconnect mid-game restores the player's seat + private hand (refresh path).
//  B) A deliberately WRONG declaration awards the half-suit to the OPPOSING team.
const WebSocket = require('ws');
const URL = 'ws://localhost:8080';
const LOW = ['2', '3', '4', '5', '6', '7'], HIGH = ['9', '10', 'J', 'Q', 'K', 'A'];
function cardHalf(c) { if (c === 'JR' || c === 'JB') return 'EIGHTS'; const r = c.slice(1); if (r === '8') return 'EIGHTS'; return c[0] + (LOW.includes(r) ? '_LOW' : '_HIGH'); }
function setCards(h) { if (h === 'EIGHTS') return ['S8', 'H8', 'D8', 'C8', 'JR', 'JB']; const s = h[0]; const ranks = h.endsWith('_LOW') ? LOW : HIGH; return ranks.map(r => s + r); }

const log = (...a) => console.log('[edge]', ...a);
let pass = true;
function check(cond, label) { log((cond ? 'PASS' : 'FAIL') + ': ' + label); if (!cond) pass = false; }

// Open one host socket, create a manual-team 6p room so seats DON'T shuffle
// (keeps the host at seat 0 — deterministic for the reconnect assertion).
let code = null, token = null, seat = null, hand = [], pub = null;
let phase = 'lobby';
const host = new WebSocket(URL);
host.on('open', () => send(host, { cmd: 'create', name: 'Host', playerCount: 6, teamMode: 'manual', turnTimerSec: 0 }));
host.on('message', raw => onHost(JSON.parse(raw)));
host.on('error', e => { log('host WS error', e.message); });

function send(ws, o) { ws.send(JSON.stringify(o)); }

let botsAdded = false;
function onHost(m) {
  if (m.type === 'created') { code = m.code; token = m.token; seat = m.seat; if (!botsAdded) addBots(); }
  else if (m.type === 'privateState') { if (m.seat === seat) { hand = m.hand; if (pub) onState(); } }
  else if (m.type === 'publicState') { pub = m; onState(); }
  else if (m.type === 'declarationResult') onDecl(m);
  else if (m.type === 'error') log('host error', m.code, m.msg);
}

function addBots() {
  botsAdded = true;
  for (let i = 0; i < 5; i++) send(host, { cmd: 'addBot' });
  setTimeout(() => send(host, { cmd: 'startGame' }), 300);
}

let didReconnectTest = false, didBadDecl = false, reconnecting = false;
function onState() {
  if (pub.status !== 'playing') return;
  // Wait until our private hand has actually arrived (publicState precedes
  // privateState on deal) so the pre-disconnect snapshot is meaningful.
  if (!didReconnectTest && !reconnecting && hand.length > 0) { runReconnectTest(); return; }
}

// ---- Test A: reconnect ----
function runReconnectTest() {
  reconnecting = true;
  const savedSeat = seat, savedHandLen = hand.length;
  log('reconnect test: closing socket, savedSeat=' + savedSeat + ' handLen=' + savedHandLen);
  // Open a NEW socket and reconnect with the token (simulates a page refresh).
  const rc = new WebSocket(URL);
  let rcSeat = null, rcHand = null;
  let rcAsserted = false;
  rc.on('open', () => send(rc, { cmd: 'reconnect', code, token }));
  rc.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.type === 'created') rcSeat = m.seat;
    else if (!rcAsserted && m.type === 'privateState' && m.seat === rcSeat) {
      rcAsserted = true;
      rcHand = m.hand;
      check(rcSeat === savedSeat, 'reconnect restores same seat (' + rcSeat + '===' + savedSeat + ')');
      check(rcHand && rcHand.length === savedHandLen, 'reconnect restores hand size (' + (rcHand && rcHand.length) + '===' + savedHandLen + ')');
      didReconnectTest = true;
      // hand off to the bad-declaration test on this reconnected socket
      setTimeout(() => runBadDeclTest(rc, rcSeat, rcHand), 200);
    }
  });
  rc.on('error', e => log('rc WS error', e.message));
  try { host.close(); } catch (_) {}
}

// ---- Test B: wrong declaration → opposing team ----
function runBadDeclTest(ws, mySeat, myHand) {
  if (didBadDecl) return;
  didBadDecl = true;
  // Find an unclaimed set, then submit assignments that are deliberately wrong:
  // assign every card to me regardless of who truly holds it. Unless I happen to
  // hold the entire set, this is an incorrect declaration and must go to the
  // opposing team (team = mySeat parity → opponents = 1 - that).
  const unclaimed = lastPub.halfSuits.filter(h => !lastPub.claimed[0].includes(h) && !lastPub.claimed[1].includes(h));
  // pick a set I do NOT fully hold, to guarantee the declaration is wrong
  let target = null;
  for (const h of unclaimed) { if (!setCards(h).every(c => myHand.includes(c))) { target = h; break; } }
  if (!target) { log('SKIP bad-decl: I hold every unclaimed set (rare)'); finish(); return; }
  const myTeam = mySeat % 2, oppTeam = 1 - myTeam;
  log('bad-decl: declaring ' + target + ' assigning ALL to self (seat ' + mySeat + ', team ' + myTeam + ')');
  expectBadDecl = { hsId: target, oppTeam };
  send(ws, { cmd: 'declareStart', hsId: target });
  const assignments = {};
  setCards(target).forEach(c => { assignments[c] = mySeat; });
  setTimeout(() => send(ws, { cmd: 'declareSubmit', assignments }), 150);
  // listen for declarationResult on this socket
  ws.on('message', raw => { const m = JSON.parse(raw); if (m.type === 'publicState') lastPub = m; if (m.type === 'declarationResult') onDecl(m); });
}

let lastPub = null, expectBadDecl = null;
function onState2() {}
function onDecl(m) {
  if (!expectBadDecl || m.hsId !== expectBadDecl.hsId) return;
  check(m.success === false, 'wrong declaration is marked unsuccessful');
  check(m.winnerTeam === expectBadDecl.oppTeam, 'wrong declaration awards opposing team (' + m.winnerTeam + '===' + expectBadDecl.oppTeam + ')');
  finish();
}

// keep lastPub fresh from host messages too (before reconnect)
const _onHost = onHost;
onHost = function (m) { if (m.type === 'publicState') lastPub = m; _onHost(m); };

function finish() {
  log(pass ? '=== ALL EDGE TESTS PASSED ===' : '=== EDGE TESTS FAILED ===');
  setTimeout(() => process.exit(pass ? 0 : 1), 150);
}
setTimeout(() => { log('TIMEOUT'); process.exit(3); }, 30000);
