import { CHECKPOINT } from '@laya-js/core';
import type { Questions, SystemOneResult } from '@laya-js/core';

/**
 * The slice of `@receptron/laya` this package needs.
 *
 * Declared structurally, and injectable through `LayaServerOptions.load`, so
 * the whole server is testable without the 1.7 GB checkpoint. Nothing here
 * imports the model package at module scope - it is loaded on demand.
 */
export interface LayaLike {
  systemOne(state: unknown, questions: Questions): Promise<SystemOneResult>;
  close?(): Promise<void>;
  readonly config?: { max_len?: number };
  readonly modelDir?: string;
}

export interface ModelSource {
  /** Hugging Face repo holding the ONNX bundle. Default: CHECKPOINT.repo. */
  repo?: string;
  /** Use a local export and never contact Hugging Face. */
  modelDir?: string;
  /** Cache root for the downloaded bundle. Default: $LAYA_CACHE or ~/.cache/receptron-laya. */
  cacheDir?: string;
  /**
   * Git revision in the ONNX repo. Default: CHECKPOINT.revision.
   *
   * The loader checks only that a cached file's byte count matches the
   * remote one - there is no checksum on the weights - so the revision is
   * the only thing tying a download to a specific published commit. It
   * therefore defaults to the pin rather than to "main"; set it explicitly
   * to move off the checkpoint this SDK was measured on.
   */
  revision?: string;
  /** Checkpoint variant, e.g. "multilingual" for the 1024-token mmBERT build. */
  subfolder?: string;
  /** Hugging Face token for a private repo. Default: $HF_TOKEN. */
  token?: string;
  onProgress?: (info: { file: string; received: number; total: number | null }) => void;
}

/** A human-readable description of where the model comes from. */
export function describeSource(source: ModelSource, injected: boolean): string {
  if (injected) return 'injected (custom load)';
  if (source.modelDir) return 'local: ' + source.modelDir;
  const repo = source.repo ?? CHECKPOINT.repo;
  const rev = source.revision ?? CHECKPOINT.revision;
  const pinned = rev === CHECKPOINT.revision ? '' : ' (not the verified checkpoint)';
  return repo + '@' + rev + (source.subfolder ? '/' + source.subfolder : '') + pinned;
}

/** Loads `@receptron/laya` if it is installed. Throws a readable error if not. */
export async function loadReceptronLaya(source: ModelSource = {}): Promise<LayaLike> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import('@receptron/laya')) as unknown as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      '@receptron/laya is not installed. Run `npm install @receptron/laya` ' +
      '(Node 20+, ~287 MB of onnxruntime-node binaries, and ~1.7 GB of weights on first run). ' +
      'Original error: ' + (err instanceof Error ? err.message : String(err))
    );
  }
  const Laya = mod['Laya'] as { load?: (o?: unknown) => Promise<LayaLike> } | undefined;
  if (!Laya || typeof Laya.load !== 'function') {
    throw new Error('@receptron/laya did not export Laya.load()');
  }
  return Laya.load({
    // Defaulted here, not left to @receptron/laya, whose own default is the
    // floating "main". A caller who wants that must now ask for it.
    repo: source.repo ?? CHECKPOINT.repo,
    modelDir: source.modelDir,
    cacheDir: source.cacheDir,
    revision: source.revision ?? CHECKPOINT.revision,
    subfolder: source.subfolder,
    token: source.token,
    onProgress: source.onProgress
  });
}
