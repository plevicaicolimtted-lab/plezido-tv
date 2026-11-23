import { getCachedSegmentAudio } from '../../../server/geminiBroadcast.js';
import {
  sendJson,
  type ServerlessRequest,
  type ServerlessResponse,
} from '../../../server/vercelHttp.js';

function extractSegmentId(req: ServerlessRequest): string {
  const fromQuery = req.query?.segmentId;
  if (typeof fromQuery === 'string' && fromQuery.trim()) {
    return fromQuery.trim();
  }
  if (Array.isArray(fromQuery) && fromQuery[0]?.trim()) {
    return fromQuery[0].trim();
  }
  if (req.url) {
    const pathname = req.url.split('?')[0] ?? '';
    const lastPart = pathname.split('/').filter(Boolean).pop();
    if (lastPart && lastPart !== 'audio') {
      return decodeURIComponent(lastPart);
    }
  }
  return '';
}

export default function handler(req: ServerlessRequest, res: ServerlessResponse) {
  const segmentId = extractSegmentId(req);
  const wav = segmentId ? getCachedSegmentAudio(segmentId) : undefined;

  if (!wav) {
    sendJson(res, 404, { error: 'Segment audio not available' });
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Content-Length', String(wav.length));
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.end(wav);
}
