import { expect } from 'chai';
import sinon from 'sinon';
import axios from 'axios';
import config from '../../src/config/index.js';
import { reportResultUrl, buildResultPayload, reportMatchResult } from '../../src/portalapi/resultWebhook.js';

const session = {
  source: 'duel',
  contextId: '6aabc83303ddfbc39c7de50d',
  matchId: '6ab10f8390d6fbe07eb1485d',
  gameEngineSessionId: 'uno_testsession',
  resultReport: null,
  resultReportPromise: null,
};

const standings = [
  { userId: '67286eb612db69183d1456f0', seatNumber: 1, position: 1, role: 'winner', points: 73 },
  { userId: '6748179ed64d689e4ef197b3', seatNumber: 2, position: 2, role: 'loser', points: 3 },
  { userId: '6725f74012db69183d143524', seatNumber: 4, position: 3, role: 'loser', points: 20 },
  { userId: '67273a3312db69183d144616', seatNumber: 3, position: 4, role: 'loser', points: 50 },
];

describe('result webhook', () => {
  const originalPortal = { ...config.portalapi };

  beforeEach(() => {
    config.portalapi.baseUrl = 'http://portal.test';
    config.portalapi.outboundApiKey = 'engine-key';
    session.resultReport = null;
    session.resultReportPromise = null;
  });

  afterEach(() => {
    Object.assign(config.portalapi, originalPortal);
    sinon.restore();
  });

  it('posts duel results to /duel-lobby/:lobbyId/engine/report-result', async () => {
    const post = sinon.stub(axios, 'post').resolves({ status: 200, data: { ok: true } });
    const result = await reportMatchResult(session, { results: standings, endedReason: 'completed' });

    expect(result.status).to.equal('ok');
    expect(post.calledOnce).to.equal(true);
    expect(post.firstCall.args[0]).to.equal(
      'http://portal.test/duel-lobby/6aabc83303ddfbc39c7de50d/engine/report-result'
    );
    expect(post.firstCall.args[1]).to.deep.include({
      matchId: session.matchId,
      gameEngineSessionId: session.gameEngineSessionId,
      endedReason: 'completed',
    });
    expect(post.firstCall.args[1].results).to.deep.equal(standings.map((r) => ({
      userId: r.userId,
      seatNumber: r.seatNumber,
      position: r.position,
    })));
    expect(post.firstCall.args[1].metadata.winner.points).to.equal(73);
    expect(post.firstCall.args[2].headers['X-API-Key']).to.equal('engine-key');
  });

  it('uses the tournament route when source is tournament', () => {
    expect(reportResultUrl({ ...session, source: 'tournament', contextId: 'tourney1' })).to.equal(
      'http://portal.test/game-tournament/tourney1/engine/report-result'
    );
  });

  it('treats 409 as already handled and does not retry', async () => {
    const post = sinon.stub(axios, 'post').resolves({ status: 409, data: { status: 'completed' } });
    const result = await reportMatchResult(session, { results: standings });
    expect(result.status).to.equal('already_handled');
    expect(post.calledOnce).to.equal(true);
  });

  it('puts UNO points in metadata, not in the contract results array', () => {
    const payload = buildResultPayload(session, { results: standings });
    expect(payload.results[0]).to.not.have.property('points');
    expect(payload.metadata.losers).to.have.length(3);
    expect(payload.metadata.standings[0].points).to.equal(73);
  });

  it('skips when PORTALAPI_BASE_URL is empty', async () => {
    config.portalapi.baseUrl = '';
    const post = sinon.stub(axios, 'post');
    const result = await reportMatchResult(session, { results: standings });
    expect(result.status).to.equal('skipped');
    expect(post.called).to.equal(false);
  });
});
