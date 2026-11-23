import type {
  ChannelCategory,
  HostId,
  ScriptFormat,
} from '../../shared/broadcastTypes.js';
import { draftScriptWithGemini } from '../../server/geminiBroadcast.js';
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
    const { channel, primaryHostId, coHostId, format, topic } = await readJsonBody<{
      channel?: ChannelCategory;
      primaryHostId?: HostId;
      coHostId?: HostId;
      format?: ScriptFormat;
      topic?: string;
    }>(req);

    const validChannel: ChannelCategory =
      channel === 'news' || channel === 'music' || channel === 'culture' ? channel : 'news';

    const validHost: HostId =
      primaryHostId === 'elena' || primaryHostId === 'marcus' || primaryHostId === 'sora'
        ? primaryHostId
        : validChannel === 'news'
          ? 'elena'
          : validChannel === 'music'
            ? 'marcus'
            : 'sora';

    const validFormat: ScriptFormat =
      format === 'breaking-news' ||
      format === 'music-intro' ||
      format === 'editorial-essay' ||
      format === 'live-debate'
        ? format
        : 'breaking-news';

    const draft = await draftScriptWithGemini({
      channel: validChannel,
      primaryHostId: validHost,
      coHostId: coHostId && coHostId !== validHost ? coHostId : undefined,
      format: validFormat,
      topic: typeof topic === 'string' ? topic : '',
      throwOnUpstreamError: true,
    });

    sendJson(res, 200, { draft });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unable to write script with Gemini';
    const status = msg.includes('429') || msg.toLowerCase().includes('rate limit') ? 429 : 500;
    sendJson(res, status, { error: msg });
  }
}
