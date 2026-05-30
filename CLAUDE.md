# Fish (Literature) — Online Multiplayer

An online, browser-based implementation of the partnership card game **Fish**
(a.k.a. Literature). A single authoritative Node.js WebSocket server holds all
hidden state; a single-file HTML SPA is the client. Supports 6- and 8-player
games, server-side AI bots, token-based reconnect, and animated play.

## Run locally

```
npm install
node server.js        # listens on :8080, also serves fish.html at /
```

Open http://localhost:8080 — the page picks its WS URL from `location`
(`ws://`/`wss://`) with a `localhost:8080` fallback.

## Architecture

Two files do all the work:

| File | Role |
|---|---|
| `server.js` | Authoritative game engine + room manager + bots + HTTP/WS server. |
| `fish.html` | Entire web app (embedded CSS + JS): UI, WS client, animations, audio. |

**The server is the sole authority.** Because Fish is a hidden-information
game, the server holds every player's hand secretly and validates every action.
Each client receives only its **own** hand (`privateState`) plus **public**
information (`publicState`). Card *counts* are public (they are derivable from
public ask/declare history anyway); card *identities* never leave the server
except to their owner. Clients send intents; the server validates against live
state and rejects stale/illegal ones with `error`. Clients never run the engine
and never diverge optimistically — they reconcile from the next `publicState`.

### Deck & half-suits
- **6 players**: full 54-card deck (incl. 2 jokers), 9 cards each, **9 half-suits**.
- **8 players**: 48-card deck (four 8s + both jokers removed), 6 cards each, **8 half-suits**.
- Card ids: `"S2"`, `"H10"`, `"CA"`, jokers `"JR"`/`"JB"`.
- Half-suit ids: `{S,H,D,C}` × `{_LOW (2–7), _HIGH (9–A)}`, plus `"EIGHTS"`
  (four 8s + 2 jokers), the eights set existing only in 6-player mode.

### Teams & seating
- `team = seatIndex % 2` (alternating seating, enforced server-side).
- Host picks **random** (balanced auto-assign) or **manual** (`setTeam` in lobby).

## State model

Rooms live in an in-memory `Map` keyed by 4-char room code. A `sockets`
WeakMap maps each live `ws` → `{ code, seat, token }`. Reconnect is by
`{ code, token }`. State is lost on server restart (acceptable for v1, same as
the sibling Chess project).

```
room = {
  code, status: 'lobby'|'playing'|'finished',
  config: { playerCount, teamMode, mode:'6'|'8', turnTimerSec|null, declTimerSec },
  seats: [ { seat, name, token, socket, team, isBot, connected, hand:[ids] } ], // hand SECRET
  hostSeat, turnSeat,
  lastQuestion, claimed:{0:[hsId],1:[hsId]},
  declaration | null, pause | null,
  turnDeadlineAt | null, ...timers
}
```

## Wire protocol (JSON over WS, keyed on `cmd` / `type`)

Dispatched through the `HANDLERS` table in `server.js`.

**Client → Server (`cmd`)**: `create`, `join`, `reconnect`, `setTeam`,
`addBot`, `removeBot`, `startGame`, `ask`, `declareStart`, `declareSubmit`,
`declareCancel`, `passTurn`, `pause`, `resume`.

**Server → Client (`type`)**: `created` (code/token/**seat**), `publicState`,
`privateState` (own hand), `dealt`, `askResult`, `declarationResult` (full
reveal for animation), `gameOver`, `playerDisconnected`, `error`.

> Note: on deal, seats may be reshuffled (random teams), so the server re-sends
> `created` with each connected player's **current** seat *before* broadcasting
> state — otherwise the client would keep a stale seat and ignore its own
> `privateState`.

## Rules in effect (per spec)

- **Ask** `{targetSeat, cardId}`: valid only if target is on the other team and
  has ≥1 card, the asker holds another card in that half-suit, and the asker
  does **not** already hold the asked card. Got → transfer, asker keeps turn;
  denied → turn passes to target.
- **Declare** at any time (your turn or not). Play pauses; after resolution the
  pre-declaration turn resumes. **Any** error — including correct cards but
  wrong attribution, or any card held by an opponent — awards the half-suit to
  the **opposing** team.
- A **cardless** player may still declare for their team and cannot be asked or
  receive the turn.
- **Endgame**: when one team is out of cards, the other team declares out all
  remaining half-suits (any member); on declaration-timer expiry a turn-based
  fallback forces a declarer.

### Timers (sent as absolute `deadlineAt` ms; clients render drift-free)
- `DECL_MS = 120000` — 2-minute declaration limit.
- `PAUSE_MS = 60000` — Wait/Stop auto-resume cap (anti-abuse).
- `BOT_DELAY_MS = 1400` — bot "think" delay before acting.
- `DISCONNECT_BOT_MS = 8000` — grace before a bot covers a disconnected
  player's turn so the game never stalls.
- Optional host-configurable turn timer: on expiry the server plays a random
  *valid* question for the turn-holder.

## Bots

Server-side. Track public history + own hand. On their turn they pull
opponent-held cards into half-suits their team is consolidating
(`botConsolidationAsk`, keeping the turn on success), then declare any set their
whole team has consolidated (`autoDeclareTrue`). Also auto-act for a
disconnected human past the grace window.

## Deployment

- **Server** → Render (`render.yaml`): node web service, `npm install` /
  `node server.js`, health check `/healthz`. Serves `fish.html` at `/`, so a
  single Render target is a complete deploy on its own.
- **Static page** → Vercel (`vercel.json` + `index.html` redirect to
  `fish.html`). `.vercelignore` excludes server-only files.

## Tests

Headless Node WS harnesses (run against a local `node server.js`):

```
node test_harness.js 6   # full 6p game loop, asserts all 9 sets accounted for
node test_harness.js 8   # full 8p game loop, asserts all 8 sets accounted for
node test_edge.js        # reconnect restores seat+hand; wrong declaration → opponents
```

`test_harness.js` is excluded from the Vercel deploy.
