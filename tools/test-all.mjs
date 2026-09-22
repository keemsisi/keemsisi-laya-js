/* Builds, typechecks, then runs every suite. Usage: node tools/test-all.mjs */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const run = (cmd, args, label) => {
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) {
    console.error('\n' + label + ' FAILED\n' + (r.stdout || '') + (r.stderr || ''));
    process.exit(1);
  }
  console.log('  ok  ' + label);
};

console.log('building packages...');
for (const p of ['core', 'server', 'react']) run('npx', ['tsc', '-p', 'sdk/typescript/' + p], '@laya-js/' + p);

console.log('\ntypechecking consumers...');
// The packages compile themselves, but only a consumer proves the emitted
// .d.ts files are usable - and the example is bundled by esbuild, which
// strips types without checking them.
run('npx', ['tsc', '-p', 'sdk/typescript/conformance'], 'type surface (with @ts-expect-error assertions)');
run('npx', ['tsc', '-p', 'demos/ticketing'], 'example app (strict)');

console.log('\nbundling the example...');
run(process.execPath, ['demos/ticketing/build.mjs'], 'esbuild bundle');

const suites = [
  ['core', 'sdk/typescript/core/test/core.test.mjs'],
  ['core/client', 'sdk/typescript/core/test/client.test.mjs'],
  ['server', 'sdk/typescript/server/test/server.test.mjs'],
  ['react', 'sdk/typescript/react/test/react.test.mjs'],
  ['app (jsdom)', 'demos/ticketing/test/app.test.mjs'],
  // Loads the real 1.69 GB checkpoint. Skips itself, loudly, when the
  // bundle is not already cached, so this never starts a download.
  ['real model', 'sdk/typescript/server/test/real-model.test.mjs']
];

console.log('\nrunning suites...');
const results = [];
let failed = 0;
for (const [name, file] of suites) {
  const r = spawnSync(process.execPath, [file], { cwd: root, encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const line = (out.trim().split('\n').pop() || '').trim();
  const bad = r.status !== 0;
  if (bad) { failed++; console.log(out); }
  results.push({ name, line, bad });
}

// Each non-JavaScript SDK owns its build; this runs whichever are present so the
// repo has one entry point rather than one per language.
const polyglot = [
  ['java', 'sdk/java/build.sh', []]
];
for (const [name, script, args] of polyglot) {
  if (!existsSync(path.join(root, script))) continue;
  console.log('\nrunning the ' + name + ' sdk...');
  const r = spawnSync(path.join(root, script), args, { cwd: path.dirname(path.join(root, script)), encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const line = (out.trim().split('\n').pop() || '').trim();
  const bad = r.status !== 0;
  if (bad) { failed++; console.log(out); }
  results.push({ name: 'sdk/' + name, line, bad });
}

console.log('\n================ summary ================');
let total = 0;
for (const r of results) {
  const label = r.line.startsWith('SKIPPED') || /is not cached/.test(r.line) ? 'skip' : r.bad ? 'FAIL' : 'ok  ';
  console.log('  ' + label + '  ' + r.name.padEnd(13) + r.line);
  const m = r.line.match(/(\d+) passed/);
  if (m) total += Number(m[1]);
}
console.log('  ' + total + ' assertions across ' + suites.length + ' suites, plus 2 typechecks');
process.exit(failed ? 1 : 0);
