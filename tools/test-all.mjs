/*
 * Runs everything in the repo. Usage: node tools/test-all.mjs
 *
 * This knows nothing about any language. Each SDK owns sdk/<language>/build.sh
 * and each demo owns demos/<name>/test.sh; both print a final line stating a
 * count. This discovers them, runs them, and adds up the verdicts - so adding a
 * language means adding one script, not editing this file.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Entry points, in the order a reader would want them reported. */
function discover() {
  const found = [];
  for (const [dir, script, label] of [['sdk', 'build.sh', 'sdk'], ['demos', 'test.sh', 'demo']]) {
    const base = path.join(root, dir);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base).sort()) {
      const entry = path.join(base, name, script);
      if (existsSync(entry) && statSync(entry).isFile()) {
        found.push({ name: `${label}/${name}`, entry });
      }
    }
  }
  return found;
}

/**
 * A run's verdict, not merely its last line: a build can print warnings after
 * its summary, and reporting those would hide whether it passed.
 */
function verdict(out) {
  const lines = out.trim().split('\n').map((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/\d+ (passed|assertions)/.test(lines[i])) return lines[i];
  }
  return lines[lines.length - 1] || '';
}

const targets = discover();
if (targets.length === 0) {
  console.error('nothing to run: no sdk/*/build.sh or demos/*/test.sh found');
  process.exit(1);
}

const results = [];
let failed = 0;
for (const { name, entry } of targets) {
  console.log(`\n== ${name} ==`);
  const r = spawnSync(entry, [], { cwd: path.dirname(entry), encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  process.stdout.write(out.split('\n').filter((l) => /^\s{2}(ok|FAIL|skip)/.test(l)).join('\n') + '\n');
  const bad = r.status !== 0;
  if (bad) {
    failed++;
    console.log(out);
  }
  results.push({ name, line: verdict(out), bad });
}

console.log('\n================ summary ================');
let total = 0;
for (const r of results) {
  console.log('  ' + (r.bad ? 'FAIL' : 'ok  ') + '  ' + r.name.padEnd(16) + r.line);
  const m = r.line.match(/(\d+) passed/) || r.line.match(/(\d+) assertions/);
  if (m) total += Number(m[1]);
}
console.log('  ' + total + ' assertions across ' + results.length + ' components');
process.exit(failed ? 1 : 0);
