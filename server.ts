import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChannelCategory } from './shared/broadcastTypes.js';
import { broadcastDirector } from './server/broadcastDirector.js';
import { getCachedSegmentAudio } from './server/geminiBroadcast.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '1mb' }));

  await broadcastDirector.initialize();

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', serverTimeMs: Date.now() });
  });

  app.get('/api/broadcast/state', (_req, res) => {
    res.json(broadcastDirector.getState());
  });

  app.get('/api/broadcast/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const initialPayload = {
      type: 'init',
      state: broadcastDirector.getState(),
    };
    res.write(`data: ${JSON.stringify(initialPayload)}\n\n`);

    broadcastDirector.addSseClient(res);

    req.on('close', () => {
      res.end();
    });
  });

  app.get('/api/broadcast/audio/:segmentId', (req, res) => {
    const wav = getCachedSegmentAudio(req.params.segmentId);
    if (!wav) {
      res.status(404).json({ error: 'Segment audio not available' });
      return;
    }
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Length', String(wav.length));
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(wav);
  });

  app.post('/api/broadcast/request', async (req, res) => {
    try {
      const { topic, category, requesterName } = req.body as {
        topic?: string;
        category?: ChannelCategory;
        requesterName?: string;
      };

      if (!topic || typeof topic !== 'string' || topic.trim().length < 3) {
        res.status(400).json({ error: 'Please enter a topic or mood of at least 3 characters.' });
        return;
      }

      const validCategory: ChannelCategory =
        category === 'news' || category === 'music' || category === 'culture'
          ? category
          : 'news';

      const result = await broadcastDirector.submitViewerRequest(
        topic,
        validCategory,
        requesterName || 'Viewer'
      );

      res.status(result.accepted ? 201 : 422).json(result);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Unable to process viewer request',
      });
    }
  });

  app.post('/api/broadcast/produce', async (req, res) => {
    try {
      const { channel, roundtable } = req.body as {
        channel?: ChannelCategory;
        roundtable?: boolean;
      };
      const validChannel: ChannelCategory =
        channel === 'news' || channel === 'music' || channel === 'culture'
          ? channel
          : 'news';

      const segment = await broadcastDirector.triggerLiveSegmentNow(
        validChannel,
        Boolean(roundtable)
      );
      res.json({ segment });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Unable to produce live segment',
      });
    }
  });

  const httpServer = http.createServer(app);

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR === 'true' ? false : { server: httpServer },
      },
      appType: 'spa',
    });

    if (process.env.DISABLE_HMR === 'true') {
      app.get('/@vite/client', async (_req, res, next) => {
        try {
          const result = await vite.transformRequest('/@vite/client');
          if (!result) return next();
          const patched = result.code.replace(
            /transport\.connect\(createHMRHandler\([^)]+\)\)/g,
            'Promise.resolve()'
          );
          res.setHeader('Content-Type', 'application/javascript');
          res.send(patched);
        } catch (err) {
          next(err);
        }
      });
    }

    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[PleziDo TV] Live 24/7 Broadcast Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('[PleziDo TV] Fatal startup error:', err);
  process.exit(1);
});
