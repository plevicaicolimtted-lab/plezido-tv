import crypto from 'node:crypto';
import type { ChannelCategory, ViewerRequest } from '../../shared/broadcastTypes.js';
import { screenViewerRequest } from '../../server/contentModeration.js';
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
    const { topic, category, requesterName } = await readJsonBody<{
      topic?: string;
      category?: ChannelCategory;
      requesterName?: string;
    }>(req);

    if (!topic || typeof topic !== 'string' || topic.trim().length < 3) {
      sendJson(res, 400, {
        error: 'Please enter a topic or mood of at least 3 characters.',
      });
      return;
    }

    const validCategory: ChannelCategory =
      category === 'news' || category === 'music' || category === 'culture' ? category : 'news';

    const reqId = `req-${crypto.randomUUID().slice(0, 8)}`;
    const cleanTopic = topic.trim().slice(0, 180);
    const cleanName =
      typeof requesterName === 'string' && requesterName.trim()
        ? requesterName.trim().slice(0, 40)
        : 'Viewer';

    const { allowed, report } = await screenViewerRequest(reqId, cleanTopic, validCategory);

    const requestItem: ViewerRequest = {
      id: reqId,
      topic: cleanTopic,
      category: validCategory,
      requesterName: cleanName,
      status: allowed ? 'queued' : 'flagged',
      moderationReason: allowed ? undefined : report.notes,
      submittedAtMs: Date.now(),
    };

    sendJson(res, allowed ? 201 : 422, {
      accepted: allowed,
      request: requestItem,
      report,
    });
  } catch (err) {
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : 'Unable to process viewer request',
    });
  }
}
