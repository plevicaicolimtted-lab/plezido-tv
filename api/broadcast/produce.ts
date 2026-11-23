import type { ChannelCategory, HostId } from '../../shared/broadcastTypes.js';
import { generateLiveBroadcastSegment } from '../../server/geminiBroadcast.js';
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
    const { channel, roundtable, requestedTopic, requestedBy } = await readJsonBody<{
      channel?: ChannelCategory;
      roundtable?: boolean;
      requestedTopic?: string;
      requestedBy?: string;
    }>(req);

    const validChannel: ChannelCategory =
      channel === 'news' || channel === 'music' || channel === 'culture' ? channel : 'news';

    const primaryHostId: HostId =
      validChannel === 'news' ? 'elena' : validChannel === 'music' ? 'marcus' : 'sora';

    const coHostId: HostId | undefined = roundtable
      ? validChannel === 'culture'
        ? 'elena'
        : 'sora'
      : undefined;

    const cleanTopic = typeof requestedTopic === 'string' ? requestedTopic.trim().slice(0, 180) : '';
    const cleanRequester =
      typeof requestedBy === 'string' && requestedBy.trim() ? requestedBy.trim().slice(0, 40) : undefined;

    const segment = await generateLiveBroadcastSegment({
      channel: validChannel,
      primaryHostId,
      coHostId,
      theme: cleanTopic
        ? `Viewer Requested: ${cleanTopic}`
        : roundtable
          ? 'Live Dual-Host Roundtable & Analysis'
          : `Live ${validChannel.toUpperCase()} Broadcast`,
      requestedTopic: cleanTopic || undefined,
      requestedBy: cleanRequester,
      nowMs: Date.now(),
    });

    sendJson(res, 200, { segment });
  } catch (err) {
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : 'Unable to produce live segment',
    });
  }
}
