# laya-core (JVM)

The Laya decision model running **in-process on the JVM** — no sidecar, no HTTP. Loads
`laya.onnx` through ONNX Runtime and tokenises with the checkpoint's own tokeniser.

```java
// Ordered, because the state is serialised in iteration order and that order is part
// of the prompt. Map.of is unordered and salted per JVM, so it would build a different
// prompt on every restart.
Map<String, Object> state = new LinkedHashMap<>();
state.put("subject", "Duplicate charge");
state.put("body", "Billed twice for March.");

try (Laya laya = Laya.load(Path.of("/path/to/bundle"))) {
  var result = laya.systemOne(state,
      Map.of("dept", Question.Choice.ofPairs("Which team should handle this?",
                 "billing", "refunds and invoices",
                 "support", "bugs")));

  Answer.Choice dept = result.answer("dept", Answer.Choice.class);
  dept.choice();                // "billing"
  dept.probabilityOfChoice();   // 0.9415 — the number to gate on
  dept.confidence();            // 1 - H(p)/ln k, a property of the whole distribution
}
```

## Correctness

Validated against `protocol/conformance/`, generated from the reference implementation:
**138 assertions, covering Python `json.dumps` parity, the API invariants that cost
correctness silently, exact token ids and marker offsets for 13 awkward cases, and
decoded answers end to end against the real checkpoint.**

```sh
./build.sh          # fetches jars, compiles, runs the conformance vectors
```

The three levels are separable on purpose, so a failure tells you *where* a port diverged:
serialisation (no tokeniser), layout (tokeniser, no model), answers (everything).

## Three things that bite

**`confidence` is not the chosen option's probability.** It is `1 - H(p)/ln k` over the
whole distribution. Threshold on `probabilityOfChoice()` when you mean "how sure is this
pick" — `Answer.Choice` exposes both so the distinction is hard to miss.

**Number formatting follows JavaScript, not Java.** `Double.toString` renders
`12345678.5` as `1.23456785E7` and `Double.MIN_VALUE` as `4.9E-324`; the reference gives
`12345678.5` and `5e-324`. Since the serialised state is tokenised, that difference would
change the prompt, so `PyJson` implements ECMAScript's shortest-round-trip formatting -
verified digit-for-digit against the reference across 27 awkward values.

**The state is encoded once per question.** A three-question call is three sequences, so
`inputTokens` is their sum and cost grows with question count as well as state size. The
`max_len` limit applies per sequence, not to the total.

## Memory and threading

Budget ~2 GB of heap and native memory per instance. A forward pass holds the session, so
one instance does not serve concurrent `systemOne` calls — guard it or pool instances.

## Building

`mvn test` runs the conformance vectors through `ConformanceTest`, which skips the
model-dependent levels when no checkpoint is cached. Point it at one explicitly with
`-Dlaya.model=/path/to/bundle`.

Maven is the supported route for consumers (`pom.xml` declares everything). `build.sh`
exists because on some machines the `java` binary cannot reach Maven Central even when
`curl` can, which makes `mvn` unusable; it fetches the same artifacts with curl and drives
`javac` directly.

DJL ships tokenizer natives for linux and windows only and downloads the macOS one at
runtime — which also fails without java networking. `build.sh` seeds DJL's cache so
`-Dai.djl.offline=true` works.
