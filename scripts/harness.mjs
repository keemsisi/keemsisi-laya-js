/* Minimal assertion harness: no framework, no dependencies. */
let pass = 0, fail = 0;
const failures = [];

export function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else {
    fail++; failures.push(name);
    console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : ''));
  }
}

export function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(name, a === e, a + ' !== ' + e);
}

export function near(name, actual, expected, tol = 1e-9) {
  ok(name, Math.abs(actual - expected) <= tol, actual + ' !== ' + expected);
}

export function section(title) { console.log('\n== ' + title + ' =='); }

export function summary() {
  console.log('\n---------------------------------------');
  console.log(pass + ' passed, ' + fail + ' failed');
  if (fail) process.exitCode = 1;
  return { pass, fail, failures };
}

export async function throws(name, fn, match) {
  try { await fn(); ok(name, false, 'did not throw'); }
  catch (e) { ok(name, match ? match.test(String(e.message)) : true, String(e.message)); }
}
