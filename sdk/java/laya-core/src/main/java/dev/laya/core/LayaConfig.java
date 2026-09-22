package dev.laya.core;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

/** {@code laya_config.json}: sequence limits and the calibration temperatures. */
public record LayaConfig(int maxLen, int headMaxLen, double[] temperature,
                         Map<String, Double> temperatureByOptions) {

  public static LayaConfig read(Path file) throws IOException {
    JsonNode root = new ObjectMapper().readTree(Files.readString(file));
    int maxLen = root.path("max_len").asInt(512);
    int headMaxLen = root.path("head_max_len").asInt(192);

    JsonNode t = root.path("temperature");
    double[] temps = new double[Math.max(3, t.size())];
    java.util.Arrays.fill(temps, 1.0);
    for (int i = 0; i < t.size(); i++) temps[i] = t.get(i).asDouble(1.0);

    Map<String, Double> byOptions = new LinkedHashMap<>();
    JsonNode byOpt = root.path("temperature_by_options");
    byOpt.fieldNames().forEachRemaining(k -> byOptions.put(k, byOpt.get(k).asDouble(1.0)));

    return new LayaConfig(maxLen, headMaxLen, temps, byOptions);
  }

  /** Per-cardinality temperature, falling back to the per-type one, then to 1. */
  public double temperatureFor(int qtype, int optionCount) {
    Double byBucket = temperatureByOptions.get(Sequence.tempBucket(qtype, optionCount));
    if (byBucket != null) return byBucket;
    return qtype < temperature.length ? temperature[qtype] : 1.0;
  }
}
