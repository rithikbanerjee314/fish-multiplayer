'use strict';
// Forces the endgame chooseFinalDeclarer path with a rigged position (via the
// server's FISH_TEST hook) and asserts:
//   1. When a whole team is emptied by a correct declaration and the turn rests
//      on that (now cardless) team, the server enters pendingFinalChooser on
//      that seat.
//   2. A chooseFinalDeclarer to an illegal target (teammate / cardless) is
//      rejected.
//   3. A valid chooseFinalDeclarer hands the turn to a card-holding opponent,
//      whose team then declares the remaining set and the game reaches gameOver
//      with every half-suit accounted for.
//
// REQUIRES the server be started with FISH_TEST=1 (see run note at bottom).
const WebSocket = require('ws');
const URL = 'ws://localhost:8080';

const log = (...a) => console.log('[final]', ...a);
let pass = true;
function check(cond, label) { log((cond ? 'PASS' : 'FAIL') + ': ' + label); if (!cond) pass = false; }

// Rigged 6-player position (teams are never shuffled; host stays seat 0).
// Team 0 = seats 0,2,4 hold all of S_LOW; team 1 = seats 1,3,5 hold all of H_LOW.
// Seven other sets are pre-claimed by team 0. Turn starts on seat 0 (a human).
const HANDS = [
  ['S2', 'S3'], // seat 0 (t0)  — the scripted client
  ['H2', 'H3'], // seat 1 (t1)
  ['S4', 'S5'], // seat 2 (t0)
  ['H4', 'H5'], // seat 3 (t1)
  ['S6', 'S7'], // seat 4 (t0)
  ['H6', 'H7'], // seat 5 (t1)
];
const CLAIMED0 = ['S_HIGH', 'H_HIGH', 'D_LOW', 'D_HIGH', 'C_LOW', 'C_HIGH', 'EIGHTS'];
const S_LOW_ASSIGN = { S2: 0, S3: 0, S4: 2, S5: 2, S6: 4, S7: 4 };

let code = null, token = null, seat = null, hand = [], pub = null;
let phase = 'lobby'; // lobby → setup → declaring → choosing → done
// choose sub-state machine (onState fires on both publicState & privateState,
// so every send is guarded by a one-shot step transition):
//   need-bad → wait-bad → need-good → wait-good
let choiceStep = 'need-bad';
let botsAdded = false;
let turnAfterChoose = null;

const ws = new WebSocket(URL);
ws.on('open', () => send({ cmd: 'create', name: 'Host' }));
ws.on('message', raw => { let m; try { m = JSON.parse(raw); } catch (_) { return; } onMsg(m); });
ws.on('error', e => log('WS error', e.message));
function send(o) { ws.send(JSON.stringify(o)); }

function onMsg(m) {
  switch (m.type) {
    case 'created': code = m.code; token = m.token; seat = m.seat; if (!botsAdded) addBots(); break;
    case 'testReady': log('server applied rigged position'); break;
    case 'privateState': if (m.seat === seat) { hand = m.hand; onState(); } break;
    case 'publicState': pub = m; onState(); break;
    case 'declarationResult': onDecl(m); break;
    case 'gameOver': onGameOver(m); break;
    case 'error': onError(m); break;
  }
}

function addBots() {
  botsAdded = true;
  for (let i = 0; i < 5; i++) send({ cmd: 'addBot' });
  setTimeout(() => send({ cmd: 'startGame' }), 300);
}

function onState() {
  if (!pub || pub.status !== 'playing') return;
  if (phase === 'lobby') { // first playing state → rig the position
    phase = 'setup';
    send({ cmd: '__test_setup', hands: HANDS, claimed: { 0: CLAIMED0, 1: [] }, turnSeat: 0 });
    return;
  }
  if (phase === 'setup') {
    // Wait for the rigged state to land: my turn, 7 sets claimed, my forced hand.
    const claimedTotal = pub.claimed[0].length + pub.claimed[1].length;
    if (pub.turnSeat === seat && claimedTotal === 7 && hand.includes('S2') && hand.length === 2) {
      phase = 'declaring';
      log('declaring S_LOW (correct, empties my team)');
      send({ cmd: 'declareStart', hsId: 'S_LOW' });
      setTimeout(() => send({ cmd: 'declareSubmit', assignments: S_LOW_ASSIGN }), 60);
    }
    return;
  }
  if (phase === 'choosing') {
    // The declaration emptied team 0; the server should now be asking seat 0 to
    // choose which opponent declares the rest.
    const mineToChoose = pub.pendingFinalChooser && pub.pendingFinalChooser.seat === seat;
    if (choiceStep === 'need-bad' && mineToChoose) {
      check(true, 'pendingFinalChooser set on the emptied seat (seat ' + seat + ')');
      choiceStep = 'wait-bad';
      // 2) illegal choice: seat 2 is a teammate AND cardless → must be rejected.
      log('sending illegal chooseFinalDeclarer (teammate, cardless) — expect rejection');
      send({ cmd: 'chooseFinalDeclarer', toSeat: 2 });
      return;
    }
    if (choiceStep === 'need-good' && mineToChoose) {
      choiceStep = 'wait-good';
      // 3) legal choice: seat 1 is an opponent that still holds cards.
      log('choosing final declarer → seat 1 (opponent with cards)');
      send({ cmd: 'chooseFinalDeclarer', toSeat: 1 });
      return;
    }
    if (choiceStep === 'wait-good' && !pub.pendingFinalChooser && turnAfterChoose === null) {
      turnAfterChoose = pub.turnSeat;
      const t = pub.seats[pub.turnSeat];
      check(t && t.team === 1 && t.handCount > 0,
        'turn handed to a card-holding opponent (seat ' + pub.turnSeat + ', team ' + (t && t.team) + ', ' + (t && t.handCount) + ' cards)');
    }
  }
}

function onDecl(m) {
  if (m.hsId === 'S_LOW') {
    check(m.success === true, 'rigged S_LOW declaration resolves correct → team ' + m.winnerTeam);
    check(m.winnerTeam === 0, 'S_LOW awarded to declarer team 0');
    phase = 'choosing';
  }
}

function onError(m) {
  if (choiceStep === 'wait-bad' && m.code === 'BAD_CHOICE') {
    check(true, 'illegal chooseFinalDeclarer rejected (' + m.code + ')');
    choiceStep = 'need-good';
    // Re-trigger the choose branch off the current (still-pending) state.
    onState();
    return;
  }
  log('error', m.code, m.msg);
  if (m.code === 'NO_TEST') { check(false, 'server must run with FISH_TEST=1'); finish(); }
}

function onGameOver(m) {
  const total = m.score[0] + m.score[1];
  check(total === 9, 'all 9 half-suits accounted for at gameOver (' + total + '/9)');
  check(m.winner === 0, 'team 0 wins the rigged game (8–1), winner=' + m.winner);
  finish();
}

function finish() {
  log(pass ? '=== FINAL-DECLARER TEST PASSED ===' : '=== FINAL-DECLARER TEST FAILED ===');
  setTimeout(() => { try { ws.close(); } catch (_) {} process.exit(pass ? 0 : 1); }, 150);
}
setTimeout(() => { check(false, 'TIMEOUT — path did not complete'); finish(); }, 20000);
