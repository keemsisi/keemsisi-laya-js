# laya-js

JavaScript packages for **[Laya](https://huggingface.co/convaiinnovations/laya)**, the
open-source System 1 decision model by Convai Innovations — a React client, a Node server
adapter, and the isomorphic core they share.

```
npm install          # dev tooling only; the model is not installed
npm test             # 352 assertions + 2 typechecks, no model needed
npm run example      # ticket triage demo, needs --fake or a real model
```

---

## Read this first: Laya cannot run in a browser

Laya is not a text generator and not a client-side model. It is a bidirectional encoder
(ModernBERT-large, 421M parameters) with a decision head, it runs on ONNX Runtime under
Node, and its weights are **~1.7 GB of fp32**. `@receptron/laya` ships no
`onnxruntime-web` build, and ~287 MB of native ONNX binaries plus 1.7 GB of weights is
not something a page downloads.

So there is no "React component that runs Laya". What there *is*:

```
  ┌──────── browser ────────┐        ┌─────────── your node server ───────────┐
  │  @laya-js/react         │        │  @laya-js/server                       │
  │   <LayaProvider>        │  POST  │   presets, validation, token budget,   │
  │   useDecision()         │ ─────▶ │   one-at-a-time inference              │
  │   <ChoiceBreakdown>     │ ◀───── │            │                           │
  └─────────────────────────┘        │            ▼  @receptron/laya          │
              │                      │         the model (1.7 GB)             │
              └── @laya-js/core ─────┴────────────────────────────────────────┘
                  types · readers · budgeting · fetch client
```

| package | runs where | what it is |
|---|---|---|
| `@laya-js/core` | anywhere | Laya's types, question builders, defensive answer readers, context budgeting, and a fetch client that never throws. Zero dependencies. |
| `@laya-js/react` | browser / SSR | `<LayaProvider>`, `useDecision`, `useDecisionCallback`, and three unstyled components. React 18+. |
| `@laya-js/server` | Node 20+ | Turns a Laya checkpoint into an HTTP endpoint for `node:http`, Express, Next.js, Hono or Bun. |

## Quick start

**1. Serve a decision endpoint.** Questions live here, not in the browser:

```js
import { createLayaServer } from '@laya-js/server';
import { choice, score, noul } from '@laya-js/core';

const laya = createLayaServer({
  presets: {
    triage: {
      department: choice('Which team should handle this ticket?', {
        billing: 'invoices, payments, refunds',
        technical: 'bugs, outages, API errors',
        sales: 'pricing, plans, new contracts'
      }),
      urgency: score('How urgent is this ticket?', ['not urgent', 'somewhat', 'urgent', 'critical']),
      churn: noul('Is this customer likely to cancel or dispute?')
    }
  },
  // Pin the weights to a published commit rather than tracking "main".
  revision: 'a1b2c3d…',
  eager: true
});

http.createServer((req, res) => {
  if (req.url.startsWith('/laya/')) return laya.handler(req, res);
  // ...your app
}).listen(3000, '127.0.0.1');
```

Next.js App Router instead:

```ts
// app/laya/[...path]/route.ts
const laya = createLayaServer({ presets });
export const POST = (req: Request) => laya.fetchHandler(req);
export const GET  = (req: Request) => laya.fetchHandler(req);
```

**2. Decide in React.** Import the same question set the server registered and pass it as
`shape` — it is never sent, it types the readings and supplies the rubric labels:

```tsx
import { LayaProvider, useDecision, ChoiceBreakdown, ScoreMeter } from '@laya-js/react';
import { triage } from './presets.mjs';           // shared with the server

function App() {
  return <LayaProvider endpoint="" floor={0.34}><Triage /></LayaProvider>;
}

function Triage() {
  const ticket = useDebounced(draft, 400);           // don't ask per keystroke
  const { loading, readings, gates, error } = useDecision(
    { state: ticket, preset: 'triage' },
    { enabled: ticket.subject.length > 3, shape: triage }
  );

  if (error) return <p>{error.code}: {error.error}</p>;
  if (loading || !readings) return <p>deciding…</p>;

  return (
    <>
      <h3>Route to {readings.department.value}</h3>
      {!gates.department.accepted && <span>needs a human — {gates.department.reason}</span>}
      <ChoiceBreakdown reading={readings.department} />
      <ScoreMeter reading={readings.urgency} levels={['not urgent','somewhat','urgent','critical']} />
    </>
  );
}
```

## TypeScript

All three packages are written in TypeScript and ship `.d.ts`. The types do real work
rather than just existing:

```ts
const { readings, gates } = useDecision({ state, questions: triage });

readings.department.value    // string   - ChoiceReading, no narrowing needed
readings.urgency.label       // string|null - ScoreReading, labelled from the rubric
readings.churn.isTrue        // boolean  - NoulReading
readings.department.isTrue   // compile error: a choice reading has no isTrue
gates.urgency                // compile error: score questions have no gate
useDecision({ state })       // compile error: neither questions nor a preset
```

`readAll` maps each question to `ReadingFor<Q>`, so `readings` is keyed and typed by
question instead of being a `Reading` union you have to narrow by `kind`. With a preset,
pass `shape` and `Q` is inferred from it; without one, readings are still parsed from
each answer's own `type` field, just as the untyped union.

`tests/types/consumer.tsx` compiles the public API the way a consumer would, and asserts
the **negative** cases with `@ts-expect-error` — tsc fails on an unused directive, so a
type that stops rejecting bad usage breaks the build. The example app is typechecked
separately under `strict`, because esbuild strips types without checking them.

## What these packages get right

Laya returns **calibrated** probabilities, which is the whole point of using it — so the
packages are built around not throwing that away.

- **Gating, not just the winner.** `readings` carry the chosen option *and* the
  distribution; `gates` apply a probability floor, as Laya's own docs recommend, so a
  low-confidence answer can be escalated instead of acted on. The gate uses the chosen
  option's probability — **not** Laya's `confidence` field, which is `1 − normalized
  entropy` over the whole distribution and answers a different question.
- **Health never overstates the model.** `model` is the id the checkpoint reported on its
  last answer, so an injected stub cannot inherit a hardcoded name; `modelSource` says
  what was configured (`receptron/laya-onnx@main (unpinned)`, a local dir, or
  `injected (custom load)`) and is known before the first answer.
- **A fallback never borrows confidence.** If the model names an option that wasn't
  offered, the reading falls back and reports probability `0`, never the fallback
  option's number from the distribution.
- **The context window is budgeted per question, because that is how Laya works.**
  Measured on the real checkpoint, `usage.input_tokens` scales exactly linearly with the
  number of questions (112/224/336 for 1/2/3 over one state): the state is re-encoded
  once per question. So the 512-token window limits the **largest single question**, not
  the batch total, and cost scales with `questions x state size`. `estimateTokenBreakdown`
  reports both; the server budgets the largest and refuses with `too_large` or trims in an
  order you configure. Budgeting the total instead - which this package did until the
  numbers were measured - rejects prompts that fit perfectly well.
- **Nothing throws.** A decision is an input to a product decision, so every failure —
  missing model, dead endpoint, timeout, cancelled request — arrives as
  `{ ok: false, code }` with one of eight codes. The client has no rejection path.
- **Superseded answers are dropped.** `useDecision` aborts the previous request on input
  change and ignores out-of-order responses, so a slow answer can never overwrite a
  newer one. Verified under `StrictMode` and after unmount.
- **Ad-hoc questions are off by default.** An open prompt endpoint lets a browser make
  your model answer anything. Presets keep question construction server-side;
  `allowAdHoc: true` is a deliberate opt-in.
- **One forward pass at a time.** The model holds a single ONNX session, so decisions are
  serialized and `maxQueue` sheds load rather than piling up.

## API

**core** — `choice` `score` `noul` `optionsOf` `validateQuestions` `validateState`
`readChoice` `readScore` `readNoul` `readAnswer` `readAll` `readAnswersByType` `gate`
`estimateTokens` `estimateTokenBreakdown` `estimateContextTokens` `fitToContext`
`defaultBudget` `CONTEXT_TOKENS` `createClient`, plus every Laya type.

**react** — `LayaProvider` `useLaya` `useOptionalLaya` `useDecision`
`useDecisionCallback` `Decision` `ChoiceBreakdown` `ScoreMeter`. Core is re-exported, so
one import is usually enough.

**server** — `createLayaServer` → `{ health, decide, handler, fetchHandler, warmup, close }`,
and `loadReceptronLaya` if you want to hold the model yourself.

Error codes: `unavailable` `bad_request` `forbidden` `too_large` `timeout` `aborted`
`unreachable` `internal`.

## The example

```
node examples/ticket-triage/build.mjs
node examples/ticket-triage/server.mjs --fake   # stub model, fully usable offline
LAYA=1 node examples/ticket-triage/server.mjs   # the real checkpoint
```

The stub reports its model name as `stub-not-laya` and the UI displays that name, so a
demo can never be mistaken for the real model.

## Security notes

Audited before anything was added (`npm audit`, `npm audit signatures`, plus reading the
install scripts):

- 0 known vulnerabilities. All packages carry integrity hashes and verified registry
  signatures; nothing resolves off the official registry.
- The dev tooling runs **one** install-time script: `esbuild`'s `postinstall`, which uses
  the integrity-checked `@esbuild/darwin-arm64` optional dependency. The `prepare`
  scripts in `jsdom`/`whatwg-*` do not run for registry tarballs.
- Enabling the model pulls `onnxruntime-node` (Microsoft, 287 MB unpacked, bundles native
  binaries for 5 platforms; its `postinstall` downloads nothing on macOS arm64) and
  `@huggingface/tokenizers` (pure JS, no native code, no dependencies, no scripts).
  `@receptron/laya` itself has no install scripts.
- **The weight download is not checksummed.** `ensureBundle` compares only byte counts
  against the remote file, so a tampered response of the right size would not be caught,
  and npm's integrity hashes do not cover it. Pass `revision: '<commit sha>'` to bind the
  download to a published commit instead of tracking `main`.
- `createLayaServer` sends no CORS headers unless you set `cors`, and the example binds
  loopback only, because `/laya/decide` has no authentication of its own. Put it behind
  your app's auth before exposing it.

## Testing

```
npm test        # build -> typecheck consumers -> bundle -> run every suite
```

344 assertions across five suites, plus two typechecks:

| suite | what it covers |
|---|---|
| `core` | readers (including answers read without their questions), budgeting, trimming order, immutability |
| `core/client` | every HTTP status → error code, timeouts, caller aborts, hostile transports, "nothing ever throws" |
| `server` | presets, ad-hoc refusal, validation, budget refusal and trimming, load/inference failure, serialized inference, queue shedding, both handlers over real HTTP |
| `react` | loading → success, gating, typed vs. shapeless readings, re-asking only on real change, cancel, **stale-response ordering**, StrictMode, unmount, SSR |
| `app (jsdom)` | the **real esbuild bundle** running in jsdom against the **real server** over HTTP: mount, badge honesty, distribution rendering, meter accessibility, sample switching, debounce, and honest degradation when the endpoint is killed mid-session |

Nothing in the suite needs the 1.7 GB checkpoint — the model is injectable through
`LayaServerOptions.load`, which is why the whole stack is testable.

## Verified on the real checkpoint

`packages/server/test/real-model.test.mjs` loads the actual 1.69 GB bundle — 42
assertions, all passing. It skips itself unless the bundle is cached, so `npm test`
never starts a download.

```
"Refund for the duplicate payment"  -> billing    {billing:0.934, technical:0.025, sales:0.019, other:0.023}
"API returns 500 on every order"    -> technical  {technical:0.807, billing:0.075, sales:0.061, other:0.057}
"Enterprise pricing for 40 seats"   -> sales      {sales:0.860, billing:0.061, technical:0.028, other:0.051}
urgency  calm 0.40  vs  panic 2.68          (rubric 0-3)
churn    happy 0.17 vs  leaving 0.90        (P(true))
inference ~1.0s per call on an M-series CPU, fp32
```

It also confirms the properties the design leans on: answers match the published types,
probabilities form a distribution summing to 1, the chosen option is the argmax, and
inference is **deterministic** — the same input returns byte-identical output, because
Laya is non-autoregressive and does not sample.

## Limitations
- **Laya is not fast.** About 1s per call on a CPU for a typical prompt, and cost scales
  with the number of questions. Debounce user input, ask for what you need in one call,
  and keep the state terse — it is re-encoded per question.
- `useDecision` identifies a request by `JSON.stringify` of its input. Unserializable
  state falls back to re-asking on every change; pass `key` to control it.
- A preset request without `shape` yields readings parsed from each answer's own type:
  usable, but a choice is not validated against the offered options and a score has no
  rubric label. Pass `shape` when you can.
- `LayaContextValue.engine` reflects the last completed health probe, not the client's
  view after every decision. Call `refreshHealth()` to re-probe.
- No streaming, because Laya does not stream — it is one forward pass.
- The three components are unstyled by design; class names are the styling surface.
