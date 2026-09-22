/* ------------------------------------------------------------------ *
 * ui-test.js - the page glue in index.html.
 *
 * The glue is the one layer with no module boundary: it reaches into
 * the markup by id and into all three modules by name. A typo there
 * throws only in a real browser, so this checks the ids against the
 * markup and then runs the glue against stubs and a live sidecar.
 * Run with:  node tests/ui-test.js
 * ------------------------------------------------------------------ */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { loadGame, elStub } = require('./dom-stub.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + extra : '')); }
}

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const glue = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));

console.log('\n== the markup and the glue agree ==');
{
  const declared = new Set();
  const re = /id="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) declared.add(m[1]);

  const used = new Set();
  const re2 = /getElementById\('([^']+)'\)|\bq\('([^']+)'\)/g;
  while ((m = re2.exec(glue))) used.add(m[1] || m[2]);

  const missing = Array.from(used).filter(function (id) { return !declared.has(id); });
  ok('every id the glue looks up exists in the markup (' + used.size + ' ids)',
     missing.length === 0, missing.join(','));

  // Scripts are classic (not modules) and must load in dependency order.
  const order = (html.match(/<script src="([^"]+)"/g) || []).map(function (s) {
    return s.match(/src="([^"]+)"/)[1];
  });
  ok('game.js loads first', order[0] === 'game.js', order[0]);
  ok('laya-client.js loads last', order[order.length - 1] === 'laya-client.js', order[order.length - 1]);

  // bot/ is split by responsibility and loaded as classic scripts, so every
  // part must be on the page and must come before the composition root that
  // wires them. Checked against the directory rather than a fixed list, so a
  // new module cannot be added without the page learning about it.
  const parts = fs.readdirSync(path.join(root, 'bot')).filter(function (f) { return f.endsWith('.js'); }).sort();
  const listed = order.filter(function (s) { return s.indexOf('bot/') === 0; })
                      .map(function (s) { return s.slice(4); }).sort();
  ok('every module in bot/ is on the page (' + parts.length + ')',
     parts.join(',') === listed.join(','), 'on disk: ' + parts.join(',') + ' | on page: ' + listed.join(','));
  const rootIdx = order.indexOf('bot.js');
  const lastPart = order.reduce(function (acc, s, i) { return s.indexOf('bot/') === 0 ? i : acc; }, -1);
  ok('bot/ parts load before bot.js', rootIdx > lastPart && lastPart >= 0, 'bot.js at ' + rootIdx + ', last part at ' + lastPart);

  // Every src must resolve: a typo would fail silently in the browser.
  const broken = order.filter(function (s) { return !fs.existsSync(path.join(root, s)); });
  ok('every script src exists on disk', broken.length === 0, broken.join(','));
}

/* ------------------------------------------------------------------ *
 * bot/ resolves its dependencies two ways: require() in Node, and a
 * window global in the browser. Every other test takes the Node path,
 * so the browser one is loaded here the way the page loads it - in
 * order, into one shared scope, with no module or require in sight.
 * ------------------------------------------------------------------ */
console.log('\n== bot/ loads as plain browser scripts ==');
{
  const vm = require('node:vm');
  const win = {};
  const ctx = vm.createContext({ window: win, console: { log: function () {} } });
  ctx.globalThis = ctx;

  // Recomputed here rather than shared: this block must mirror the page.
  const scripts = (html.match(/<script src="([^"]+)"/g) || [])
    .map(function (s) { return s.match(/src="([^"]+)"/)[1]; })
    .filter(function (s) { return s.indexOf('bot') === 0; });

  let threw = null;
  try {
    scripts.forEach(function (f) {
      vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f });
    });
  } catch (e) { threw = e; }
  ok('the page lists every bot script (' + scripts.length + ')', scripts.length >= 2, String(scripts.length));
  ok('every bot script evaluates with no module system', threw === null, threw && threw.message);
  ok('nothing leaked a require() call into the browser path', !/\brequire\b/.test(String(threw)));

  const parts = fs.readdirSync(path.join(root, 'bot')).filter(function (f) { return f.endsWith('.js'); })
                  .map(function (f) { return f.replace(/\.js$/, ''); }).sort();
  ok('each module registered itself on window.TetrisBot',
     win.TetrisBot && Object.keys(win.TetrisBot).sort().join(',') === parts.join(','),
     win.TetrisBot ? Object.keys(win.TetrisBot).sort().join(',') : 'no TetrisBot');
  ok('the composition root published the same surface as in Node',
     win.TetrisBotCore && Object.keys(win.TetrisBotCore).sort().join(',') === 'KEYS,PROFILES,STRATEGIES,createBot,makeCore',
     win.TetrisBotCore ? Object.keys(win.TetrisBotCore).sort().join(',') : 'no TetrisBotCore');

  // Wire it to a real game module and make it plan, so the browser path is
  // shown to compose - not merely to parse.
  const env2 = loadGame();
  const wired = win.TetrisBotCore.createBot(env2.T, {});
  env2.T.start ? env2.T.start() : null;
  const r = wired.replan();
  ok('a bot built from the browser globals can rank placements',
     !!r && wired.candidates.length > 0, r ? String(wired.candidates.length) : 'no plan');
  ok('and can build a snapshot for the sidecar',
     !!r && wired.snapshot(wired.candidates, r.before).candidates.length === wired.candidates.length);
  ok('no type="module" (the page must work from file:// too)', !/<script[^>]+type="module"/.test(html));
  ok('the engine panel is in the markup', /class="card engine"/.test(html));
  ok('the mode buttons carry their modes',
     ['off', 'assist', 'autoplay'].every(function (mo) { return html.includes('data-mode="' + mo + '"'); }));
}

