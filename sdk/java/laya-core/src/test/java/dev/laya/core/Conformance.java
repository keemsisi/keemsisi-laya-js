package dev.laya.core;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Checks this port against the vectors in {@code protocol/conformance/}, which were
 * generated from the reference implementation.
 *
 * <p>Three levels, deliberately separable so a failure says where the port diverged:
 * state serialisation (no tokeniser), sequence layout (tokeniser, no model), and decoded
 * answers (the whole pipeline). Run without the checkpoint and the third is skipped.
 *
 * <pre>java -cp ... dev.laya.core.Conformance &lt;protocol/conformance dir&gt; [model dir]</pre>
 */
public final class Conformance {

  private static int passed = 0;
  private static int failed = 0;
  private static final ObjectMapper JSON = new ObjectMapper();

  /** Counts from one run, so a caller can assert on them instead of an exit code. */
  public record Result(int passed, int failed) {}

  public static void main(String[] args) throws Exception {
    if (args.length < 1) {
      System.err.println("usage: Conformance <conformance-dir> [model-dir]");
      System.exit(2);
    }
    Result r = run(Path.of(args[0]), args.length > 1 ? Path.of(args[1]) : null);
    System.out.println("\n---------------------------------------");
    System.out.println(r.passed() + " passed, " + r.failed() + " failed");
    if (r.failed() > 0) System.exit(1);
  }

  /**
   * Run every level the inputs allow. A null {@code modelDir} runs the vectors that do
   * not need a checkpoint. Returns counts rather than exiting, so JUnit can drive it.
   */
  public static Result run(Path dir, Path modelDir) throws Exception {
    passed = 0;
    failed = 0;

    section("state serialisation (Python json.dumps parity)");
    stateSerialisation(dir.resolve("state-serialisation.json"));

    section("API invariants");
    invariants();

    if (modelDir == null) {
      System.out.println("\nno model directory given - skipping sequence and answer vectors");
      return new Result(passed, failed);
    }

    try (Laya laya = Laya.load(modelDir)) {
      section("sequence layout (token ids and marker offsets)");
      sequences(dir.resolve("sequences.json"), laya);

      Path answers = dir.resolve("answers.json");
      if (Files.exists(answers)) {
        section("decoded answers (end to end)");
        answers(answers, laya);
      }
    }
    return new Result(passed, failed);
  }

  /** Traps that cost correctness rather than throwing loudly. */
  private static void invariants() {
    // Option order is part of the prompt, so the ordered factory must preserve
    // exactly what the caller wrote. Map.of does not, and its order varies between
    // JVM runs, which would make prompts irreproducible.
    Question.Choice ordered = Question.Choice.ofPairs("Which team?",
        "billing", "refunds", "support", "bugs", "sales", "pricing", "other", null);
    check("ordered factory preserves the written order",
          ordered.keys().equals(List.of("billing", "support", "sales", "other")),
          ordered.keys().toString());
    check("a null description renders as the bare key",
          ordered.renderOptions().get(3).equals("other"),
          ordered.renderOptions().toString());
    check("odd argument count is rejected", throwsIAE(() ->
              Question.Choice.ofPairs("x", "only-a-key")), "no exception");

    // A null inside a state array used to throw, taking the whole decision with it.
    Map<String, Object> withNull = new LinkedHashMap<>();
    withNull.put("items", new Object[] {1, null, "x"});
    check("null inside a state array serialises",
          PyJson.serialiseState(withNull).equals("{\"items\": [1, null, \"x\"]}"),
          PyJson.serialiseState(withNull));

    Map<String, Object> primitives = new LinkedHashMap<>();
    primitives.put("n", new int[] {1, 2, 3});
    check("primitive arrays serialise",
          PyJson.serialiseState(primitives).equals("{\"n\": [1, 2, 3]}"),
          PyJson.serialiseState(primitives));

    // Double.toString would write these as 1.23456785E7 / 1.0E-4 / 1.0E-8 / NaN, none of
    // which the reference emits - and the state goes straight into the token stream.
    Map<String, Object> numbers = new LinkedHashMap<>();
    numbers.put("big", 12345678.5);
    numbers.put("small", 0.0001);
    numbers.put("tiny", 1e-8);
    numbers.put("whole", 1.0);
    numbers.put("nan", Double.NaN);
    check("doubles serialise as the reference does",
          PyJson.serialiseState(numbers).equals(
              "{\"big\": 12345678.5, \"small\": 0.0001, \"tiny\": 1e-8, \"whole\": 1, \"nan\": null}"),
          PyJson.serialiseState(numbers));

    // noul is always false-then-true, so p[1] is P(true).
    Question.Noul noul = new Question.Noul("Likely to cancel?");
    check("noul renders false before true",
          noul.renderOptions().get(0).startsWith("false:") && noul.renderOptions().get(1).startsWith("true:"),
          noul.renderOptions().toString());

    check("confidence is 1 for a single option",
          Sequence.confidence(new double[] {1.0}) == 1.0, "not 1");
    double[] flat = {0.25, 0.25, 0.25, 0.25};
    check("confidence is 0 for a flat distribution",
          Math.abs(Sequence.confidence(flat)) < 1e-9, String.valueOf(Sequence.confidence(flat)));
  }

