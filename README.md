# UNO Engine

Standalone UNO game engine, built as a separate service from `portalapi` (fanzaty-esports). PortalAPI owns tournament/duel orchestration, users, wallets, prizes, and notifications; this engine owns UNO gameplay, sessions, and real-time state — the two talk only through the contract in [`docs/game-engine-integration-contract.md`](docs/game-engine-integration-contract.md).

**Status: architecture scaffold only. No gameplay, API, socket, database, auth, or PortalAPI-integration logic has been implemented yet.**

## Structure

```
src/
├── api/            HTTP layer — session-create endpoint portalapi calls, health check
├── realtime/       The engine's own Socket.IO server clients connect to directly for gameplay,
│                   plus the shared game:* event-envelope contract (see docs/)
├── game/           UNO rules: deck, cards, turn order, UNO-call rules, engine, player-count
│                   variants, bots
├── session/        Live session state, reconnect handling, turn/timeout timers
├── portalapi/      Outbound result webhook + the API-key client for both directions
├── config/         Env-driven configuration
└── server.js       Process entry point
test/               Test suite (empty scaffold)
docs/               Integration contract with PortalAPI
```

## Integration contract

See [`docs/game-engine-integration-contract.md`](docs/game-engine-integration-contract.md) for the full, finalized design: session lifecycle, API/webhook payloads, the shared Socket.IO event contract (the same one every game engine uses — Ludo, UNO, and future engines like Balloot or Chess), authentication, timeouts, and identity mapping. That document is the source of truth for how this engine must behave once implemented — nothing here should diverge from it without updating the contract first.

## Hard constraints (from the contract)

- This engine never accesses PortalAPI's MongoDB or any of its internal models directly — every interaction is an HTTP call, a webhook, or a socket event defined in the contract.
- Every gameplay/lifecycle socket event uses the shared generic envelope (`gameType`, `type`, `kind`, `sessionId`, `matchId`, `userId`, `data`) — never a game-specific event name. `gameType` is always `"uno"` for this engine; UNO-specific meaning (play a card, draw a card, call UNO, challenge a call, choose a color) lives entirely in `type`/`kind`/`data`.
