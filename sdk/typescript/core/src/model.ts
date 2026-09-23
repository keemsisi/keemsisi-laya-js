/**
 * Which checkpoint this SDK is verified against.
 *
 * `revision` is not a nicety. @receptron/laya's loader compares a cached
 * file's byte count against the remote one and never checksums it, so
 * "main" means "whatever that branch points at today" - a silent change of
 * model under a cache that looks valid. Every number this SDK commits to
 * was measured on the commit below: the conformance vectors in protocol/,
 * the token-cost fit in budget.ts, and the 512-token window.
 *
 * So this is the default rather than a suggestion. Override it explicitly
 * (ModelSource.revision) to use a different checkpoint, and expect the
 * conformance vectors to disagree if you do.
 *
 * A test asserts this matches protocol/conformance/*.json, so the constant
 * and the vectors cannot drift apart.
 */
export const CHECKPOINT = {
  /** The model itself. */
  model: 'convaiinnovations/laya',
  /** Hugging Face repo holding the ONNX export. */
  repo: 'receptron/laya-onnx',
  /** The exact commit every published measurement was taken on. */
  revision: '68f27dfe5a27a54fb2b1fefc432f43f972e90868',
  /** Which entry in CONTEXT_TOKENS this checkpoint is. */
  context: 'english'
} as const;
