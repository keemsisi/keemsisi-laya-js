/**
 * Verify the downloaded Laya bundle against Hugging Face's published LFS
 * digests.
 *
 * The loader in @receptron/laya only compares byte counts against the remote
 * file - there is no checksum - and npm's integrity hashes do not cover model
 * weights. This closes that gap: it hashes what is on disk and compares it
 * with the sha256 the repo publishes for the pinned revision.
 *
 *   node scripts/verify-weights.mjs [revision]
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const REPO = process.env.LAYA_REPO ?? 'receptron/laya-onnx';
const REVISION = process.argv[2] ?? process.env.LAYA_REVISION ?? 'main';
const cacheRoot = process.env.LAYA_CACHE ??
  path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'receptron-laya');
const dir = path.join(cacheRoot, REPO.replace('/', '--'), REVISION);

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

const res = await fetch(`https://huggingface.co/api/models/${REPO}/tree/${REVISION}?recursive=1`);
if (!res.ok) {
  console.error(`could not read the file list for ${REPO}@${REVISION}: HTTP ${res.status}`);
  process.exit(1);
}
const tree = await res.json();

console.log(`repo      ${REPO}`);
console.log(`revision  ${REVISION}`);
console.log(`cache     ${dir}\n`);

let checked = 0, verified = 0, unverifiable = 0, bad = 0, missing = 0;
for (const entry of tree) {
  if (entry.type !== 'file') continue;
  const local = path.join(dir, entry.path);
  let size;
  try { size = (await stat(local)).size; }
  catch { continue; }                       // only bundle files are cached
  checked++;

  const sizeOk = size === entry.size;
  const expected = entry.lfs?.oid ?? null;
  if (!expected) {
    unverifiable++;
    console.log(`${sizeOk ? 'size ok  ' : 'SIZE BAD '} ${entry.path}  (not an LFS file: no published digest)`);
    if (!sizeOk) bad++;
    continue;
  }
  const actual = await sha256(local);
  if (actual === expected && sizeOk) {
    verified++;
    console.log(`VERIFIED  ${entry.path}  sha256 ${actual.slice(0, 16)}…  ${size} bytes`);
  } else {
    bad++;
    console.log(`MISMATCH  ${entry.path}`);
    console.log(`          expected ${expected} (${entry.size} bytes)`);
    console.log(`          actual   ${actual} (${size} bytes)`);
  }
}

// Anything the loader needs but that never landed on disk.
const BUNDLE = ['laya.onnx', 'laya.onnx.data', 'laya_config.json',
                'tokenizer/tokenizer.json', 'tokenizer/tokenizer_config.json'];
for (const f of BUNDLE) {
  try { await stat(path.join(dir, f)); }
  catch { missing++; console.log(`MISSING   ${f}`); }
}

console.log(`\n${checked} cached files: ${verified} cryptographically verified, ` +
            `${unverifiable} size-checked only, ${bad} bad, ${missing} missing`);
if (bad || missing) {
  console.error('\nThe bundle does not match the published revision. Delete the cache and re-download.');
  process.exit(1);
}
if (!verified) {
  console.error('\nNothing was verified - is the cache populated for this revision?');
  process.exit(1);
}
console.log('\nThe weights match the digests published for this revision.');