  private static boolean throwsIAE(Runnable r) {
    try { r.run(); return false; } catch (IllegalArgumentException e) { return true; }
  }

  private static void stateSerialisation(Path file) throws Exception {
    JsonNode root = JSON.readTree(Files.readString(file));
    for (JsonNode c : root.path("cases")) {
      Object in = JSON.treeToValue(c.get("in"), Object.class);
      String expected = c.get("out").asText();
      String actual = PyJson.serialiseState(in);
      check(abbreviate(expected), expected.equals(actual), "got " + actual);
    }
  }

  private static void sequences(Path file, Laya laya) throws Exception {
    JsonNode root = JSON.readTree(Files.readString(file));
    for (JsonNode c : root.path("cases")) {
      String name = c.get("name").asText();
      Object state = JSON.treeToValue(c.get("state"), Object.class);
      Map<String, Question> questions = parseQuestions(c.get("questions"));
      JsonNode expected = c.get("expected");

      for (Map.Entry<String, Question> e : questions.entrySet()) {
        JsonNode want = expected == null ? null : expected.get(e.getKey());
        Question q = e.getValue();
        if (want == null) {
          check(name + " / " + e.getKey() + ": has an expectation", false,
                "no expectation in the vector file");
          continue;
        }

        List<String> gotOptions = q.renderOptions();
        List<String> wantOptions = new ArrayList<>();
        want.get("renderedOptions").forEach(n -> wantOptions.add(n.asText()));
        check(name + " / " + e.getKey() + ": rendered options",
              gotOptions.equals(wantOptions), gotOptions + " != " + wantOptions);

        check(name + " / " + e.getKey() + ": qtype",
              q.qtype() == want.get("qtype").asInt(), "got " + q.qtype());

        Sequence.Built built = laya.buildSequence(state, q);

        int[] wantIds = intArray(want.get("ids"));
        check(name + " / " + e.getKey() + ": token ids (" + wantIds.length + ")",
              java.util.Arrays.equals(built.ids(), wantIds), diff(built.ids(), wantIds));

        int[] wantMarkers = intArray(want.get("markers"));
        check(name + " / " + e.getKey() + ": markers",
              java.util.Arrays.equals(built.markers(), wantMarkers),
              java.util.Arrays.toString(built.markers()) + " != " + java.util.Arrays.toString(wantMarkers));

        String wantBucket = want.get("temperatureBucket").asText();
        String gotBucket = Sequence.tempBucket(q.qtype(), built.markers().length);
        check(name + " / " + e.getKey() + ": temperature bucket",
              wantBucket.equals(gotBucket), gotBucket + " != " + wantBucket);
      }
    }
  }

