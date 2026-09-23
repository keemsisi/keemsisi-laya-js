# protocol

**Language-neutral.** This directory belongs to no SDK — it is the contract every SDK is
tested *against*, which is why it sits beside `sdk/` rather than inside it.

| path | what it is |
|---|---|
| `SPEC.md` | the wire algorithm, written to be implementable without reading any existing port |
| `conformance/*.json` | the vectors a port must reproduce: token ids and marker offsets, decoded answers, and Python `json.dumps` parity |
| `tools/gen-conformance.mjs` | regenerates those vectors from the reference implementation |
| `measurements/` | the scripts that produced the numbers quoted in `SPEC.md` |

## Why the tooling here is Node

`gen-conformance.mjs` and `measurements/` are JavaScript for one reason: the reference
implementation they read (`@receptron/laya`) is. They generate and justify
language-neutral artefacts — no SDK depends on them at build or run time, and a port in
any language only ever consumes the `.json`.

`measurements/` is kept because `SPEC.md` makes claims with numbers attached — that token
counts scale linearly with question count, that one question costs ~0.4s against ~2.6s for
three. These are the scripts that measured that, so the claims can be re-checked rather
than taken on trust.

## Adding a language

A port is finished when it reproduces `conformance/`. Start with
`state-serialisation.json` (no tokeniser needed), then `sequences.json` (tokeniser, no
model), then `answers.json` (everything). `sdk/java` follows exactly that order, and its
failures name which level diverged.