function startServer() {
  const child = spawn(process.execPath, [path.join(root, 'server', 'server.mjs')], {
    env: Object.assign({}, process.env, { PORT: '0', LAYA: '0' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise(function (resolve, reject) {
    let out = '';
    child.stdout.on('data', function (b) {
      out += b;
      const m = out.match(/http:\/\/localhost:(\d+)\/\n/);
      if (m) resolve({ child: child, port: Number(m[1]) });
    });
    setTimeout(function () { reject(new Error('no port')); }, 8000);
  });
}

(async function () {
  const srv = await startServer();
  try {
    /* ---------------------------------------------------------------- *
     * The page is only as good as what the server hands back. Splitting
     * bot/ into a subdirectory is exactly the change that can leave the
     * suite green while every script 404s in a real browser, so fetch
     * each one from the live server rather than trusting the filesystem.
     * ---------------------------------------------------------------- */
    console.log('\n== the server serves every asset the page asks for ==');
    {
      const base = 'http://127.0.0.1:' + srv.port;
      const srcs = (html.match(/<script src="([^"]+)"/g) || [])
        .map(function (s) { return s.match(/src="([^"]+)"/)[1]; });

      const page = await fetch(base + '/');
      ok('GET / returns the page', page.status === 200, String(page.status));
      ok('it is served as html', (page.headers.get('content-type') || '').includes('text/html'));

      const bad = [];
      for (const src of srcs) {
        const r = await fetch(base + '/' + src);
        const body = await r.text();
        const type = r.headers.get('content-type') || '';
        if (r.status !== 200 || body.length === 0 || !type.includes('javascript')) {
          bad.push(src + ' (' + r.status + ', ' + body.length + 'b, ' + type + ')');
        }
      }
      ok('every script src is served as non-empty javascript (' + srcs.length + ')',
         bad.length === 0, bad.join('; '));

      // Subdirectories must work without opening a way out of the demo.
      const esc = await fetch(base + '/../../package.json');
      const escBody = esc.status === 200 ? await esc.text() : '';
      ok('a traversal cannot read outside the demo',
         !escBody.includes('"name": "laya-js"'), escBody.slice(0, 60));
      const abs = await fetch(base + '/../../../../../../etc/hosts');
      ok('nor anything off the repo entirely', abs.status !== 200 || !(await abs.text()).includes('localhost'));
    }

    console.log('\n== the glue runs ==');
    const env = loadGame();

    // Panel elements, with the children the glue walks over.
    const panel = {};
    ['eBadge', 'eSpeed', 'eLoop', 'eWait', 'eStrategy', 'eStrategyBar', 'eStrategyWhy',
     'eRiskLabel', 'eCands', 'eWhy', 'eTally', 'eReason'].forEach(function (id) {
      panel[id] = elStub(id);
    });
    panel.eRisk = elStub('eRisk');
    panel.eRisk.children = [elStub('i'), elStub('i'), elStub('i'), elStub('i')];
    panel.eMode = elStub('eMode');
    panel.eMode.children = ['off', 'assist', 'autoplay'].map(function (mo) {
      const b = elStub('b'); b.dataset = { mode: mo }; return b;
    });
    panel.eSpeed.value = '0';
    panel.eLoop.checked = true;
    panel.eWait.checked = false;

    const intervals = [];
    const document = {
      getElementById: function (id) { return panel[id] || env.els[id] || elStub(id); },
      addEventListener: function () {},
      createElement: function () {
        const e = elStub('div');
        e.querySelector = function () { return elStub('txt'); };
        return e;
      }
    };
    const keyHandlers = [];
    const window = {
      Tetris: env.T,
      TetrisBotCore: env.botCore,
      LayaClient: require(path.join(root, 'laya-client.js')),
      addEventListener: function (t, f) { if (t === 'keydown') keyHandlers.push(f); },
      devicePixelRatio: 2
    };
    globalThis.location = { protocol: 'http:', origin: 'http://127.0.0.1:' + srv.port };

    let threw = null;
    try {
      new Function('window', 'document', 'location', 'fetch', 'performance', 'setInterval',
                   'setTimeout', 'clearTimeout', 'AbortController', 'Array', 'Number', 'Math', 'Set',
        glue)(
        window, document, globalThis.location, fetch, performance,
        function (fn, ms) { intervals.push({ fn: fn, ms: ms }); return intervals.length; },
        setTimeout, clearTimeout, AbortController, Array, Number, Math, Set
      );
    } catch (e) { threw = e; }
    ok('the glue executes without throwing', threw === null, threw && threw.message);

    const bot = window.__bot, client = window.__client;
    ok('it exposes the bot and the client for the console', !!bot && !!client);
    ok('it points the client at the sidecar', client.endpoint.endsWith(':' + srv.port), client.endpoint);
    ok('it wired the bot into the game hooks', env.T.hooks.piece !== null && env.T.hooks.frame !== null);
    ok('it installed a decide function', typeof bot.decide === 'function');
    ok('it registered the mode hotkey', keyHandlers.length > 0);
    ok('it started with the engine off', bot.mode === 'off');
    ok('the badge reads idle while off', panel.eBadge.textContent === 'idle', panel.eBadge.textContent);
    ok('it scheduled the health poll and the autoplay loop', intervals.length === 2, String(intervals.length));

    console.log('\n== switching to autoplay renders a decision ==');
    panel.eMode.children[2].dataset.mode = 'autoplay';
    // Click through the same handler the page uses.
    const clickHandler = panel.eMode.handlers.click[0];
    clickHandler({ target: { closest: function () { return panel.eMode.children[2]; } } });
    ok('the mode switched', bot.mode === 'autoplay', bot.mode);
    ok('the game started', env.T.S.running === true);

    // Real frame time: the decisions are real HTTP round trips, and the
    // glue leaves stepMs at 55, so the bot needs wall-clock time to play.
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && bot.stats.fallback < 6 && !env.T.S.over) {
      await new Promise(function (r) { setTimeout(r, 16); });
      bot.tick(16);
    }
    ok('decisions came back from the sidecar', bot.stats.fallback >= 6,
       'fallback=' + bot.stats.fallback + ' offline=' + bot.stats.offline);
    ok('the decision object reached the panel', bot.decision && bot.decision.engine === 'fallback',
       JSON.stringify(bot.decision && bot.decision.engine));
    ok('the badge reports the real engine', panel.eBadge.textContent === 'fallback', panel.eBadge.textContent);
    ok('the strategy field was filled in',
       panel.eStrategy.textContent.length > 0 && panel.eStrategy.textContent !== '—',
       panel.eStrategy.textContent);
    ok('the strategy explainer was filled in', panel.eStrategyWhy.textContent.length > 10,
       panel.eStrategyWhy.textContent);
    ok('the risk label was filled in', panel.eRiskLabel.textContent.length > 0, panel.eRiskLabel.textContent);
    ok('the risk meter was lit', panel.eRisk.children.some(function (c) { return /on\d/.test(c.className); }),
       panel.eRisk.children.map(function (c) { return c.className; }).join('|'));
    ok('the candidate rows were rendered', panel.eCands.appended > 0, String(panel.eCands.appended));
    ok('the tally was rendered', /pieces \d+/.test(panel.eTally.textContent), panel.eTally.textContent.split('\n')[0]);
    ok('the latency line mentions the engine', panel.eWhy.textContent.length > 0, panel.eWhy.textContent);
    ok('the fallback reason is shown', panel.eReason.hidden === false && panel.eReason.textContent.length > 0,
       panel.eReason.textContent);
    ok('the game is progressing', env.T.S.score > 0 && bot.stats.pieces > 3,
       'score=' + env.T.S.score + ' pieces=' + bot.stats.pieces);

    console.log('\n== the wait-for-laya toggle is wired ==');
    ok('it starts off', bot.opt.waitForDecision === false);
    panel.eWait.checked = true;
    panel.eWait.handlers.change[0]();
    ok('enabling it makes the bot hold each piece for an answer',
       bot.opt.waitForDecision === true, String(bot.opt.waitForDecision));
    panel.eWait.checked = false;
    panel.eWait.handlers.change[0]();
    ok('and it can be turned back off', bot.opt.waitForDecision === false);

    console.log('\n== the speed control is wired ==');
    panel.eSpeed.value = '140';
    panel.eSpeed.handlers.change[0]();
    ok('changing speed updates the step interval', bot.opt.stepMs === 140, String(bot.opt.stepMs));

    console.log('\n== turning the engine off ==');
    clickHandler({ target: { closest: function () { return panel.eMode.children[0]; } } });
    ok('mode is off', bot.mode === 'off');
    ok('the plan is cleared', bot.plan === null && bot.candidates.length === 0);
    ok('the badge goes back to idle', panel.eBadge.textContent === 'idle', panel.eBadge.textContent);
  } finally {
    srv.child.kill('SIGKILL');
  }

  console.log('\n---------------------------------------');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });
