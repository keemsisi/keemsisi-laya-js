package dev.laya.core;

import ai.djl.huggingface.tokenizers.HuggingFaceTokenizer;
import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtException;
import ai.onnxruntime.OrtSession;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The Laya decision model, running in-process on the JVM.
 *
 * <p>Hands the model a state and any number of typed questions and answers all of them in
 * a single forward pass with calibrated probabilities. No sidecar, no HTTP: this loads
 * {@code laya.onnx} through ONNX Runtime and tokenises with the checkpoint's own
 * tokeniser.
 *
 * <p>Not thread-safe for concurrent {@link #systemOne} calls on one instance - a forward
 * pass holds the session. Guard it, or pool instances, and budget ~2 GB of heap and
 * native memory per instance.
 *
 * <pre>{@code
 * // Ordered: the state is serialised in iteration order, so Map.of - unordered and
 * // salted per JVM - would build a different prompt on every restart.
 * Map<String, Object> state = new LinkedHashMap<>();
 * state.put("subject", "Duplicate charge");
 * state.put("body", "Billed twice for March.");
 *
 * try (Laya laya = Laya.load(Path.of("/path/to/bundle"))) {
 *   var result = laya.systemOne(state,
 *       Map.of("dept", Question.Choice.ofPairs("Which team?",
 *                  "billing", "refunds", "support", "bugs")));
 *   var dept = result.answer("dept", Answer.Choice.class);
 * }
 * }</pre>
 */
public final class Laya implements AutoCloseable {

  private final OrtEnvironment env;
  private final OrtSession session;
  private final HuggingFaceTokenizer tokenizer;
  private final LayaConfig config;
  private final Sequence.SpecialIds ids;
  private final Path modelDir;

  private Laya(OrtEnvironment env, OrtSession session, HuggingFaceTokenizer tokenizer,
               LayaConfig config, Sequence.SpecialIds ids, Path modelDir) {
    this.env = env;
    this.session = session;
    this.tokenizer = tokenizer;
    this.config = config;
    this.ids = ids;
    this.modelDir = modelDir;
  }

  /**
   * Open a checkpoint bundle: {@code laya.onnx}, {@code laya.onnx.data},
   * {@code laya_config.json} and {@code tokenizer/}.
   */
  public static Laya load(Path modelDir) throws IOException, OrtException {
    return load(modelDir, new OrtSession.SessionOptions());
  }

  public static Laya load(Path modelDir, OrtSession.SessionOptions options)
      throws IOException, OrtException {
    Path onnx = modelDir.resolve("laya.onnx");
    Path tokenizerJson = modelDir.resolve("tokenizer/tokenizer.json");
    for (Path required : List.of(onnx, tokenizerJson, modelDir.resolve("laya_config.json"))) {
      if (!Files.exists(required)) {
        throw new IOException("not a Laya bundle: " + required + " is missing");
      }
    }

    LayaConfig config = LayaConfig.read(modelDir.resolve("laya_config.json"));
    Sequence.SpecialIds ids = readSpecialIds(tokenizerJson);
    HuggingFaceTokenizer tokenizer = HuggingFaceTokenizer.newInstance(tokenizerJson);

    OrtEnvironment env = OrtEnvironment.getEnvironment();
    OrtSession session = env.createSession(onnx.toString(), options);
    return new Laya(env, session, tokenizer, config, ids, modelDir);
  }

  /**
   * The four special tokens come from {@code added_tokens}, not the BPE vocabulary -
   * looking only in {@code model.vocab} finds nothing.
   */
  private static Sequence.SpecialIds readSpecialIds(Path tokenizerJson) throws IOException {
    JsonNode root = new ObjectMapper().readTree(Files.readString(tokenizerJson));
    Map<String, Integer> found = new HashMap<>();
    for (JsonNode t : root.path("added_tokens")) {
      found.put(t.path("content").asText(), t.path("id").asInt());
    }
    JsonNode vocab = root.path("model").path("vocab");
    for (String name : List.of("[CLS]", "[SEP]", "[MASK]", "[PAD]")) {
      if (!found.containsKey(name) && vocab.has(name)) found.put(name, vocab.get(name).asInt());
      if (!found.containsKey(name)) {
        throw new IOException("special token " + name + " missing from the tokenizer");
      }
    }
    return new Sequence.SpecialIds(found.get("[CLS]"), found.get("[SEP]"),
                                   found.get("[MASK]"), found.get("[PAD]"));
  }

  /** Tokenise without special tokens; the layout adds its own. */
  int[] encode(String text) {
    // (text, addSpecialTokens, withOverflowingTokens) - the layout adds its own.
    long[] encoded = tokenizer.encode(text, false, false).getIds();
    int[] out = new int[encoded.length];
    for (int i = 0; i < encoded.length; i++) out[i] = (int) encoded[i];
    return out;
  }

  public LayaConfig config() { return config; }

  public Path modelDir() { return modelDir; }

  /** Build the sequence for one question without running the model. */
  public Sequence.Built buildSequence(Object state, Question question) {
    return Sequence.build(this::encode, ids, state, question, config.maxLen(), config.headMaxLen());
  }

  /** Answer every question about {@code state} in one forward pass. */
  public SystemOneResult systemOne(Object state, Map<String, Question> questions) throws OrtException {
    if (questions == null || questions.isEmpty()) {
      throw new IllegalArgumentException("at least one question is required");
    }

    List<String> qids = new ArrayList<>(questions.keySet());
    List<Question> qs = new ArrayList<>(qids.size());
    List<Sequence.Built> built = new ArrayList<>(qids.size());
    int n = qids.size();
    int longest = 0;
    int widest = 0;
    int inputTokens = 0;

    for (String qid : qids) {
      Question q = questions.get(qid);
      Sequence.Built b = buildSequence(state, q);
      if (b.markers().length != q.renderOptions().size()) {
        throw new IllegalArgumentException("question \"" + qid + "\": options do not fit head_max_len="
            + config.headMaxLen() + " tokens");
      }
      qs.add(q);
      built.add(b);
      longest = Math.max(longest, b.ids().length);
      widest = Math.max(widest, b.markers().length);
      inputTokens += b.ids().length;
    }

    long[][] inputIds = new long[n][longest];
    long[][] attention = new long[n][longest];
    long[][] markerPos = new long[n][widest];
    boolean[][] markerMask = new boolean[n][widest];
    long[] qtype = new long[n];

    for (int i = 0; i < n; i++) {
      int[] seq = built.get(i).ids();
      for (int j = 0; j < longest; j++) {
        inputIds[i][j] = j < seq.length ? seq[j] : ids.pad();
        attention[i][j] = j < seq.length ? 1L : 0L;
      }
      int[] markers = built.get(i).markers();
      for (int j = 0; j < markers.length; j++) {
        markerPos[i][j] = markers[j];
        markerMask[i][j] = true;
      }
      qtype[i] = qs.get(i).qtype();
    }

    Map<String, Answer> answers = new LinkedHashMap<>();
    try (OnnxTensor tIds = OnnxTensor.createTensor(env, inputIds);
         OnnxTensor tAttn = OnnxTensor.createTensor(env, attention);
         OnnxTensor tPos = OnnxTensor.createTensor(env, markerPos);
         OnnxTensor tMask = OnnxTensor.createTensor(env, markerMask);
         OnnxTensor tType = OnnxTensor.createTensor(env, qtype);
         OrtSession.Result out = session.run(Map.of(
             "input_ids", tIds,
             "attention_mask", tAttn,
             "marker_pos", tPos,
             "marker_mask", tMask,
             "qtype", tType))) {

      float[][] logits = (float[][]) out.get("logits")
          .orElseThrow(() -> new OrtException("model produced no logits")).getValue();
      float[][] actProbs = (float[][]) out.get("act_probs")
          .orElseThrow(() -> new OrtException("model produced no act_probs")).getValue();

      for (int r = 0; r < n; r++) {
        Question q = qs.get(r);
        int k = built.get(r).markers().length;
        double temperature = config.temperatureFor(q.qtype(), k);

        double[] scaled = new double[k];
        for (int i = 0; i < k; i++) scaled[i] = logits[r][i] / temperature;
        double[] p = Sequence.softmax(scaled);
        double act = actProbs[r].length > 0 ? actProbs[r][0] : 0.0;
        double confidence = Sequence.round4(Sequence.confidence(p));

        answers.put(qids.get(r), decode(q, p, confidence, act));
      }
    }

    return new SystemOneResult("laya", answers, inputTokens, 0);
  }

  private static Answer decode(Question q, double[] p, double confidence, double act) {
    if (q instanceof Question.Choice c) {
      List<String> keys = c.keys();
      int best = 0;
      for (int i = 1; i < p.length; i++) if (p[i] > p[best]) best = i;
      Map<String, Double> probs = new LinkedHashMap<>();
      for (int i = 0; i < keys.size() && i < p.length; i++) {
        probs.put(keys.get(i), Sequence.round4(p[i]));
      }
      return new Answer.Choice(keys.get(best), probs, confidence, act);
    }
    if (q instanceof Question.Score s) {
      double expected = 0;
      for (int i = 0; i < p.length; i++) expected += i * p[i];
      Map<String, String> legend = new LinkedHashMap<>();
      for (int i = 0; i < s.levels().size(); i++) legend.put(String.valueOf(i), s.levels().get(i));
      Map<String, Double> probs = new LinkedHashMap<>();
      for (int i = 0; i < p.length; i++) probs.put(String.valueOf(i), Sequence.round4(p[i]));
      return new Answer.Score(Sequence.round4(expected), legend, probs, confidence, act);
    }
    return new Answer.Noul(Sequence.round4(p.length > 1 ? p[1] : 0.0), act);
  }

  @Override
  public void close() throws OrtException {
    session.close();
    tokenizer.close();
  }
}
