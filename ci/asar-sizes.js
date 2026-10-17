// Prints the biggest things packed inside an app.asar (not counting unpacked files), as one notice line per entry
const asar = require('@electron/asar');
const h = asar.getRawHeader(process.argv[2]).header, sums = {};
(function walk(n, p) { for (const [k, v] of Object.entries(n.files || {})) { const q = p ? p + '/' + k : k; if (v.files) walk(v, q); else if (!v.unpacked) { const top = q.split('/').slice(0, q.startsWith('node_modules') ? 2 : 1).join('/'); sums[top] = (sums[top] || 0) + (v.size || 0); } } })(h, '');
console.log(Object.entries(sums).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${(v / 1048576).toFixed(1)} MB ${k}`).join('%0A'));
