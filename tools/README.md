# tools

Repo-wide tooling that belongs to no single SDK. Anything tied to one language lives
inside that language's SDK instead — the JavaScript assertion harness, for example, is
`sdk/typescript/test-harness.mjs`, because only JavaScript suites can import it.

| file | why it is here and not in an SDK |
|---|---|
| `test-all.mjs` | one entry point for the whole repo: it builds and runs the JavaScript suites, the demos' own runners, and every other SDK's build script that is present (`sdk/java/build.sh` today). It orchestrates languages, so it belongs to none |
| `verify-weights.mjs` | hashes a downloaded checkpoint against the digests Hugging Face publishes for a pinned revision. Every SDK loads that same bundle, so the concern is shared |

Both are written in Node, which is an implementation detail rather than ownership: a Java
or Go user runs `verify-weights.mjs` against the same bundle their SDK will load. If that
becomes a burden, the honest fix is to port it per language — not to move a shared
concern inside one SDK.
