// Posts the result webhook (contract §4) to portalapi's /engine/report-result
// routes, with retry/backoff. 409 means portalapi already applied the result
// — stop retrying. UNO scoring lives in metadata; portalapi's processor only
// reads `position` from results[].
import axios from 'axios';
import config from '../config/index.js';
import { getOutboundApiKey } from './apiKeyClient.js';

const MAX_ATTEMPTS = Number(process.env.RESULT_WEBHOOK_MAX_ATTEMPTS || 5);
const BASE_DELAY_MS = Number(process.env.RESULT_WEBHOOK_RETRY_MS || 1000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

export function reportResultUrl(session) {
  const base = trimSlash(config.portalapi.baseUrl);
  if (!base) return null;
  const path = session.source === 'tournament'
    ? `/game-tournament/${session.contextId}/engine/report-result`
    : `/duel-lobby/${session.contextId}/engine/report-result`;
  return `${base}${path}`;
}

export function buildResultPayload(session, { results, endedReason = 'completed' }) {
  const standings = results || session.game?.results || [];
  return {
    matchId: session.matchId,
    gameEngineSessionId: session.gameEngineSessionId,
    results: standings.map((r) => ({
      userId: r.userId ?? null,
      seatNumber: r.seatNumber,
      position: r.position,
    })),
    endedReason,
    metadata: {
      gameType: config.gameTypeSlug,
      winner: standings.find((r) => r.role === 'winner' || r.position === 1) || null,
      losers: standings.filter((r) => r.role === 'loser' || r.position > 1),
      standings,
    },
  };
}

function shouldRetryStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Sends the match result to portalapi. Resolves when portalapi accepts it
 * (2xx) or reports it already applied (409). Skips if PORTALAPI_BASE_URL is
 * not configured. Never throws to the gameplay path — callers may still
 * `.catch` for logs.
 */
export async function reportMatchResult(session, { results, endedReason = 'completed' } = {}) {
  if (session.resultReport?.status === 'ok' || session.resultReport?.status === 'already_handled') {
    return session.resultReport;
  }
  if (session.resultReportPromise) return session.resultReportPromise;

  session.resultReportPromise = (async () => {
    const url = reportResultUrl(session);
    if (!url) {
      const skipped = { status: 'skipped', reason: 'PORTALAPI_BASE_URL is not configured' };
      console.warn(`[resultWebhook] ${skipped.reason}; match ${session.matchId} not reported`);
      session.resultReport = skipped;
      return skipped;
    }

    const apiKey = getOutboundApiKey();
    if (!apiKey) {
      const skipped = { status: 'skipped', reason: 'UNO_TO_PORTALAPI_API_KEY is not configured' };
      console.warn(`[resultWebhook] ${skipped.reason}; match ${session.matchId} not reported`);
      session.resultReport = skipped;
      return skipped;
    }

    const payload = buildResultPayload(session, { results, endedReason });
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await axios.post(url, payload, {
          headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
          timeout: 10000,
          validateStatus: () => true,
        });

        if (response.status === 409) {
          const result = { status: 'already_handled', httpStatus: 409 };
          session.resultReport = result;
          return result;
        }

        if (response.status >= 200 && response.status < 300) {
          const result = { status: 'ok', httpStatus: response.status };
          session.resultReport = result;
          return result;
        }

        lastError = new Error(`PortalAPI report-result HTTP ${response.status}`);
        if (!shouldRetryStatus(response.status)) {
          session.resultReport = { status: 'failed', httpStatus: response.status, error: lastError.message };
          console.error(`[resultWebhook] ${lastError.message} for match ${session.matchId}`);
          return session.resultReport;
        }
      } catch (err) {
        lastError = err;
      }

      if (attempt < MAX_ATTEMPTS) {
        await sleep(BASE_DELAY_MS * attempt);
      }
    }

    session.resultReport = { status: 'failed', error: lastError?.message || 'report-result failed' };
    console.error(`[resultWebhook] giving up for match ${session.matchId}: ${session.resultReport.error}`);
    return session.resultReport;
  })().finally(() => {
    session.resultReportPromise = null;
  });

  return session.resultReportPromise;
}
