/**
 * End-to-end test of the built React application.
 *
 * Runs the real esbuild bundle inside jsdom, against the real example
 * server over real HTTP. No React internals are stubbed and no module is
 * mocked - the only stand-in is the model itself (`--fake`), which is the
 * one thing that needs 1.7 GB.
 *
 *   node test/app.test.mjs
 */
import { ok, eq, section, summary } from '../../../scripts/harness.mjs';
import { spawn } from 'node:child_process';
import { JSDOM, VirtualConsole } from 'jsdom';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

function startServer(extraArgs = []) {
  const child = spawn(process.execPath, [path.join(root, 'server.mjs'), '--fake', ...extraArgs], {
    cwd: root,
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += b; });
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (b) => {
      out += b;
      const m = out.match(/ticket triage\s+http:\/\/localhost:(\d+)\//);
      if (m) resolve({ child, port: Number(m[1]) });
    });
    child.on('exit', (c) => reject(new Error('server exited ' + c + ': ' + stderr)));
    setTimeout(() => reject(new Error('server did not start: ' + stderr)), 8000);
  });
}

/** Poll the DOM until `fn()` is truthy. Returns null on timeout. */
async function waitFor(fn, { timeout = 4000, interval = 25 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let v;
    try { v = fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, interval));
  }
}

/** React tracks input values on the node, so set through the native setter. */
function typeInto(win, input, value) {
  const proto = value === undefined ? null : Object.getPrototypeOf(input);
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter ? setter.call(input, value) : (input.value = value);
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
}

function click(win, el) {
  el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
}

const srv = await startServer();
const base = 'http://127.0.0.1:' + srv.port;
let dom;

