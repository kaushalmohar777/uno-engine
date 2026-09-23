import { expect } from 'chai';
import { startServer, stopServer, createSession, connectClients, playToCompletion } from './playthroughHelpers.js';

const PLAYERS = [
  { userId: '67286eb612db69183d1456f0', seatNumber: 1 },
  { userId: '6748179ed64d689e4ef197b3', seatNumber: 2 },
];

describe('2-player UNO playthrough', function () {
  this.timeout(20000);

  let httpServer;
  let port;
  let sessionId;
  let matchId;
  let tokens;
  let clients;

  before(async () => {
    ({ httpServer, port } = await startServer());
    matchId = `match_playthrough_2p_${Date.now()}`;
    ({ sessionId, tokens } = await createSession(port, { matchId, contextId: '6aabc83303ddfbc39c7de50e', players: PLAYERS }));
  });

  after(async () => {
    await stopServer(httpServer, clients);
  });

  it('plays a legal 2-player game to completion (reverse acts as skip, +2 stacking, wilds all exercised)', async () => {
    clients = connectClients(port, PLAYERS, tokens);
    const completed = await playToCompletion(clients, sessionId, matchId);

    expect(completed.winner).to.include({ role: 'winner', position: 1 });
    expect(completed.losers).to.have.length(1);
    expect(completed.losers[0]).to.include({ role: 'loser', position: 2 });
    expect(completed.results).to.have.length(2);
    expect(completed.winner.points).to.equal(completed.losers[0].points);

    const winnerClient = clients.find((c) => c.userId === completed.winner.userId);
    expect(winnerClient.view.players.find((p) => p.userId === completed.winner.userId).handCount).to.equal(0);
  });
});
