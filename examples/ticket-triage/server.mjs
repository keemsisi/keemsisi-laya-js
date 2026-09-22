/**
 * The example's server: one @laya-js/server handler plus static files.
 *
 *   node server.mjs --fake    a stub model, so the UI is fully usable offline
 *   LAYA=1 node server.mjs    the real checkpoint (needs @receptron/laya)
 *   node server.mjs           no model: the UI shows the unavailable state
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLayaServer } from '@laya-js/server';
import { optionsOf } from '@laya-js/core';
import { presets } from './src/presets.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, 'public');
const PORT = Number(process.env.PORT || 8790);
const FAKE = process.argv.includes('--fake');
const REAL = process.env.LAYA === '1' || process.argv.includes('--laya');

/** Obviously-fake answers so the demo never passes off a stub as the model. */
function stubModel() {
  return {
    config: { max_len: 512 },
    async systemOne(state, questions) {
      await new Promise((r) => setTimeout(r, 120));
      const text = JSON.stringify(state).toLowerCase();
      const answers = {};
      for (const [key, q] of Object.entries(questions)) {
        if (q.type === 'choice') {
          const options = optionsOf(q);
          const hit =
            /refund|charge|invoice|bill/.test(text) ? 'billing' :
            /500|error|api|outage|fail/.test(text) ? 'technical' :
            /pricing|plan|seat|contract/.test(text) ? 'sales' : options[0];
          const pick = options.includes(hit) ? hit : options[0];
          const probs = {};
          options.forEach((o) => { probs[o] = o === pick ? 0.72 : 0.28 / (options.length - 1); });
          answers[key] = { type: 'choice', choice: pick, probabilities: probs, confidence: 0.5, rl_agent: { act_probability: 1 } };
        } else if (q.type === 'score') {
          const s = /block|outage|today|critical|urgent/.test(text) ? 2.7 : 1.2;
          answers[key] = { type: 'score', score: s, legend: {}, probabilities: {}, confidence: 0.4, rl_agent: { act_probability: 1 } };
        } else {
          answers[key] = { type: 'noul', noul: /cancel|competitor|leave|dispute/.test(text) ? 0.83 : 0.12, rl_agent: { act_probability: 1 } };
        }
      }
      return { model: 'stub-not-laya', answers, usage: { input_tokens: 190, output_tokens: 0 } };
    },
    async close() {}
  };
}

const laya = createLayaServer({
  presets,
  allowAdHoc: false,
  // Long tickets get the body trimmed rather than silently truncated.
  fit: { dropStateKeys: ['body'] },
  // Pin the weights to a published commit: the loader size-checks the cached
  // files but does not checksum them, so "main" would float.
  ...(process.env.LAYA_REVISION ? { revision: process.env.LAYA_REVISION } : {}),
  ...(process.env.LAYA_MODEL_DIR ? { modelDir: process.env.LAYA_MODEL_DIR } : {}),
  ...(FAKE ? { load: async () => stubModel(), eager: true } : {}),
  ...(REAL ? { eager: true } : {}),
  logger: (line) => console.log(line)
});

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.map': 'application/json', '.css': 'text/css' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/laya/')) return laya.handler(req, res);

  const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) { res.statusCode = 403; return res.end('forbidden'); }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
});

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `port ${PORT} is in use; try PORT=8791 node server.mjs` : e.message);
  process.exit(1);
});

// Loopback only: the decide endpoint has no authentication.
// PORT=0 asks the OS for a free port, so report the one we actually got.
server.listen(PORT, '127.0.0.1', () => {
  const port = server.address().port;
  console.log('ticket triage  http://localhost:' + port + '/');
  console.log('health         http://localhost:' + port + '/laya/health');
  console.log('engine         ' + (FAKE ? 'STUB (not laya) - --fake' : REAL ? 'laya (loading)' : 'none - pass --fake, or LAYA=1 with @receptron/laya installed'));
});
