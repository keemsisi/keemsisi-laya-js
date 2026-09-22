package dev.laya.core;

import java.lang.reflect.Array;
import java.util.List;
import java.util.Map;

/**
 * Python's {@code json.dumps(obj, ensure_ascii=False)}.
 *
 * <p>The checkpoint was trained on states serialised by Python, and the token stream
 * changes if the serialisation does. Three details differ from most JVM JSON writers:
 * the separators are {@code ", "} and {@code ": "} <em>with</em> the spaces, keys keep
 * insertion order rather than being sorted, and non-ASCII is emitted literally.
 *
 * <p>Pinned by {@code protocol/conformance/state-serialisation.json}.
 */
public final class PyJson {
  private PyJson() {}

  /** A string state is used as-is; anything else is serialised. */
  public static String serialiseState(Object state) {
    return state instanceof String s ? s : dumps(state);
  }

  public static String dumps(Object v) {
    StringBuilder sb = new StringBuilder();
    write(sb, v);
    return sb.toString();
  }

  private static void write(StringBuilder sb, Object v) {
    if (v == null) {
      sb.append("null");
    } else if (v instanceof String s) {
      quote(sb, s);
    } else if (v instanceof Boolean b) {
      sb.append(b ? "true" : "false");
    } else if (v instanceof Number n) {
      writeNumber(sb, n);
    } else if (v instanceof Map<?, ?> m) {
      sb.append('{');
      boolean first = true;
      for (Map.Entry<?, ?> e : m.entrySet()) {
        if (!first) sb.append(", ");
        first = false;
        quote(sb, String.valueOf(e.getKey()));
        sb.append(": ");
        write(sb, e.getValue());
      }
      sb.append('}');
    } else if (v instanceof List<?> l) {
      sb.append('[');
      for (int i = 0; i < l.size(); i++) {
        if (i > 0) sb.append(", ");
        write(sb, l.get(i));
      }
      sb.append(']');
    } else if (v.getClass().isArray()) {
      // Reflection covers primitive arrays too, and unlike List.of it tolerates
      // nulls - a null inside a state array used to throw.
      sb.append('[');
      int n = Array.getLength(v);
      for (int i = 0; i < n; i++) {
        if (i > 0) sb.append(", ");
        write(sb, Array.get(v, i));
      }
      sb.append(']');
    } else {
      quote(sb, String.valueOf(v));
    }
  }

  /**
   * Integral values print without a decimal point.
   *
   * <p>Floating point follows ECMAScript's number-to-string, which is what the reference
   * emits - <em>not</em> {@link Double#toString}, which would write {@code 12345678.5}
   * as {@code "1.23456785E7"} and {@code 0.0001} as {@code "1.0E-4"} and so change the
   * token stream for any state carrying a large or small double.
   *
   * <p>Note a known divergence from Python: {@code json.dumps} writes a float {@code 1.0}
   * as {@code "1.0"}, whereas this - like the JavaScript reference the conformance
   * vectors were generated from - writes {@code "1"}. It only shows up for a
   * float-typed state value that happens to be integral. Use an integral type, or a
   * string, if that distinction matters to your prompt.
   */
  private static void writeNumber(StringBuilder sb, Number n) {
    if (n instanceof Integer || n instanceof Long || n instanceof Short || n instanceof Byte
        || n instanceof java.math.BigInteger) {
      sb.append(n);
      return;
    }
    double d = n.doubleValue();
    if (Double.isNaN(d) || Double.isInfinite(d)) {
      sb.append("null");   // as JSON.stringify does; "NaN" would not even be valid JSON
      return;
    }
    sb.append(jsNumber(d));
  }

  /**
   * ECMAScript {@code Number::toString}: plain decimal in
   * {@code [1e-6, 1e21)}, exponent form outside it, and no trailing {@code ".0"}.
   */
  private static String jsNumber(double d) {
    if (d == 0) return "0";   // -0.0 too: JavaScript prints that as "0"

    // The shortest decimal that round-trips, which is what ECMAScript specifies.
    // Double.toString is *almost* this but diverges on subnormals - it renders
    // Double.MIN_VALUE as 4.9E-324 where JavaScript gives 5e-324 - so search for
    // the shortest significant-digit count that parses back to the same double
    // instead of trusting it.
    java.math.BigDecimal bd = null;
    for (int sig = 1; sig <= 17; sig++) {
      java.math.BigDecimal candidate = new java.math.BigDecimal(d, new java.math.MathContext(sig));
      if (candidate.doubleValue() == d) { bd = candidate; break; }
    }
    if (bd == null) bd = new java.math.BigDecimal(d);
    bd = bd.stripTrailingZeros();
    double abs = Math.abs(d);
    if (abs >= 1e-6 && abs < 1e21) return bd.toPlainString();

    String digits = bd.unscaledValue().abs().toString();
    int exp = digits.length() - 1 - bd.scale();
    StringBuilder out = new StringBuilder();
    if (d < 0) out.append('-');
    out.append(digits.charAt(0));
    if (digits.length() > 1) out.append('.').append(digits, 1, digits.length());
    out.append('e').append(exp < 0 ? '-' : '+').append(Math.abs(exp));
    return out.toString();
  }

  /**
   * JSON string escaping with {@code ensure_ascii=False}: only the characters JSON
   * requires are escaped, and everything else - including non-ASCII - is literal.
   */
  private static void quote(StringBuilder sb, String s) {
    sb.append('"');
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      switch (c) {
        case '"' -> sb.append("\\\"");
        case '\\' -> sb.append("\\\\");
        case '\n' -> sb.append("\\n");
        case '\r' -> sb.append("\\r");
        case '\t' -> sb.append("\\t");
        case '\b' -> sb.append("\\b");
        case '\f' -> sb.append("\\f");
        default -> {
          if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
          else sb.append(c);
        }
      }
    }
    sb.append('"');
  }
}
