// Minimal in-memory mock of the bits of NS our status-file libs use (design/11 §3.8).
// Status libs only touch ns.read / ns.write / ns.fileExists, so this suffices for
// round-trip tests. Import this from *.test.mjs and pass mockNs() where ns is wanted.
export function mockNs() {
	const files = new Map();
	return {
		_files: files,
		read: (f) => (files.has(f) ? files.get(f) : ''),
		write: (f, d, mode = 'w') => {
			if (mode === 'w') files.set(f, d);
			else files.set(f, (files.get(f) ?? '') + d);
		},
		fileExists: (f) => files.has(f),
	};
}

// Tiny assertion helpers — keep tests dependency-free (node --test optional).
export function assert(cond, msg) {
	if (!cond) throw new Error('ASSERT FAILED: ' + msg);
}
export function eq(a, b, msg) {
	const sa = JSON.stringify(a), sb = JSON.stringify(b);
	if (sa !== sb) throw new Error(`ASSERT EQ FAILED: ${msg}\n  got:      ${sa}\n  expected: ${sb}`);
}
