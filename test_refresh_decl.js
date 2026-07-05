'use strict';
// Multi-human refresh-mid-declaration recovery.
// Two real WS clients (A = host/seat 0, B = seat 1) plus 4 bots. A opens a
// declaration, then "refreshes" (closes its socket and reconnects with its
// token) WHILE the declaration is still open. Asserts:
//   1. The other human (B) sees the in-progress declaration.
//   2. After A reconnects, the server still reports the same open declaration
//      (declarer + half-suit survive the refresh; nothing auto-cancels it).
//   3. A can finish the declaration on the reconnected socket and it resolves
//      (declarationResult broadcast, declaration state clears).
// No FISH_TEST hook needed — this is pure protocol/reconnect behaviour.
const WebSocket = require('ws');
const URL = 'ws://localhost:8080';

const log = (...a) => console.log('[refresh]', ...a);
let pass = true;
function check(cond, label) { log((cond ? 'PASS' : 'FAIL') + ': ' + label); if (!cond) pass = false; }

const LOW = ['2', '3', '4', '5', '6', '7'], HIGH = ['9', '10', 'J', 'Q', 'K', 'A'];
function setCards(h) { if (h === 'EIGHTS') return ['S8', 'H8', 'D8', 'C8', 'JR', 'JB']; const s = h[0]; const ranks = h.endsWith('_LOW') ? LOW : HIGH; return ranks.map(r => s + r); }

// ---- Host A ----
let codeA = null, tokenA = null, seatA = null, handA = [], pubA = null;
let aStarted = false, declStarted = false, refreshed = false, targetSet = null;
// ---- Player B ----
let seatB = null, bSawDeclaration = false;

const A = new WebSocket(URL);
A.on('open', () => sendTo(A, { cmd: 'create', name: 'Alice', playerCount: 6, teamMode: 'manual', turnTimerSec: 0 }));
A.on('message', raw => { let m; try { m = JSON.parse(raw); } catch (_) { return; } onA(m); });
A.on('error', e => log('A WS error', e.message));

function sendTo(ws, o) { ws.send(JSON.stringify(o)); }

let B = null;
function onA(m) {
  switch (m.type) {
    case 'created': codeA = m.code; tokenA = m.token; seatA = m.seat; joinB(); break;
    case 'privateState': if (m.seat === seatA) { handA = m.hand; onAState(); } break;
    case 'publicState': pubA = m; onAState(); break;
    case 'error': log('A error', m.code, m.msg); break;
  }
}

let bJoined = false;
function joinB() {
  if (bJoined) return; bJoined = true;
  B = new WebSocket(URL);
  B.on('open', () => sendTo(B, { cmd: 'join', name: 'Bob', code: codeA }));
  B.on('message', raw => { let m; try { m = JSON.parse(raw); } catch (_) { return; } onB(m); });
  B.on('error', e => log('B WS error', e.message));
}

function onB(m) {
  if (m.type === 'created') seatB = m.seat;
  else if (m.type === 'publicState') {
    // Record that B observes A's in-progress declaration.
    if (m.declaration && m.declaration.declarerSeat === seatA) bSawDeclaration = true;
  }
}

let botsAdded = false;
function onAState() {
  if (!pubA) return;
  if (pubA.status === 'lobby') {
    // Once B has taken seat 1, fill the rest with bots and start.
    const humans = pubA.seats.filter(s => !s.empty && !s.isBot).length;
    if (humans >= 2 && !botsAdded) {
      botsAdded = true;
      for (let i = 0; i < 4; i++) sendTo(A, { cmd: 'addBot' });
      setTimeout(() => sendTo(A, { cmd: 'startGame' }), 300);
    }
    return;
  }
  if (pubA.status !== 'playing') return;

  // Step 1: A opens a declaration on any unclaimed set (declare-any-time rule).
  if (!declStarted && handA.length > 0) {
    const unclaimed = pubA.halfSuits.filter(h => !pubA.claimed[0].includes(h) && !pubA.claimed[1].includes(h));
    targetSet = unclaimed[0];
    declStarted = true;
    log('A opens declaration on ' + targetSet + ' then will refresh mid-declaration');
    sendTo(A, { cmd: 'declareStart', hsId: targetSet });
    return;
  }

  // Step 2: once the declaration is live, A refreshes (disconnect + reconnect).
  if (declStarted && !refreshed && pubA.declaration && pubA.declaration.declarerSeat === seatA) {
    refreshed = true;
    setTimeout(() => {
      check(bSawDeclaration, 'other human (B) sees the in-progress declaration');
      log('A closing socket mid-declaration, then reconnecting…');
      try { A.close(); } catch (_) {}
      doReconnect();
    }, 150);
  }
}

function doReconnect() {
  const A2 = new WebSocket(URL);
  let a2Seat = null, asserted = false, submitted = false, resolved = false;
  A2.on('open', () => sendTo(A2, { cmd: 'reconnect', code: codeA, token: tokenA }));
  A2.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (_) { return; }
    if (m.type === 'created') a2Seat = m.seat;
    else if (m.type === 'privateState' && m.seat === a2Seat) handA = m.hand;
    else if (m.type === 'publicState') {
      if (!asserted && m.declaration) {
        asserted = true;
        check(a2Seat === seatA, 'reconnect restores same seat (' + a2Seat + '===' + seatA + ')');
        check(m.declaration.declarerSeat === seatA, 'declaration survives refresh — still declarer seat ' + seatA);
        check(m.declaration.hsId === targetSet, 'declaration survives refresh — still ' + targetSet);
        // Step 3: finish the declaration on the reconnected socket.
        submitted = true;
        const assignments = {};
        setCards(targetSet).forEach(c => { assignments[c] = seatA; }); // deliberately all-to-self
        setTimeout(() => sendTo(A2, { cmd: 'declareSubmit', assignments }), 60);
      } else if (submitted && resolved && !m.declaration) {
        check(true, 'declaration state cleared after resolution');
        finish();
      }
    } else if (m.type === 'declarationResult' && m.hsId === targetSet) {
      resolved = true;
      check(true, 'reconnected client resolved the declaration (' + targetSet + ', success=' + m.success + ')');
    }
  });
  A2.on('error', e => log('A2 WS error', e.message));
}

function finish() {
  log(pass ? '=== REFRESH-MID-DECLARATION TEST PASSED ===' : '=== REFRESH-MID-DECLARATION TEST FAILED ===');
  setTimeout(() => process.exit(pass ? 0 : 1), 150);
}
setTimeout(() => { check(false, 'TIMEOUT'); finish(); }, 20000);
