package dev.laya.core;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A typed question. The integer type is fed to the model as {@code qtype}, so the
 * ordering (choice 0, score 1, noul 2) is part of the contract, not a detail.
 */
public sealed interface Question permits Question.Choice, Question.Score, Question.Noul {

  int qtype();

  String instructions();

  /** The option texts scored at each {@code [MASK]}, in label-index order. */
  List<String> renderOptions();

  /**
   * Pick one option. Criteria map option to description; a null description renders as
   * the bare key.
   *
   * <p><strong>Option order is part of the prompt.</strong> It decides the order the
   * options are presented in and therefore the answer, so pass something ordered -
   * a {@link LinkedHashMap}, or one of the factories here. Do <em>not</em> pass
   * {@code Map.of(...)}: its iteration order is unspecified and salted per JVM, so the
   * same code can build a different prompt on the next run.
   */
  record Choice(String instructions, Map<String, String> criteria) implements Question {
    public Choice {
      criteria = new LinkedHashMap<>(criteria);   // insertion order is load-bearing
    }

    /** A list of options is the same thing with null descriptions. */
    public static Choice of(String instructions, List<String> options) {
      Map<String, String> m = new LinkedHashMap<>();
      for (String o : options) m.put(o, null);
      return new Choice(instructions, m);
    }

    /**
     * Ordered alternative to {@code Map.of}: {@code ofPairs("Which team?", "billing",
     * "refunds", "support", "bugs")}. Order is preserved exactly as written.
     *
     * <p>Named for the pairing rather than overloading {@code of}, because
     * {@code of("q", "alpha", "beta")} would read as two options while meaning one
     * option described "beta" - and only an odd argument count would catch it.
     *
     * @param optionsAndDescriptions alternating option and description; a null
     *                               description renders as the bare option
     */
    public static Choice ofPairs(String instructions, String... optionsAndDescriptions) {
      if (optionsAndDescriptions.length % 2 != 0) {
        throw new IllegalArgumentException(
            "expected alternating option and description, got " + optionsAndDescriptions.length + " values");
      }
      Map<String, String> m = new LinkedHashMap<>();
      for (int i = 0; i < optionsAndDescriptions.length; i += 2) {
        m.put(optionsAndDescriptions[i], optionsAndDescriptions[i + 1]);
      }
      return new Choice(instructions, m);
    }

    @Override public int qtype() { return 0; }

    @Override public List<String> renderOptions() {
      List<String> out = new ArrayList<>(criteria.size());
      for (Map.Entry<String, String> e : criteria.entrySet()) {
        String v = e.getValue();
        out.add(v == null || v.isEmpty() ? e.getKey() : e.getKey() + ": " + v);
      }
      return out;
    }

    public List<String> keys() { return List.copyOf(criteria.keySet()); }
  }

  /** Rate on an ordered rubric; level 0 is the lowest. */
  record Score(String instructions, List<String> levels) implements Question {
    public Score {
      levels = List.copyOf(levels);
    }

    @Override public int qtype() { return 1; }

    @Override public List<String> renderOptions() {
      List<String> out = new ArrayList<>(levels.size());
      for (int i = 0; i < levels.size(); i++) out.add("level " + i + ": " + levels.get(i));
      return out;
    }
  }

  /**
   * A calibrated probability that a statement holds. Always two options in the order
   * false, true - so {@code p[1]} is P(true).
   */
  record Noul(String instructions, String whenTrue, String whenFalse) implements Question {
    public Noul(String instructions) { this(instructions, null, null); }

    @Override public int qtype() { return 2; }

    @Override public List<String> renderOptions() {
      return List.of(
          "false: " + (whenFalse == null || whenFalse.isEmpty() ? "no, the statement does not hold" : whenFalse),
          "true: " + (whenTrue == null || whenTrue.isEmpty() ? "yes, the statement holds" : whenTrue));
    }
  }
}
