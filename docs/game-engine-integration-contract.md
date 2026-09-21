# PortalAPI ↔ Game-Engine Integration Contract (generic) — UNO as an instance

**Status:** Design only, no code written. This is the same finalized generic contract established during the Ludo engine's design (`ludo-engine/docs/game-engine-integration-contract.md`), carried over verbatim as the source of truth for this engine. It is written as a **generic contract** every standalone game engine (Ludo, UNO, Balloot, Chess, ...) follows — nothing here is UNO-specific except where called out explicitly. Do not fork this into a UNO-only contract; extend the shared one instead if a genuine UNO-specific requirement ever doesn't fit.

**Decisions baked in below** were made in review and are treated as final, not proposals:
1. Session tokens are short-lived, engine-minted, not a permanent credential.
2. Two directional API keys per engine (naming convention generalized below).
3. Tournament seat numbers: round-1 seats keep their existing `GameTournamentSeat.seatNumber`; reseeded rounds get fresh round-scoped seat numbers.
4. A failed session-create must move the match to a controlled failure state with cleanup — never left pending/active indefinitely.
5. The cross-engine result contract's only mandatory outcome field is `position`; everything else is optional `metadata`.
6. PortalAPI enforces a configurable result timeout; late results are rejected by state-check, not blindly applied.
7. `userId` is the mandatory primary identity the engine reports back, alongside `seatNumber`/`matchId`/`gameEngineSessionId`.
8. Reconnect is session-token-based; the engine owns gameplay-state restore, portalapi only tracks match lifecycle.
9. The frontend must stay game-agnostic — one shared Socket.IO event vocabulary for every game engine and for quick-chat, never a per-game event name.

Hard constraint, unchanged: the engine **never** touches portalapi's MongoDB directly. Every interaction crosses the boundary as an HTTP call, a webhook, or a socket event defined in this document.

---

## 1. Responsibility split (generic)

