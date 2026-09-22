package dev.laya.core;

import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * Surefire entry point for the conformance vectors.
 *
 * <p>{@link Conformance} is a CLI so it can run without a test framework, but surefire
 * only picks up classes matching its naming convention - without this wrapper
 * {@code mvn test} compiled the vectors and ran nothing, reporting a green build that
 * had validated exactly zero.
 */
class ConformanceTest {

  private static Path conformanceDir() {
    return Path.of(System.getProperty("laya.conformance", "../../protocol/conformance"));
  }

  /** An explicit path, else any checkpoint already cached. */
  private static Path modelDir() {
    String explicit = System.getProperty("laya.model", System.getenv("LAYA_MODEL_DIR"));
    if (explicit != null && Files.exists(Path.of(explicit, "laya.onnx"))) return Path.of(explicit);

    String cache = System.getenv("LAYA_CACHE");
    Path root = cache != null ? Path.of(cache)
        : Path.of(System.getProperty("user.home"), ".cache", "receptron-laya");
    if (!Files.isDirectory(root)) return null;
    try (Stream<Path> paths = Files.walk(root, 3)) {
      return paths.filter(p -> p.getFileName().toString().equals("laya.onnx"))
                  .findFirst().map(Path::getParent).orElse(null);
    } catch (Exception e) {
      return null;
    }
  }

  @Test
  void matchesTheReferenceVectors() throws Exception {
    Path dir = conformanceDir();
    assumeTrue(Files.isDirectory(dir), "conformance vectors not found at " + dir);

    Conformance.Result result = Conformance.run(dir, modelDir());
    assertEquals(0, result.failed(), result.failed() + " conformance assertions failed");
    assertTrue(result.passed() > 0, "no assertions ran");
  }
}
