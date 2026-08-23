// Minimal test harness: no dependencies, so the free deploy stays a single
// `npm install` with nothing extra to fetch.
const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

async function run() {
  let passed = 0;
  const failures = [];

  for (const t of tests) {
    try {
      await t.fn();
      console.log('  PASS  ' + t.name);
      passed++;
    } catch (err) {
      console.log('  FAIL  ' + t.name);
      console.log('        ' + (err && err.message ? err.message : err));
      failures.push(t.name);
    }
  }

  console.log('');
  console.log(passed + '/' + tests.length + ' passed');
  if (failures.length) {
    console.log('failed: ' + failures.join(', '));
    process.exitCode = 1;
  }
}

module.exports = { test, run };