  private static void answers(Path file, Laya laya) throws Exception {
    JsonNode root = JSON.readTree(Files.readString(file));
    for (JsonNode c : root.path("cases")) {
      String name = c.get("name").asText();
      Object state = JSON.treeToValue(c.get("state"), Object.class);
      Map<String, Question> questions = parseQuestions(c.get("questions"));
      JsonNode expected = c.get("expected");

      SystemOneResult got = laya.systemOne(state, questions);

      check(name + ": input_tokens",
            got.inputTokens() == expected.path("usage").path("input_tokens").asInt(),
            got.inputTokens() + " != " + expected.path("usage").path("input_tokens").asInt());

      JsonNode wantAnswers = expected.get("answers");
      for (String qid : questions.keySet()) {
        JsonNode want = wantAnswers == null ? null : wantAnswers.get(qid);
        Answer a = got.answers().get(qid);
        if (want == null || a == null) {
          check(name + "/" + qid + ": answered", false,
                want == null ? "no expectation in the vector file" : "no answer produced");
          continue;
        }
        String type = want.get("type").asText();

        switch (type) {
          case "choice" -> {
            Answer.Choice ch = (Answer.Choice) a;
            check(name + "/" + qid + ": choice",
                  ch.choice().equals(want.get("choice").asText()),
                  ch.choice() + " != " + want.get("choice").asText());
            JsonNode wp = want.get("probabilities");
            // Compare both ways. A one-sided walk over what we produced cannot fail on
            // an option we dropped, and MissingNode.asDouble(NaN) cannot fail on one we
            // invented either - every NaN comparison below is false.
            boolean ok = wp.size() == ch.probabilities().size();
            StringBuilder why = new StringBuilder();
            if (!ok) {
              why.append("expected ").append(wp.size()).append(" options, got ")
                 .append(ch.probabilities().size()).append(": ")
                 .append(ch.probabilities().keySet()).append(' ');
            }
            for (Map.Entry<String, Double> p : ch.probabilities().entrySet()) {
              JsonNode w = wp.get(p.getKey());
              if (w == null) {
                ok = false;
                why.append("option ").append(p.getKey()).append(" is not in the vector ");
              } else if (Math.abs(w.asDouble() - p.getValue()) > 1e-4) {
                ok = false;
                why.append(p.getKey()).append(": ").append(p.getValue())
                   .append(" != ").append(w.asDouble()).append(' ');
              }
            }
            check(name + "/" + qid + ": probabilities", ok, why.toString());
            check(name + "/" + qid + ": confidence",
                  Math.abs(ch.confidence() - want.get("confidence").asDouble()) <= 1e-4,
                  ch.confidence() + " != " + want.get("confidence").asDouble());
          }
          case "score" -> {
            Answer.Score sc = (Answer.Score) a;
            check(name + "/" + qid + ": score",
                  Math.abs(sc.score() - want.get("score").asDouble()) <= 1e-4,
                  sc.score() + " != " + want.get("score").asDouble());
          }
          case "noul" -> {
            Answer.Noul nl = (Answer.Noul) a;
            check(name + "/" + qid + ": noul",
                  Math.abs(nl.noul() - want.get("noul").asDouble()) <= 1e-4,
                  nl.noul() + " != " + want.get("noul").asDouble());
          }
          default -> check(name + "/" + qid + ": unknown type " + type, false, type);
        }
      }
    }
  }

  /** The conformance files carry questions in the wire shape. */
  private static Map<String, Question> parseQuestions(JsonNode node) {
    Map<String, Question> out = new LinkedHashMap<>();
    node.fieldNames().forEachRemaining(qid -> {
      JsonNode q = node.get(qid);
      String type = q.get("type").asText();
      String instructions = q.get("instructions").isTextual()
          ? q.get("instructions").asText() : q.get("instructions").toString();
      JsonNode crit = q.get("criteria");
      switch (type) {
        case "choice" -> {
          if (crit != null && crit.isArray()) {
            List<String> opts = new ArrayList<>();
            crit.forEach(n -> opts.add(n.asText()));
            out.put(qid, Question.Choice.of(instructions, opts));
          } else {
            Map<String, String> m = new LinkedHashMap<>();
            if (crit != null) crit.fieldNames().forEachRemaining(k ->
                m.put(k, crit.get(k).isNull() ? null : crit.get(k).asText()));
            out.put(qid, new Question.Choice(instructions, m));
          }
        }
        case "score" -> {
          List<String> levels = new ArrayList<>();
          if (crit != null) crit.forEach(n -> levels.add(n.asText()));
          out.put(qid, new Question.Score(instructions, levels));
        }
        case "noul" -> {
          String t = crit != null && crit.has("true") ? crit.get("true").asText() : null;
          String f = crit != null && crit.has("false") ? crit.get("false").asText() : null;
          out.put(qid, new Question.Noul(instructions, t, f));
        }
        // A new or misspelled wire type must not be silently answered as a noul: that
        // would score the wrong sequence against the right expectations.
        default -> throw new IllegalArgumentException(
            "question \"" + qid + "\": unknown wire type \"" + type + "\"");
      }
    });
    return out;
  }

  private static int[] intArray(JsonNode n) {
    int[] out = new int[n.size()];
    for (int i = 0; i < n.size(); i++) out[i] = n.get(i).asInt();
    return out;
  }

  /** Point at the first divergence rather than dumping hundreds of ids. */
  private static String diff(int[] got, int[] want) {
    if (got.length != want.length) return "length " + got.length + " != " + want.length;
    for (int i = 0; i < got.length; i++) {
      if (got[i] != want[i]) return "first differs at " + i + ": " + got[i] + " != " + want[i];
    }
    return "";
  }

  private static String abbreviate(String s) {
    return s.length() <= 46 ? s : s.substring(0, 43) + "...";
  }

  private static void section(String title) {
    System.out.println("\n== " + title + " ==");
  }

  private static void check(String name, boolean ok, String detail) {
    if (ok) {
      passed++;
      System.out.println("  PASS  " + name);
    } else {
      failed++;
      System.out.println("  FAIL  " + name + (detail == null || detail.isEmpty() ? "" : "  -> " + detail));
    }
  }

}
