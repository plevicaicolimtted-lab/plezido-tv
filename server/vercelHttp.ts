import type { IncomingMessage, ServerResponse } from 'node:http';

export interface ServerlessRequest extends IncomingMessage {
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
}

export interface ServerlessResponse extends ServerResponse {
  status?: (code: number) => ServerlessResponse;
  json?: (data: unknown) => void;
  send?: (body: unknown) => void;
}

export async function readJsonBody<T>(req: ServerlessRequest): Promise<T> {
  if (req.body && typeof req.body === 'object') {
    return req.body as T;
  }
  if (typeof req.body === 'string' && req.body.trim()) {
    return JSON.parse(req.body) as T;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {} as T;
  }
  return JSON.parse(raw) as T;
}

export function sendJson(
  res: ServerlessResponse,
  statusCode: number,
  payload: unknown
): void {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (typeof res.status === 'function') {
    const withStatus = res.status(statusCode);
    if (typeof withStatus.json === 'function') {
      withStatus.json(payload);
      return;
    }
  }
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}