try {
  section('the server serves the built app');
  const htmlRes = await fetch(base + '/');
  const html = await htmlRes.text();
  ok('index.html is served', htmlRes.status === 200 && /<div id="root">/.test(html));
  const jsRes = await fetch(base + '/app.js');
  const bundle = await jsRes.text();
  ok('the bundle is served', jsRes.status === 200 && bundle.length > 100_000, String(bundle.length));
  ok('the bundle is not an es module', !/^\s*import\s.+from/m.test(bundle));
  ok('the page loads the bundle with a plain script tag', /<script src="\/app\.js">/.test(html));

  section('booting the real bundle in a dom');
  const virtualConsole = new VirtualConsole();
  const consoleErrors = [];
  virtualConsole.on('jsdomError', (e) => consoleErrors.push('jsdomError: ' + e.message));
  virtualConsole.on('error', (...args) => consoleErrors.push('console.error: ' + args.join(' ')));

  dom = new JSDOM(html.replace('<script src="/app.js"></script>', ''), {
    url: base + '/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole
  });
  const win = dom.window;
  const doc = win.document;

  // Node's fetch and abort primitives: jsdom has no fetch, and Node's fetch
  // rejects a foreign AbortSignal, so both must come from the same realm.
  win.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    return fetch(new URL(url, base), init);
  };
  win.AbortController = AbortController;
  win.AbortSignal = AbortSignal;
  win.DOMException = DOMException;
  win.queueMicrotask = queueMicrotask;
  win.MessageChannel = MessageChannel;
  win.TextEncoder = TextEncoder;
  win.TextDecoder = TextDecoder;

  const script = doc.createElement('script');
  script.textContent = bundle;
  doc.body.appendChild(script);

  ok('the app mounted', await waitFor(() => doc.querySelector('main')) !== null);
  ok('it rendered the heading', doc.querySelector('h1')?.textContent === 'Ticket triage', doc.querySelector('h1')?.textContent);
  ok('the bundle threw nothing on boot', consoleErrors.length === 0, consoleErrors.join(' | '));

  section('the engine badge reflects the real endpoint');
  const badge = await waitFor(() => {
    const b = doc.querySelector('.badge');
    return b && b.textContent === 'engine ready' ? b : null;
  });
  ok('the badge reports the engine as ready', badge !== null, doc.querySelector('.badge')?.textContent);
  // Before the model has answered, the badge shows the configured source
  // ("injected (custom load)"); afterwards, the id it reported. Either way
  // it must be plainly not the real checkpoint, and styled as such.
  const modelBadge = await waitFor(() => {
    const badges = [...doc.querySelectorAll('.badge')];
    return badges.find((b) => /stub-not-laya|injected/.test(b.textContent)) ?? null;
  });
  ok('the stub is named honestly in the ui, not shown as laya', modelBadge !== null,
     [...doc.querySelectorAll('.badge')].map((b) => b.textContent).join(','));
  ok('and is flagged rather than shown as a healthy model',
     modelBadge?.className.includes('badge-unavailable'), modelBadge?.className);
  ok('no badge claims to be laya', ![...doc.querySelectorAll('.badge')]
     .some((b) => /^convaiinnovations|laya-english/.test(b.textContent.trim())),
     [...doc.querySelectorAll('.badge')].map((b) => b.textContent).join(','));
  ok('the preset is advertised', /presets: triage/.test(doc.body.textContent));

  section('the first decision renders');
  const answer = await waitFor(() => {
    const el = doc.querySelector('.answer');
    return el && el.textContent.trim().length > 0 ? el : null;
  });
  ok('an answer appeared', answer !== null, doc.querySelector('.card-head')?.textContent);
  ok('the billing sample routed to billing', /billing/.test(answer.textContent), answer.textContent);
  ok('the meta line names the model and timing',
     /stub-not-laya/.test(doc.body.textContent) && /ms/.test(doc.body.textContent));
  ok('the token estimate is shown', /tokens/.test(doc.body.textContent));

  const rows = doc.querySelectorAll('.laya-breakdown-row');
  ok('the distribution is rendered, not just the winner', rows.length === 4, String(rows.length));
  ok('the chosen option is marked', doc.querySelectorAll('.laya-breakdown-row[data-chosen]').length === 1);
  ok('probabilities are shown', /0\.72/.test(doc.body.textContent), doc.querySelector('.laya-breakdown-value')?.textContent);
  ok('the bar width is driven by the probability',
     /--laya-p/.test(doc.querySelector('.laya-breakdown-bar')?.getAttribute('style') ?? ''),
     doc.querySelector('.laya-breakdown-bar')?.getAttribute('style'));

  const meter = doc.querySelector('[role="meter"]');
  ok('the urgency meter is accessible', meter !== null && meter.getAttribute('aria-valuenow') !== null,
     meter?.getAttribute('aria-valuenow'));
  ok('the meter is labelled from the rubric',
     /not urgent|somewhat|urgent|critical/.test(meter?.getAttribute('aria-valuetext') ?? ''),
     meter?.getAttribute('aria-valuetext'));
  ok('churn risk is rendered as a probability', /p=0\.\d\d/.test(doc.body.textContent));

  section('switching sample tickets re-decides');
  const churnButton = [...doc.querySelectorAll('button.ghost')].find((b) => /Cancelling/.test(b.textContent));
  ok('the churn sample button exists', churnButton !== undefined);
  click(win, churnButton);
  const churned = await waitFor(() => (/p=0\.83/.test(doc.body.textContent) ? true : null), { timeout: 5000 });
  ok('the new ticket produces a new decision', churned === true, doc.querySelector('.answers')?.textContent?.slice(0, 120));
  ok('it routed the outage complaint to technical', /technical/.test(doc.querySelector('.answer').textContent),
     doc.querySelector('.answer').textContent);
  ok('churn is now reported as likely', /likely/.test(doc.body.textContent) && !/unlikely · p=0\.83/.test(doc.body.textContent));

  section('typing is debounced');
  const healthBefore = await (await fetch(base + '/laya/health')).json();
  const subject = doc.querySelector('input');
  ok('the subject input is present', subject !== null);
  typeInto(win, subject, 'Refund my duplicate invoice charge');
  await new Promise((r) => setTimeout(r, 120));
  const midHealth = await (await fetch(base + '/laya/health')).json();
  ok('no decision is asked mid-typing', midHealth.calls === healthBefore.calls,
     healthBefore.calls + ' -> ' + midHealth.calls);
  const settled = await waitFor(async () => true, { timeout: 500 });
  void settled;
  await new Promise((r) => setTimeout(r, 600));
  const afterHealth = await (await fetch(base + '/laya/health')).json();
  ok('one decision is asked once typing settles', afterHealth.calls === healthBefore.calls + 1,
     healthBefore.calls + ' -> ' + afterHealth.calls);
  ok('the refreshed answer routes to billing',
     await waitFor(() => (/billing/.test(doc.querySelector('.answer').textContent) ? true : null)) === true,
     doc.querySelector('.answer').textContent);

  section('a short subject holds the decision back');
  const callsBeforeClear = (await (await fetch(base + '/laya/health')).json()).calls;
  typeInto(win, subject, 'ab');
  await new Promise((r) => setTimeout(r, 700));
  const callsAfterClear = (await (await fetch(base + '/laya/health')).json()).calls;
  ok('a too-short subject asks nothing', callsAfterClear === callsBeforeClear,
     callsBeforeClear + ' -> ' + callsAfterClear);
  ok('the waiting state is shown', /waiting for a subject/.test(doc.body.textContent));

  section('the ui degrades honestly when the endpoint dies');
  srv.child.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 200));
  typeInto(win, subject, 'The API is returning 500 on every order call');
  const errored = await waitFor(() => (doc.querySelector('.error') ? doc.querySelector('.error') : null), { timeout: 6000 });
  ok('an error block appears', errored !== null, doc.querySelector('.card-head')?.textContent);
  ok('it names the failure code', /unreachable|timeout|internal/.test(errored.querySelector('strong').textContent),
     errored.querySelector('strong')?.textContent);
  ok('it does not show a stale answer alongside the error', doc.querySelector('.answers') === null);
  ok('the badge stops claiming the engine is ready',
     await waitFor(() => (doc.querySelector('.badge').textContent !== 'engine ready' ? true : null), { timeout: 8000 }) === true,
     doc.querySelector('.badge')?.textContent);
  ok('no unhandled react error was logged', consoleErrors.filter((e) => /jsdomError/.test(e)).length === 0,
     consoleErrors.join(' | '));
} finally {
  try { srv.child.kill('SIGKILL'); } catch { /* already dead */ }
  try { dom?.window.close(); } catch { /* ignore */ }
}

// jsdom's health-poll interval and any in-flight request keep the loop
// alive, so exit on the summary's verdict rather than waiting them out.
const { fail } = summary();
process.exit(fail ? 1 : 0);
