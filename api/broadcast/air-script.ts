import type { DraftBroadcastScript } from '../../shared/broadcastTypes.js';
import { finalizeDraftToBroadcastSegment } from '../../server/geminiBroadcast.js';
import {
  readJsonBody,
  sendJson,
  type ServerlessRequest,
  type ServerlessResponse,
} from '../../server/vercelHttp.js';

export default async function handler(req: ServerlessRequest, res: ServerlessResponse) {
  if (req.method === 'OPTIONS') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method && req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  try {
    const { draft, requestedBy } = await readJsonBody<{
      draft?: DraftBroadcastScript;
      requestedBy?: string;
    }>(req);

    if (
      !draft ||
      !draft.headline ||
      !Array.isArray(draft.dialogueBeats) ||
      draft.dialogueBeats.length === 0
    ) {
      sendJson(res, 400, {
        error: 'A valid script draft with at least one spoken line is required.',
      });
      return;
    }

    const segment = await finalizeDraftToBroadcastSegment(draft, {
      nowMs: Date.now(),
      requestedBy:
        typeof requestedBy === 'string' && requestedBy.trim()
          ? requestedBy.trim()
          : 'Producer Desk',
    });

    sendJson(res, 200, { segment });
  } catch (err) {
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : 'Unable to broadcast script now',
    });
  }
}
