import type { HostId } from '../../shared/broadcastTypes.js';
import { screenViewerRequest } from '../../server/contentModeration.js';
import { talkWithAiHost } from '../../server/geminiBroadcast.js';
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
    const { hostId, message, history, withVoice } = await readJsonBody<{
      hostId?: HostId;
      message?: string;
      history?: Array<{ role: 'user' | 'host'; text: string }>;
      withVoice?: boolean;
    }>(req);

    if (!message || typeof message !== 'string' || message.trim().length < 2) {
      sendJson(res, 400, { error: 'Say or type at least 2 characters to talk with the host.' });
      return;
    }

    const validHost: HostId =
      hostId === 'elena' || hostId === 'marcus' || hostId === 'sora' ? hostId : 'sora';

    const mod = await screenViewerRequest(
      `talk-${Date.now()}`,
      message.trim().slice(0, 180),
      validHost === 'elena' ? 'news' : validHost === 'marcus' ? 'music' : 'culture'
    );
    if (!mod.allowed) {
      sendJson(res, 422, { error: mod.report.notes });
      return;
    }

    const result = await talkWithAiHost({
      hostId: validHost,
      message,
      history: Array.isArray(history) ? history : [],
      withVoice: withVoice !== false,
    });

    sendJson(res, 200, result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unable to reach AI host right now';
    const lower = msg.toLowerCase();
    const status =
      msg.includes('429') || lower.includes('quota')
        ? 429
        : msg.includes('503') || lower.includes('high demand') || lower.includes('unavailable')
          ? 503
          : 500;
    sendJson(res, status, { error: msg });
  }
}