| Owns | PortalAPI | Game Engine |
|---|---|---|
| Users, wallets, coins, prizes, XP/ranking | ✅ | — |
| Tournament/Duel lifecycle, seats, registration, invites | ✅ | — |
| Deciding *when* a match starts, which players are in it | ✅ (calls engine) | — |
| Actual gameplay: rules, turns, moves, board/hand state, bots' moves, timers | — | ✅ |
| Real-time gameplay sync to clients | — | ✅ (own socket layer) |
| Orchestration-level realtime (seat updates, "your match is ready") | ✅ (portalapi's own socket, unchanged) | — |
| Final placement per player | — | ✅ (decides, reports as `position`) |
| Turning a reported result into round advancement / prize payout / ranking | ✅ | — |
| `gameTypeSlug`-specific rules | — | ✅ |

---

## 2. Session lifecycle (generic, both callers)

```
1. PortalAPI orchestrator (GameTournament.startRound / DuelLobby match-start) decides a match should begin.
2. PortalAPI calls the module's own sessionAdapter.js, which maps its native shape to the shared
   session-create payload (§3) and POSTs to the engine.
3a. Success → engine returns {gameEngineSessionId, sessionToken(s), expiresInSec}.
    PortalAPI persists gameEngineSessionId on its match doc, status → "active",
    emits the shared game:session-created lifecycle event (§5) to seated players (portalapi's own socket),
    each payload carrying that player's own sessionToken.
3b. Failure (non-2xx, timeout, network error) → match moves to a controlled failure state
    immediately (§6) — never left pending/active.
4. Client receives its sessionToken via portalapi's socket, connects DIRECTLY to the engine's own
   socket endpoint, authenticates with the sessionToken (§8), plays.
5. Engine posts the result webhook (§4) exactly once per match outcome; portalapi's resultProcessor
   validates gameEngineSessionId + timeout state before applying it (§7).
6. If the engine never calls back within the configured timeout, portalapi's own cron closes the
   match out in a controlled expired state (§7) — it does not wait indefinitely.
```

---

## 3. Session creation contract (portalapi → engine)

```
POST {ENGINE_BASE_URL}/sessions
Headers: X-API-Key: <PORTALAPI_TO_UNO_API_KEY>
Body:
{
  "source": "tournament" | "duel",
  "contextId": "<gameTournamentId or lobbyId>",
  "matchId": "<GameTournamentMatch._id or DuelLobbyMatch._id>",
  "gameTypeSlug": "uno",
  "players": [
    { "userId": "<ObjectId>", "seatNumber": 1, "isBot": false },
    { "userId": null,          "seatNumber": 2, "isBot": true, "botProfile": {"name":"Sara","gender":"female"} }
  ]
}
```
- `players` always carries `seatNumber` — for tournament round 1 this is the real `GameTournamentSeat.seatNumber`; for reseeded rounds ≥2, portalapi assigns fresh round-scoped seat numbers (1..N in table order) purely for this session — see §9.
- `isBot`/`botProfile` are always absent/false for tournament (no bot concept there); duel carries them as today.

**Response:**
```json
{
  "gameEngineSessionId": "uno_9f2a...",
  "playerTokens": {
    "<userId-1>": "ey....(short-lived JWT or opaque token, engine-signed)",
    "<userId-2>": null
  },
  "expiresInSec": 300
}
```
- `playerTokens` is keyed by `userId` so portalapi can hand each seated player *their own* token without the engine needing to know portalapi's per-user session/auth model. A bot seat gets `null` (no client ever needs it).
- `gameEngineSessionId` is the durable, opaque correlation id stored on the match doc forever. `playerTokens` values are **not** durable — never persisted beyond immediate delivery to the client, never logged, never reused after `expiresInSec` (decision #1).

---

## 4. Result webhook contract (engine → portalapi)

```
POST /game-tournament/:tournamentId/engine/report-result
POST /duel-lobby/:lobbyId/engine/report-result
Headers: X-API-Key: <UNO_TO_PORTALAPI_API_KEY>
Body:
{
  "matchId": "<required — the matchId handed out at session-create>",
  "gameEngineSessionId": "<required — must equal the stored value>",
  "results": [
    { "userId": "<ObjectId, or null for a bot>", "seatNumber": 1, "position": 1 },
    { "userId": "<ObjectId>",                    "seatNumber": 2, "position": 2 }
  ],
  "endedReason": "completed" | "forfeit_timeout" | "forfeit_disconnect" | "engine_error",
  "metadata": { }   // optional, game-specific, never read by resultProcessor logic
}
```
- **`position` is the only field the shared result processor consumes** (decision #5). Nothing else in `results[]` drives round advancement, qualification, or prize logic.
- UNO-specific extras (final hand sizes, cards drawn count, UNO-call penalties, per-player time-used, etc.) go in the top-level `metadata` object, stored as-is for analytics/support, never parsed by business logic — the shape inside it is entirely game-owned and portalapi never validates it.
- `endedReason` lets the engine explain a non-normal ending (disconnect forfeit, engine crash) without portalapi guessing from silence.
- Idempotency (decision #6): if `match.status` is no longer `active` (already `completed`, or already moved to `expired`/`session_failed` by the timeout cron), the webhook is **rejected** with a `409` carrying the current status — not silently ignored, not double-applied. The engine treats `409` as "already handled, stop retrying."

---

## 5. Common realtime event contract (frontend-facing) — no game-specific event names anywhere, either direction

**Rule, stated precisely:** there is no such thing as a `uno:play-card`, `uno:draw-card`, `uno:uno-call`, `ludo:roll-dice`, or `balloot:anything` Socket.IO event, in **either direction**. Every single thing a client sends to the engine, and everything the engine/portalapi sends back, goes out under one of the ten fixed event names in §5a. The *only* place UNO's vocabulary appears is inside the payload's `type` (and optional `kind`) fields — never in the event name the frontend's `socket.on(...)`/`socket.emit(...)` calls reference.

This applies to **both** transports in this system:
- **portalapi's existing socket** (`src/socket/index.js`) — used for orchestration-level events (`game:session-created`).
- **the engine's own socket server** (§8) — used for actual gameplay traffic once the client connects directly with its session token. The engine must implement the identical envelope and the identical fixed event names for its inbound listeners and outbound emits — not a parallel gameplay-specific protocol that only coincidentally shares field names.

### Envelope (every event, both directions, no exceptions)

```json
{
  "gameType": "uno",
  "type": "play_card",
  "kind": "wild_draw_four",
  "sessionId": "uno_9f2a...",
  "matchId": "<matchId>",
  "userId": "<ObjectId or null>",
  "data": { }
}
```
- `gameType`: the `gameTypeSlug` this session belongs to — always `"uno"` for this engine. This is what lets one event name mean different things per game without the frontend needing to know which game it is until it dispatches into that game's own render/logic module.
- `type`: the specific action or update this event carries — this is where UNO's vocabulary lives, e.g. `"play_card"`, `"draw_card"`, `"call_uno"`, `"challenge_uno"`, `"choose_color"`. Free-form per game, owned entirely by this engine — portalapi and the frontend's generic layer never validate or branch on specific `type` values, only pass them through to UNO's own game module.
- `kind`: optional finer sub-classification when a `type` itself has variants worth distinguishing without minting a new `type` (e.g. `type:"play_card", kind:"wild_draw_four"`). Omit when not needed.
- `sessionId` / `matchId`: always both present, both directions, so either side can correlate without game-specific knowledge.
- `userId`: the player who sent this event (inbound) or who it's about (outbound), or `null` for system-driven events (e.g. `game:started`, `game:error` with no single responsible player).
- `data`: the actual payload — which card, chosen color, whatever the specific `type` needs. The frontend's generic transport/dispatch layer never inspects `data`'s shape; only UNO's own UI module (selected by `gameType`) does.

### 5a. Fixed Socket.IO event names — the complete list, both directions, never extended per-game

| Event name | Direction | Fired when | Typical `type` values (UNO) |
|---|---|---|---|
| `game:session-created` | engine/portalapi → client | Session/match created, before players join — carries the player's own session token in `data.sessionToken` | — |
| `game:player-joined` | engine → client | A player (or bot) has taken their seat in the live session | — |
| `game:player-left` | engine → client | A player disconnected or explicitly left mid-session | `disconnected` \| `left` |
| `game:started` | engine → client | Engine begins actual gameplay (all required seats present) | — |
| `game:action` | **client → engine** | **The one and only event a client ever emits to perform a game-specific move.** | `play_card`, `draw_card`, `call_uno`, `challenge_uno`, `choose_color` |
| `game:state-updated` | engine → client | Authoritative state broadcast after an action is validated and applied (or on any server-driven state change with no single acting player, e.g. a turn timer expiring) | `card_played`, `card_drawn`, `color_chosen`, `uno_called`, `uno_challenged` |
| `game:turn-changed` | engine → client | Whose turn it is has changed | — (`data: {currentUserId, seatNumber, turnDeadlineAt}`) |
| `game:player-finished` | engine → client | One player has gone out (emptied their hand) before the whole match ends | — (`data: {position}`) |
| `game:completed` | engine → client | Match is fully over — mirrors §4's result for instant UI feedback, ahead of/alongside the webhook | — (`data: {results}`) |
| `game:error` | engine → client | An action was rejected, or a session-level error occurred | `invalid_action` \| `session_error` \| `timeout` |
| `game:quick-chat` | client → engine → other clients | A quick-chat phrase was sent (§5b) | always `"quick_chat"`, distinguished by `kind` |

This list is exhaustive by design, in **both** directions — UNO's entire inbound action vocabulary fits into `game:action`'s `type`/`kind`, and its entire outbound vocabulary into the remaining nine event names. This engine never adds a Socket.IO event name and never requires a frontend change beyond its own `gameType`-keyed render/logic module.

### 5b. Quick Chat — same envelope, one more fixed event, both directions

```json
{ "gameType": "uno", "type": "quick_chat", "kind": "good_luck", "sessionId": "...", "matchId": "...", "userId": "<sender>", "data": {} }
```
- Single fixed event name in both directions: **`game:quick-chat`** — a client emits it to send a phrase, the engine relays it (or portalapi relays it, for lobby-level chat before a session exists) to the other participant(s) under the identical event name and shape.
- `type` is always the literal `"quick_chat"` — the actual chat action is `kind`.
- `kind` is a small closed vocabulary shared across all games (e.g. `good_luck`, `nice_move`, `oops`, `thanks`, `hurry_up`, `gg`) — this engine never introduces a UNO-only chat event.
- `data` may carry a `text`/`emoji` override if the client allows picking a specific localized string for a `kind`, but routing/rendering keys off `kind`, not free text.

### 5c. Who emits what

- **Lifecycle events driven by portalapi's own orchestration** (`game:session-created` at minimum) are emitted from portalapi's existing socket, in the same generic envelope.
- **Everything from `game:player-joined` onward** is gameplay-time and is emitted by the engine's own socket server directly to connected clients, in the identical envelope shape — the engine is responsible for producing frontend-ready events, not a proprietary internal format that needs translation later.
- `game:completed`'s `data.results` is a convenience mirror for instant UI feedback; the webhook (§4) remains the only source of truth portalapi's business logic acts on. If they ever disagree, portalapi's state is authoritative — the engine must still retry the webhook until it succeeds or times out (§7), never treat the socket emission as "done."

---

## 6. Engine session-creation failure → controlled cleanup (decision #4)

```
try {
  session = await requestGameSession(...)
} catch (err) {
  match.status = "session_failed"       // new enum value, both match models
  match.cancelReason = "engine_error"
  await match.save()
  emitTournamentStatusChanged / emitStatusChanged(..., "session_failed", {reason:"engine_error"})
  notify affected players
}
```
Nothing is ever left in `pending`/`active` after a failed create — this is enforced at the single call site in each `sessionAdapter.js` caller, not scattered.

---

## 7. Timeout / stuck-match handling (decision #6)

- Config: `GAME_ENGINE_RESULT_TIMEOUT_MINUTES` (env, generic — not UNO-specific; a per-`gameTypeSlug` override is possible later via `GameType` config if this engine genuinely needs a different ceiling).
- A per-minute cron finds matches with `status: "active"` and `startedAt` older than the timeout, and sets `status: "expired"`, `cancelReason`/`endedReason: "engine_timeout"`, then runs the same downstream cleanup as §6.
- **Late webhook after expiry:** rejected with `409` (§4's idempotency rule) — the engine's result is not silently dropped from logs, but it never mutates portalapi state past that point.

---

## 8. Client authentication to the engine (session tokens, decision #1)

- Minted by the engine at session-create time, one per human seat, returned in `playerTokens` (§3).
- Delivered to the client exclusively via portalapi's `game:session-created` event (§5c) — the engine never needs portalapi's JWT secret, and portalapi never needs the engine's token-signing secret.
- Short-lived (`expiresInSec`, default proposal 300s) and single-purpose: authenticates the client's connection to the engine's own socket for **this one `gameEngineSessionId` only** — never reusable across sessions, never treated as a login credential.
- Reconnect (decision #8): the same token (while still within its validity window, extended by the engine on active use rather than hard-cut) is presented again to reconnect; the engine restores gameplay state on its own, portalapi is not called unless the engine's grace period lapses into an actual forfeit (surfaced through the result webhook's `endedReason`/`position`, or a `game:player-left` event for immediate UI feedback).

---

## 9. Player / seat identity mapping (decisions #3 and #7)

| Concept | Rule |
|---|---|
| Primary identity engine reports back | `userId` — **mandatory** for every non-bot seat in every result payload (decision #7). |
| Secondary keys engine must also track/report | `seatNumber`, `matchId`, `gameEngineSessionId` — all three, always, so portalapi can correlate without depending on array order. |
| Engine's own internal player id | Allowed to exist purely inside the engine — never required or read by portalapi; `userId` mapping is mandatory regardless of what the engine calls a player internally. |
| Tournament round-1 seat numbers | Taken as-is from `GameTournamentSeat.seatNumber` (existing field, existing behavior — untouched). |
| Tournament round ≥2 seat numbers | **Round-scoped.** After reseeding, each table's players get fresh seat numbers `1..N` in the order `buildReseededTables` placed them — these numbers exist only for that round's session-create payload and result correlation; they do not write back to `GameTournamentSeat`. |
| Duel seat numbers | Unchanged — native `DuelLobbySeat.seatNumber` already exists for the whole match. |
| Bot identity | `userId: null`, `isBot: true`, cosmetic `botProfile` only (duel-only; tournament has no bots). Engine still must report a `position` for the bot's seat in the result (with `userId: null`) so placement/prize logic stays consistent. |

---

## 10. API key architecture (decision #2, generalized for future engines)

Naming convention (not just for one engine — every engine follows the same pattern):

- **Outbound** (portalapi → engine, used when calling `POST {ENGINE_BASE_URL}/sessions`): `PORTALAPI_TO_UNO_API_KEY`. Read only by this engine's own `apiKeyClient.js` — never shared across engines.
- **Inbound** (engine → portalapi webhook): `UNO_TO_PORTALAPI_API_KEY`. This engine's webhook calls are authenticated against its own key, not a shared global set — portalapi's `apiKeyAuthFor("UNO_TO_PORTALAPI_API_KEY")` route factory validates it, with zero changes to any other engine's route.
- Both env vars live in portalapi's `.env`/deployment secrets; this engine only ever holds its own outbound-facing key (the one portalapi calls it with) and its own inbound key (the one it calls portalapi with) — it never sees another engine's keys, and portalapi never reuses this engine's key for another.

---

## 11. This project's folder structure

```
uno-engine/
├── src/
│   ├── api/
│   │   ├── sessions.routes.js         # POST /sessions
│   │   ├── sessions.controller.js
│   │   └── health.routes.js
│   ├── realtime/
│   │   ├── socketServer.js            # emits/consumes ONLY the shared game:* envelope (§5)
│   │   ├── sessionAuth.js             # validates the per-session player token (§8)
│   │   └── eventContract.js           # shared envelope builder/validator — copied from ludo-engine,
│   │                                    #   reusable boilerplate for future engines too
│   ├── game/
│   │   ├── deck.js                    # deck construction/shuffling, draw/discard piles
│   │   ├── cards.js                   # card types (number/action/wild) and effect definitions
│   │   ├── turnManager.js             # turn order, direction (reverse), skip handling
│   │   ├── unoCallRules.js            # "UNO" call/challenge rules
│   │   ├── engine.js                  # wires the above into move validation + win detection
│   │   ├── variants/                  # 2p / 3p / 4+p rule variants
│   │   └── bots/                      # engine's own bot AI (separate from portalapi's cosmetic botProfile)
│   ├── session/
│   │   ├── sessionStore.js            # in-memory/Redis session state
│   │   ├── reconnectManager.js        # token-based reconnect + grace period (§8)
│   │   └── timeoutManager.js          # turn timers, disconnect-timeout → forfeit
│   ├── portalapi/
│   │   ├── resultWebhook.js           # POSTs §4's payload, retries on failure
│   │   └── apiKeyClient.js            # holds PORTALAPI_TO_UNO_API_KEY validation + UNO_TO_PORTALAPI_API_KEY signing
│   ├── config/
│   │   └── index.js                   # PORTALAPI_BASE_URL, keys, PORT, REDIS_URL, TURN_TIMEOUT_MS...
│   └── server.js
├── test/
├── Dockerfile
└── package.json
```

---

## 12. Required portalapi-side changes (unchanged from the Ludo revision — additive, none touch gameplay logic)

Adding this engine requires no new portalapi-side design beyond what the Ludo revision already specified generically:
1. A `sessionAdapter.js` HTTP call using `PORTALAPI_TO_UNO_API_KEY`, mapping to §3's payload with `gameTypeSlug: "uno"`.
2. `apiKeyAuthFor("UNO_TO_PORTALAPI_API_KEY")` on this engine's `/engine/report-result` route — zero changes to any other engine's route.
3. New env vars: `PORTALAPI_TO_UNO_API_KEY`, `UNO_TO_PORTALAPI_API_KEY`, `UNO_ENGINE_BASE_URL`.
4. No changes to match model status enums, seat-number logic, timeout cron, or the socket event contract — those are already generic per the Ludo revision and apply unchanged to this engine.

---

**Nothing in this document has been implemented.** This project (`uno-engine`) is currently an architecture scaffold only — see its `README.md`.
