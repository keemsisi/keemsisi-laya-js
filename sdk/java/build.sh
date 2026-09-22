#!/usr/bin/env bash
# Build and test laya-core without Maven.
#
# Maven is the supported route for consumers (see pom.xml), but on some machines
# the java binary cannot reach Maven Central even when curl can, which makes mvn
# unusable. This fetches the same artifacts with curl and drives javac directly.
set -euo pipefail
cd "$(dirname "$0")"

C=https://repo1.maven.org/maven2
JARS=(
  com/microsoft/onnxruntime/onnxruntime/1.20.0/onnxruntime-1.20.0.jar
  ai/djl/huggingface/tokenizers/0.30.0/tokenizers-0.30.0.jar
  ai/djl/api/0.30.0/api-0.30.0.jar
  com/fasterxml/jackson/core/jackson-databind/2.18.2/jackson-databind-2.18.2.jar
  com/fasterxml/jackson/core/jackson-core/2.18.2/jackson-core-2.18.2.jar
  com/fasterxml/jackson/core/jackson-annotations/2.18.2/jackson-annotations-2.18.2.jar
  com/google/code/gson/gson/2.11.0/gson-2.11.0.jar
  org/slf4j/slf4j-api/2.0.16/slf4j-api-2.0.16.jar
  org/slf4j/slf4j-simple/2.0.16/slf4j-simple-2.0.16.jar
)

# --fail matters: without it curl writes a 404 body into the target and exits 0,
# and the "already there" check below would then reuse that corrupt file forever.
fetch() {  # fetch <url> <dest>
  curl -fsSL --max-time 300 -o "$2" "$1" || { rm -f "$2"; echo "could not fetch $1" >&2; exit 1; }
}

mkdir -p lib target/classes
for a in "${JARS[@]}"; do
  f="lib/$(basename "$a")"
  [ -f "$f" ] || { echo "fetching $(basename "$a")"; fetch "$C/$a" "$f"; }
done

# DJL ships tokenizer natives for linux and windows only; it downloads the macOS
# one at runtime, which fails when java has no network. Seed its cache instead.
case "$(uname -s)/$(uname -m)" in
  Darwin/arm64)  DJL_CLASSIFIER=osx-aarch64 ;;
  Darwin/x86_64) DJL_CLASSIFIER=osx-x86_64 ;;
  *)             DJL_CLASSIFIER= ;;
esac
if [ -n "$DJL_CLASSIFIER" ]; then
  NATIVE="$HOME/.djl.ai/tokenizers/0.20.0-0.30.0/$DJL_CLASSIFIER/libtokenizers.dylib"
  if [ ! -f "$NATIVE" ]; then
    echo "fetching the macOS $DJL_CLASSIFIER tokenizer native"
    mkdir -p "$(dirname "$NATIVE")"
    fetch "https://publish.djl.ai/tokenizers/0.20.0/jnilib/0.30.0/$DJL_CLASSIFIER/cpu/libtokenizers.dylib" \
      "$NATIVE"
  fi
fi

echo "compiling"
find laya-core/src -name '*.java' -print0 | xargs -0 javac -d target/classes -cp "lib/*"

CONF="../../protocol/conformance"

# Find a checkpoint: an explicit path, then the pinned revision, then any cached
# one. Without this the script quietly skips the vectors that matter most.
# LAYA_CACHE is what the JS tooling honours, so honour it here too.
CACHE="${LAYA_CACHE:-$HOME/.cache/receptron-laya}"
MODEL="${LAYA_MODEL_DIR:-}"
if [ -z "$MODEL" ] && [ -n "${LAYA_REVISION:-}" ]; then
  MODEL="$CACHE/receptron--laya-onnx/$LAYA_REVISION"
fi
if [ -z "$MODEL" ] || [ ! -f "$MODEL/laya.onnx" ]; then
  # `|| true`: with `set -e -o pipefail`, find exiting non-zero on a missing cache
  # directory would otherwise abort the whole script here, silently.
  FOUND=$(find "$CACHE" -maxdepth 3 -name laya.onnx 2>/dev/null | head -1 || true)
  [ -z "$FOUND" ] || MODEL="$(dirname "$FOUND")"
fi

if [ -n "$MODEL" ] && [ -f "$MODEL/laya.onnx" ]; then
  echo "running conformance against $MODEL"
  java --enable-native-access=ALL-UNNAMED \
    -Dai.djl.offline=true -Dorg.slf4j.simpleLogger.defaultLogLevel=warn -Xmx4g \
    -cp "lib/*:target/classes" dev.laya.core.Conformance "$CONF" "$MODEL"
else
  echo "no checkpoint found under $CACHE (set LAYA_MODEL_DIR to point at one)"
  echo "running only the vectors that do not need it"
  java -Dorg.slf4j.simpleLogger.defaultLogLevel=warn \
    -cp "lib/*:target/classes" dev.laya.core.Conformance "$CONF"
fi
