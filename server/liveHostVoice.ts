import { GoogleGenAI, type LiveServerMessage, Modality } from '@google/genai';
import type http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { HostId } from '../shared/broadcastTypes.js';
import { getHostById } from './hosts.js';

function createLiveAiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    apiVersion: 'v1beta',
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function sendWsJson(ws: WebSocket, payload: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

export function attachLiveHostWebSocket(httpServer: http.Server): void {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    try {
      const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (reqUrl.pathname !== '/ws/live-host') {
        return;
      }

      wss.handleUpgrade(req, socket, head, (clientWs) => {
        wss.emit('connection', clientWs, req);
      });
    } catch {
      socket.destroy();
    }
  });

  wss.on('connection', (clientWs, req) => {
    const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const rawHost = reqUrl.searchParams.get('hostId');
    const hostId: HostId =
      rawHost === 'elena' || rawHost === 'marcus' || rawHost === 'sora' ? rawHost : 'sora';
    const host = getHostById(hostId);

    const ai = createLiveAiClient();
    if (!ai) {
      sendWsJson(clientWs, {
        type: 'error',
        message: 'GEMINI_API_KEY is not active on this server yet.',
      });
      clientWs.close(1008, 'Missing API key');
      return;
    }

    const systemInstruction = `You are ${host.name}, live on-air host of "${host.showTitle}" on PleziDo TV (${host.studioName}).
Persona: ${host.personaTone}. Expertise: ${host.expertise}. Traits: ${host.personaTraits.join(', ')}.
Speak naturally, warmly, and expressively like a real live television studio host talking face-to-face with a viewer or producer.
Keep spoken turns lively, clear, conversational, and engaging (2 to 4 natural spoken sentences per turn).`;

    let closed = false;

    const sessionPromise = ai.live.connect({
      model: 'gemini-3.8-live',
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: host.voiceName },
          },
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        systemInstruction,
      },
      callbacks: {
        onopen: () => {
          sendWsJson(clientWs, {
            type: 'ready',
            hostId: host.id,
            hostName: host.name,
            voiceName: host.voiceName,
            model: 'gemini-3.8-live',
          });
        },
        onmessage: (message: LiveServerMessage) => {
          const content = message.serverContent;
          if (!content) return;

          if (content.interrupted) {
            sendWsJson(clientWs, { type: 'interrupted' });
          }
          if (content.inputTranscription?.text) {
            sendWsJson(clientWs, {
              type: 'inputTranscript',
              text: content.inputTranscription.text,
            });
          }
          if (content.outputTranscription?.text) {
            sendWsJson(clientWs, {
              type: 'outputTranscript',
              text: content.outputTranscription.text,
            });
          }
          for (const part of content.modelTurn?.parts ?? []) {
            if (part.inlineData?.data) {
              sendWsJson(clientWs, {
                type: 'audio',
                data: part.inlineData.data,
              });
            }
          }
          if (content.turnComplete) {
            sendWsJson(clientWs, { type: 'turnComplete' });
          }
        },
        onerror: (err: unknown) => {
          const msg = err instanceof Error ? err.message : 'Live voice stream interrupted.';
          sendWsJson(clientWs, { type: 'error', message: msg });
        },
        onclose: () => {
          if (!closed && clientWs.readyState === WebSocket.OPEN) {
            clientWs.close();
          }
        },
      },
    });

    sessionPromise.catch((err) => {
      const msg =
        err instanceof Error ? err.message : 'Unable to connect to Gemini Live native voice.';
      sendWsJson(clientWs, { type: 'error', message: msg });
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close(1011, 'Live connect failed');
      }
    });

    clientWs.on('message', (raw) => {
      if (closed) return;
      try {
        const msg = JSON.parse(raw.toString()) as {
          type?: 'audio' | 'text';
          data?: string;
          text?: string;
        };
        sessionPromise
          .then((session) => {
            if (closed) return;
            if (msg.type === 'audio' && typeof msg.data === 'string' && msg.data.length > 0) {
              session.sendRealtimeInput({
                audio: { data: msg.data, mimeType: 'audio/pcm;rate=16000' },
              });
            } else if (msg.type === 'text' && typeof msg.text === 'string' && msg.text.trim()) {
              session.sendRealtimeInput({ text: msg.text.trim() });
            }
          })
          .catch(() => undefined);
      } catch {
        // Ignore malformed client frames
      }
    });

    clientWs.on('close', () => {
      closed = true;
      sessionPromise
        .then((session) => {
          try {
            session.close();
          } catch {
            // Ignore close errors
          }
        })
        .catch(() => undefined);
    });
  });
}
