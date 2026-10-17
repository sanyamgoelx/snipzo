// Fails the CI step unless every check in the end-to-end test passed (test/run.sh pipes output, so its exit code can't be trusted)
const r = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));
const bad = r.filter((x) => !x.ok);
console.log(`${r.length - bad.length}/${r.length} passed`);
for (const b of bad) console.log('FAIL', b.name, b.detail || '');
process.exit(bad.length || r.length < 20 ? 1 : 0);
