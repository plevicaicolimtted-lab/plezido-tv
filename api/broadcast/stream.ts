import { buildStatelessBroadcastState } from '../../server/statelessState.js';
import type { ServerlessRequest, ServerlessResponse } from '../../server/vercelHttp.js';

export default async function handler(_req: ServerlessRequest, res: ServerlessResponse) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, no-transform');
  res.setHeader('Connection', 'keep-alive');

  try {
    const state = await buildStatelessBroadcastState(Date.now());
    res.write(`data: ${JSON.stringify({ type: 'init', mode: 'stateless', state })}\n\n`);
    res.write(
      `data: ${JSON.stringify({
        type: 'clock:sync',
        serverTimeMs: Date.now(),
        viewerCount: 1,
      })}\n\n`
    );
  } catch (err) {
    res.write(
      `data: ${JSON.stringify({
        type: 'error',
        error: err instanceof Error ? err.message : 'Stream initialization error',
      })}\n\n`
    );
  } finally {
    res.end();
  }
}
