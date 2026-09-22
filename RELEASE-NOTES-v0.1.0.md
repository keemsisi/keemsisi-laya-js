First release: three packages for building decision features on
[Laya](https://huggingface.co/convaiinnovations/laya), the open-source System 1
decision model.

Laya cannot run in a browser — ~1.69 GB of fp32 weights on ONNX Runtime under Node — so
this is a client, a server adapter to stand the endpoint up, and the isomorphic core they
share.

| package | runs where | size packed |
|---|---|---|
| `@laya-js/core` | anywhere, zero dependencies | 19.6 KB |
| `@laya-js/react` | browser / SSR, React 18+ | 11.4 KB |
| `@laya-js/server` | Node 20+ | 11.3 KB |

## Install from this release

```sh
npm i https://github.com/keemsisi/keemsisi-laya-js/releases/download/v0.1.0/laya-js-core-0.1.0.tgz \
      https://github.com/keemsisi/keemsisi-laya-js/releases/download/v0.1.0/laya-js-react-0.1.0.tgz
```

Each tarball ships `dist/`, its `.d.ts` files, a README and an MIT LICENSE. Types resolve
under `strict` + `moduleResolution: nodenext`.

## What it does

- **Typed questions and honest answers.** `choice` / `score` / `noul` builders, and
  readers that never throw — a missing field becomes a reported fallback, not an
  exception three layers up.
- **Gating on the right number.** The chosen option's calibrated probability, not Laya's
  `confidence` field (which is `1 − normalized entropy` over the whole distribution and
  answers a different question).
- **Per-question context budgeting.** Measured on the real checkpoint: token counts scale
  exactly linearly with question count, because the state is re-encoded once per
  question. So the 512-token window limits the largest question, not the batch total.
- **Ordering guarantees in React.** `useDecision` aborts superseded requests and drops
  out-of-order answers, verified under StrictMode and after unmount.
- **Presets by default.** The browser sends a preset name, not questions, so it cannot
  make your model answer anything it likes.

## Verified against the real checkpoint

```
"Refund for the duplicate payment"  -> billing    0.934
"API returns 500 on every order"    -> technical  0.807
"Enterprise pricing for 40 seats"   -> sales      0.860
urgency  calm 0.40 vs panic 2.68      churn  happy 0.17 vs leaving 0.90
```

Inference is deterministic — identical input returns byte-identical output.

## Known limitations

- **ESM only.** `require()` will not load these.
- **Laya is not fast** — ~1s per call on CPU, and cost scales with question count.
- No streaming; Laya is one forward pass.

## Checksums

```
ab88b0f420ff259df193f334989f5b4b0fb259b0ff95662b3eb31cec3abe5534  laya-js-core-0.1.0.tgz
89f692313cfe86806c5c864b161a8787ae889c806e8c710ad2154fef6c2f6ee6  laya-js-react-0.1.0.tgz
f89623614505a0ebbe3f82c5d1ab20798de7210e3ba63441ecd904a499cb05de  laya-js-server-0.1.0.tgz
```
