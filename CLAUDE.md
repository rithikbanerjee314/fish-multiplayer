# Fish (Literature) — Online Multiplayer

An online, browser-based implementation of the partnership card game **Fish**
(a.k.a. Literature). A single authoritative Node.js WebSocket server holds all
hidden state; a single-file HTML SPA is the client. **6-player only**, with
server-side AI bots, token-based reconnect, and animated play.

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
- **6 players** (the only mode): full 54-card deck (incl. 2 jokers), 9 cards
  each, **9 half-suits**. `PLAYER_COUNT` is fixed at 6 server-side; there is no
  player-count choice.
- Card ids: `"S2"`, `"H10"`, `"CA"`, jokers `"JR"`/`"JB"`.
- Half-suit ids: `{S,H,D,C}` × `{_LOW (2–7), _HIGH (9–A)}`, plus `"EIGHTS"`
  (four 8s + 2 jokers).

### Teams & seating
- `team = seatIndex % 2` (alternating seating, enforced server-side).
- There is no random-assign option. **Only the host** arranges teams, by
  swapping two seats (`swapSeats` in lobby). The host can never move their own
  seat (their team is fixed) and can swap any two *other* seats — including
  swapping two joined players or moving a player into an open seat on the
  other team. Non-hosts cannot change anyone's team.

## State model

Rooms live in an in-memory `Map` keyed by 4-char room code. A `sockets`
WeakMap maps each live `ws` → `{ code, seat, token }`. Reconnect is by
`{ code, token }`. State is lost on server restart (acceptable for v1, same as
the sibling Chess project).

```
room = {
  code, status: 'lobby'|'playing'|'finished',
  config: { playerCount:6, teamMode, mode:'6', declMs },
  seats: [ { seat, name, token, socket, team, isBot, connected, hand:[ids] } ], // hand SECRET
  hostSeat, turnSeat,
  lastQuestion, claimed:{0:[hsId],1:[hsId]},
  declaration | null, pause | null, pendingPass | null, pendingFinalChooser | null,
  ...timers (decl safety cap + pause cap only; no per-turn timer)
}
```

## Wire protocol (JSON over WS, keyed on `cmd` / `type`)

Dispatched through the `HANDLERS` table in `server.js`.

**Client → Server (`cmd`)**: `create`, `join`, `reconnect`, `swapSeats`,
`addBot`, `removeBot`, `startGame`, `ask`, `declareStart`, `declareSubmit`,
`declareCancel`, `passTurn`, `chooseFinalDeclarer`, `pause`, `resume`.

**Server → Client (`type`)**: `created` (code/token/**seat**), `publicState`,
`privateState` (own hand), `dealt`, `askResult`, `declarationResult` (full
reveal for animation), `gameOver`, `playerDisconnected`, `error`.

> Note: the host may swap seats in the lobby right up until start, so on deal
> the server re-sends `created` with each connected player's **current** seat
> *before* broadcasting state — otherwise the client would keep a stale seat
> and ignore its own `privateState`.

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
  remaining half-suits (any member). If the turn comes to rest on the now-empty
  team (its last holder was emptied by a declaration), the server enters a
  `pendingFinalChooser` state: that seat must `chooseFinalDeclarer {toSeat}` to
  hand the turn to an opponent who still holds cards, so the card-holding team
  can declare the rest. Bots/disconnected choosers auto-pick. This prevents the
  turn from stalling on a cardless seat with sets still unclaimed.

### Timers
There is **no player-facing timer** — turns are never timed and no countdown is
shown. The only timers are invisible server-side safety caps:
- `DECL_MS = 120000` — an abandoned declaration auto-cancels after 2 min so it
  can't hang the table (no on-screen countdown).
- `PAUSE_MS = 60000` — Wait/Stop auto-resume cap (anti-abuse).
- `BOT_DELAY_MS = 5000` — bot "think" delay before acting (5 s so humans can
  follow along). Override with the env var (e.g. `BOT_DELAY_MS=30`) to run the
  headless tests fast.
- `DISCONNECT_BOT_MS = 8000` — grace before a bot covers a disconnected
  player's turn so the game never stalls.

## Bots

Server-side, and they **only ever see their own hand plus public history** —
never any hidden hand. Public knowledge (`room.knowledge`) mirrors exactly what
an attentive player deduces from witnessed asks/declarations. On their turn a
bot: (1) declares a set it is **certain** of — every card either in its own hand
or publicly seen to land with a specific teammate (`findConfidentSet`, always an
exact call); else (2) asks (`chooseAsk` — a card it lacks in one of its sets,
preferring one an opponent was seen to hold, avoiding opponents shown to lack
it); else (3) when no legal ask remains (the endgame, opponents out of cards) it
must declare to finish, deducing what it can and **guessing** the rest
(`chooseGuessDeclare`) — sometimes wrong, like a real forced call. Bots also
auto-act for a disconnected human past the grace window, and auto-pick a final
declarer / teammate pass when it lands on them.

## Deployment

- **Server** → Render (`render.yaml`): node web service, `npm install` /
  `node server.js`, health check `/healthz`. Serves `fish.html` at `/`, so a
  single Render target is a complete deploy on its own.
- **Static page** → Vercel (`vercel.json` + `index.html` redirect to
  `fish.html`). `.vercelignore` excludes server-only files.

## Tests

Headless Node WS harnesses (run against a local server). Bots now think for 5 s
and never cheat, so start the server with a small bot delay (and the test hook)
so full-game harnesses finish quickly:

```
FISH_TEST=1 BOT_DELAY_MS=30 node server.js
```

Then, in another shell:

```
node test_harness.js        # full 6p game loop, asserts all 9 sets accounted for
node test_edge.js           # reconnect restores seat+hand; wrong declaration → opponents
node test_refresh_decl.js   # two humans: refresh mid-declaration recovers & resolves
node test_final_declarer.js # forces a whole-team-out endgame; asserts the
                            # pendingFinalChooser → chooseFinalDeclarer path
```

`test_final_declarer.js` needs the `FISH_TEST=1` hook (`__test_setup`, inert
otherwise). The `test_*.js` harnesses (and the `FISH_TEST` hook, which is off in
prod) are excluded from the Vercel deploy.
