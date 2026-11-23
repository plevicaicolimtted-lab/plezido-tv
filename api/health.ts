import { sendJson, type ServerlessRequest, type ServerlessResponse } from '../server/vercelHttp.js';

export default function handler(_req: ServerlessRequest, res: ServerlessResponse) {
  sendJson(res, 200, { status: 'ok', serverTimeMs: Date.now() });
}
