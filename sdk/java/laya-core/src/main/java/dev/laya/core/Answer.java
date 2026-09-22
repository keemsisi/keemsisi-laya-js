package dev.laya.core;

import java.util.Map;

/** A decoded answer. The variant always matches the question type that produced it. */
public sealed interface Answer permits Answer.Choice, Answer.Score, Answer.Noul {

  /** The model's own act probability, passed through from {@code act_probs}. */
  double actProbability();

  /**
   * @param choice        the option with the highest probability
   * @param probabilities calibrated, one entry per offered option, rounded to 4dp
   * @param confidence    {@code 1 - H(p)/ln k} over the whole distribution - NOT the
   *                      chosen option's probability. Threshold on
   *                      {@code probabilities.get(choice)} instead.
   */
  record Choice(String choice, Map<String, Double> probabilities, double confidence,
                double actProbability) implements Answer {
    /** The number to gate on. */
    public double probabilityOfChoice() {
      return probabilities.getOrDefault(choice, 0.0);
    }
  }

  /**
   * @param score an expectation over the rubric, so fractional: {@code sum(i * p[i])}
   */
  record Score(double score, Map<String, String> legend, Map<String, Double> probabilities,
               double confidence, double actProbability) implements Answer {
    /** Nearest whole level. */
    public int level() {
      return (int) Math.round(score);
    }
  }

  /** @param noul P(true) */
  record Noul(double noul, double actProbability) implements Answer {
    public boolean isTrue() {
      return noul >= 0.5;
    }
  }
}
