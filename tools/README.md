# tools

Repo-wide development tooling. **All Node**, because that is what the repo's own test
runner and the reference implementation use — none of it is a dependency of any SDK.

| file | scope |
|---|---|
| `test-all.mjs` | builds, typechecks and runs every JavaScript suite plus the demos' own runners. Each non-JS SDK owns its build: `sdk/java/build.sh` |
| `verify-weights.mjs` | hashes a downloaded checkpoint against the digests Hugging Face publishes for a pinned revision. The concern is language-neutral — every SDK loads the same bundle — but the implementation is Node |
| `harness.mjs` | the assertion harness the JavaScript suites share. JavaScript only: `sdk/java` uses its own, since a Java port cannot import this one |

If you are adding an SDK, nothing here is required. Add your own build and test entry
point under `sdk/<language>/`, and have it read `protocol/conformance/`.
