package dev.laya.core;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;

/**
 * The pure half of the algorithm: sequence layout, temperature selection and decoding
 * maths. No model and no tokeniser state, so it is verifiable against
 * {@code protocol/conformance/sequences.json} on its own.
 *
 * <p>See {@code protocol/SPEC.md} - this is a direct implementation of it.
 */
public final class Sequence {
  private Sequence() {}

  /** Token ids for one question, and where each option's [MASK] landed. */
  public record Built(int[] ids, int[] markers) {}

  public record SpecialIds(int cls, int sep, int mask, int pad) {}

  private static final String MASK_LITERAL = "[MASK]";
  private static final int OPTION_TOKEN_CAP = 48;
  private static final int MIN_OPTION_BUDGET = 16;
  private static final int MIN_HEAD_TOKENS = 8;

  /** Caller text must not be able to forge a marker. */
  static String scrub(String s) {
    return s == null ? "" : s.replace(MASK_LITERAL, " ");
  }

  private static final String[] TYPE_NAMES = {"choice", "score", "noul"};

  /**
   * Temperature is chosen per option-count bucket, not per type: a two-option noul and a
   * twenty-option choice need different scaling.
   */
  public static String tempBucket(int qtype, int optionCount) {
    String size;
    if (optionCount <= 2) size = "2";
    else if (optionCount <= 5) size = "3-5";
    else if (optionCount <= 10) size = "6-10";
    else size = "11+";
    return TYPE_NAMES[qtype] + ":" + size;
  }

  /**
   * Builds
   * {@code [CLS] <type> question: <instructions> [SEP] [MASK] opt0 [MASK] opt1 ... [SEP] <state> [SEP]}
   * and records each option's marker offset.
   *
   * @param encode tokenises without special tokens
   */
  public static Built build(Function<String, int[]> encode, SpecialIds ids, Object state,
                            Question q, int maxLen, int headMaxLen) {
    List<String> options = q.renderOptions();

    int[] head = encode.apply(TYPE_NAMES[q.qtype()] + " question: " + scrub(q.instructions()));

    List<int[]> optIds = new ArrayList<>(options.size());
    for (String o : options) {
      int[] enc = encode.apply(" " + scrub(o));
      int keep = Math.min(enc.length, OPTION_TOKEN_CAP);
      int[] withMarker = new int[keep + 1];
      withMarker[0] = ids.mask();
      System.arraycopy(enc, 0, withMarker, 1, keep);
      optIds.add(withMarker);
    }

    int optBudget = headMaxLen - total(optIds);
    if (optBudget < MIN_OPTION_BUDGET) {
      // Too many or too long: shrink every option evenly rather than dropping any,
      // because a dropped option would silently become unanswerable.
      int per = Math.max(4, (headMaxLen - MIN_OPTION_BUDGET) / Math.max(1, optIds.size()));
      for (int i = 0; i < optIds.size(); i++) {
        int[] o = optIds.get(i);
        if (o.length > per) {
          int[] cut = new int[per];
          System.arraycopy(o, 0, cut, 0, per);
          optIds.set(i, cut);
        }
      }
      optBudget = headMaxLen - total(optIds);
    }

    int headKeep = Math.min(head.length, Math.max(MIN_HEAD_TOKENS, optBudget));

    List<Integer> seq = new ArrayList<>(maxLen);
    seq.add(ids.cls());
    for (int i = 0; i < headKeep; i++) seq.add(head[i]);
    seq.add(ids.sep());

    int[] markers = new int[optIds.size()];
    for (int i = 0; i < optIds.size(); i++) {
      markers[i] = seq.size();
      for (int v : optIds.get(i)) seq.add(v);
    }
    seq.add(ids.sep());

    int room = Math.max(0, maxLen - seq.size() - 1);
    int[] stateIds = encode.apply(scrub(PyJson.serialiseState(state)));
    for (int i = 0; i < Math.min(stateIds.length, room); i++) seq.add(stateIds[i]);
    seq.add(ids.sep());

    int len = Math.min(seq.size(), maxLen);
    int[] out = new int[len];
    for (int i = 0; i < len; i++) out[i] = seq.get(i);

    int kept = 0;
    for (int m : markers) if (m < maxLen) kept++;
    int[] keptMarkers = new int[kept];
    int j = 0;
    for (int m : markers) if (m < maxLen) keptMarkers[j++] = m;

    return new Built(out, keptMarkers);
  }

  private static int total(List<int[]> xs) {
    int n = 0;
    for (int[] x : xs) n += x.length;
    return n;
  }

  public static double[] softmax(double[] z) {
    double max = Double.NEGATIVE_INFINITY;
    for (double v : z) max = Math.max(max, v);
    double sum = 0;
    double[] e = new double[z.length];
    for (int i = 0; i < z.length; i++) {
      e[i] = Math.exp(z[i] - max);
      sum += e[i];
    }
    for (int i = 0; i < e.length; i++) e[i] /= sum;
    return e;
  }

  /**
   * Jev-style confidence: {@code 1 - H(p)/ln k}. This is a property of the whole
   * distribution, not the chosen option's probability - do not threshold on it when you
   * mean "how sure is this pick".
   */
  public static double confidence(double[] p) {
    int k = p.length;
    if (k < 2) return 1.0;
    double ent = 0;
    for (double x : p) ent -= x * Math.log(Math.max(x, 1e-12));
    return 1 - ent / Math.log(k);
  }

  /** Every reported probability is rounded to four decimals, as the reference does. */
  public static double round4(double x) {
    return Math.round(x * 1e4) / 1e4;
  }
}
