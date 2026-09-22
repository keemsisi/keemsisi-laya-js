package dev.laya.core;

import java.util.Map;

/**
 * One forward pass over every question.
 *
 * @param inputTokens summed across the batch: the state is encoded once per question, so
 *                    this grows with question count as well as state size
 */
public record SystemOneResult(String model, Map<String, Answer> answers,
                              int inputTokens, int outputTokens) {

  @SuppressWarnings("unchecked")
  public <T extends Answer> T answer(String id, Class<T> type) {
    Answer a = answers.get(id);
    if (a == null) throw new IllegalArgumentException("no answer for question " + id);
    if (!type.isInstance(a)) {
      throw new IllegalStateException("question " + id + " answered as " + a.getClass().getSimpleName()
          + ", not " + type.getSimpleName());
    }
    return (T) a;
  }
}
