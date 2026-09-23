# The Laya wire algorithm

Every language SDK in this repo hosts the model natively, so every one of them has to
build byte-identical sequences and decode answers identically. This is that contract.

It was derived by reading `@receptron/laya` (`dist/sequence.js`, `dist/laya.js`), which
is itself a port of the checkpoint's `rl_agent_api.py` and states that it matches the
Python reference to ~1e-5. Conformance vectors generated from it live in
`protocol/conformance/`; a port is correct when it reproduces them.

## 0. Artefacts

A checkpoint bundle is five files:

| file | purpose |
|---|---|
| `laya.onnx` + `laya.onnx.data` | the graph and its external weights |
| `laya_config.json` | `max_len`, `head_max_len`, `temperature`, `temperature_by_options` |
| `tokenizer/tokenizer.json` | a HuggingFace tokenizer (WordPiece/BPE) |
| `tokenizer/tokenizer_config.json` | its configuration |

Four special tokens are looked up by name: `[CLS]`, `[SEP]`, `[MASK]`, `[PAD]`.

## 1. Question types

```
choice = 0   score = 1   noul = 2
```

That integer is fed to the model as `qtype`, so the order is load-bearing.

**Normalisation.** A `choice` whose `criteria` is a list becomes a map with null values,
preserving order. `instructions` that is not a string is serialised as JSON (§3).

**Option rendering** — the text scored at each `[MASK]`, in label-index order:

| type | option `i` |
|---|---|
| `choice` | `"key: value"`, or just `"key"` when the value is null/empty |
| `score` | `"level {i}: {criteria[i]}"` |
| `noul` | `["false: {criteria.false ?? 'no, the statement does not hold'}", "true: {criteria.true ?? 'yes, the statement holds'}"]` |

`noul` is always two options in that order, so **`p[1]` is P(true)**.

## 2. Sequence layout

```
[CLS] <type> question: <instructions> [SEP] [MASK] opt0 [MASK] opt1 ... [SEP] <state> [SEP]
```

The position of each option's `[MASK]` is recorded; those are the `marker_pos` the model
scores.

## 3. State serialisation

A string state is used as-is. Anything else is serialised as **Python's
`json.dumps(obj, ensure_ascii=False)`**, which is not the same as most languages' default
JSON encoder:

- separators are `", "` and `": "` — with the spaces
- keys keep **insertion order**, they are not sorted
- non-ASCII is emitted literally, not escaped

Getting this wrong changes the token stream and therefore the answer.

## 4. Building one sequence

Given `max_len` and `head_max_len` from the config:

1. **Scrub.** Replace every literal `[MASK]` in instructions, option text and the
   serialised state with a space, so caller text cannot forge a marker.
2. `head = encode("{type} question: {scrubbed instructions}")`, no special tokens.
3. For each option: `optIds[i] = [MASK] ++ encode(" " + scrubbed option)[:48]`.
4. `optBudget = head_max_len - sum(len(optIds))`.
5. **If `optBudget < 16`** the options are too long or too many:
   `per = max(4, floor((head_max_len - 16) / max(1, nOptions)))`, truncate every
   `optIds[i]` to `per` tokens, then recompute `optBudget`.
6. `head = head[: max(8, optBudget)]`.
7. `seq = [CLS] ++ head ++ [SEP]`. Then for each option, record
   `marker = len(seq)` and append `optIds[i]`. Then append `[SEP]`.
8. `room = max(0, max_len - len(seq) - 1)`;
   `seq ++= encode(scrubbed serialised state)[:room] ++ [SEP]`.
9. Return `seq[:max_len]`, and the markers that are still `< max_len`.

If any marker was dropped, the options did not fit `head_max_len` — that is an error, not
something to paper over.

## 5. Batching

`n` questions about one state become one forward pass. `L` is the longest sequence, `K`
the largest option count.

| input | shape | dtype | contents |
|---|---|---|---|
| `input_ids` | `[n, L]` | int64 | token ids, right-padded with `[PAD]` |
| `attention_mask` | `[n, L]` | int64 | 1 for real tokens, 0 for padding |
| `marker_pos` | `[n, K]` | int64 | marker offsets, 0-padded |
| `marker_mask` | `[n, K]` | bool | true where a marker is real |
| `qtype` | `[n]` | int64 | 0/1/2 per §1 |

Outputs: `logits` float32 `[n, K]` and `act_probs` float32 `[n, *]`.

**The state is re-encoded once per question.** `usage.input_tokens` is the sum of the
sequence lengths across the batch, so cost scales with `questions × state size`, and the
`max_len` limit applies to each sequence individually rather than to the sum.

## 6. Decoding

For row `r` with `k` real options:

1. **Temperature.** `bucket = "{typeName}:{sizeBucket(k)}"` where `sizeBucket` is
   `"2"` for `k<=2`, `"3-5"` for `k<=5`, `"6-10"` for `k<=10`, else `"11+"`.
   Take `temperature_by_options[bucket]`, else `temperature[qtype]`, else `1`.
2. `p = softmax(logits[r][:k] / temperature)` — subtract the max before exponentiating.
3. **Confidence** `= 1 - H(p)/ln(k)` with `H(p) = -Σ p·ln(max(p, 1e-12))`; it is `1` when
   `k < 2`. This is *not* the chosen option's probability, and calling it "confidence"
   has misled more than one caller.
4. Round every reported probability to **4 decimals**, `round(x * 1e4) / 1e4`.

| type | answer |
|---|---|
| `choice` | `choice` = key at `argmax(p)`; `probabilities` keyed by option; `confidence` |
| `score` | `score` = `Σ i·p[i]` (an expectation, so fractional); `legend` = index→criterion; `probabilities` keyed by index as a string; `confidence` |
| `noul` | `noul` = `p[1]` |

Every answer also carries `rl_agent.act_probability = act_probs[r][0]`.

The result is `{ model, answers, usage: { input_tokens, output_tokens: 0 } }`.

## 7. What a port must prove

1. `protocol/conformance/sequences.json` — input → exact token ids and marker offsets.
   Validates tokenisation, scrubbing, truncation and layout **without running the model**.
2. `protocol/conformance/answers.json` — input → exact answers. Validates temperature
   selection, softmax, confidence and rounding end to end.

A port that reproduces both is interchangeable with every other flavour.
