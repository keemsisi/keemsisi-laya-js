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
  /** Hugging Face repo holding the ONNX bundle. Default: receptron/laya-onnx. */
  repo?: string;
  /** Use a local export and never contact Hugging Face. */
  modelDir?: string;
  /** Cache root for the downloaded bundle. Default: $LAYA_CACHE or ~/.cache/receptron-laya. */
  cacheDir?: string;
  /**
   * Git revision in the ONNX repo.
   *
   * Prefer a commit SHA over the default "main". The loader checks only that
   * a cached file's byte count matches the remote one - there is no checksum
   * on the weights - so pinning a revision is what ties the download to a
   * specific published commit.
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
  const repo = source.repo ?? 'receptron/laya-onnx';
  const rev = source.revision ?? 'main (unpinned)';
  return repo + '@' + rev + (source.subfolder ? '/' + source.subfolder : '');
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
    repo: source.repo,
    modelDir: source.modelDir,
    cacheDir: source.cacheDir,
    revision: source.revision,
    subfolder: source.subfolder,
    token: source.token,
    onProgress: source.onProgress
  });
}
