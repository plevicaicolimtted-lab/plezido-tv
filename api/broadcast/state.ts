import { buildStatelessBroadcastState } from '../../server/statelessState.js';
import { sendJson, type ServerlessRequest, type ServerlessResponse } from '../../server/vercelHttp.js';

export default async function handler(_req: ServerlessRequest, res: ServerlessResponse) {
  try {
    const state = await buildStatelessBroadcastState(Date.now());
    sendJson(res, 200, state);
  } catch (err) {
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : 'Unable to build PleziDo TV broadcast state',
    });
  }
}
