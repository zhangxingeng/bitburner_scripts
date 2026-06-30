// Example test (design/11 §3.8). Run after `npx tsc`:  node test/subsystem_state.test.mjs
// subsystem_state.ts has only a type-only @ns import, so its compiled bundle is
// directly node-importable. This is the pattern Wave-1 Agent K extends per module.
import { saveSubsystem, loadSubsystem, emptySubsystem, loadAllSubsystems } from '../dist/lib/subsystem_state.js';
import { mockNs, assert, eq } from './_mock_ns.mjs';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok -', name); };

test('round-trips a status by id', () => {
	const ns = mockNs();
	const s = { id: 'gang', available: true, enabled: true, running: true, headline: 'Respect 1.2m', metrics: { members: 12 }, ts: 123 };
	saveSubsystem(ns, s);
	eq(loadSubsystem(ns, 'gang'), s, 'loaded == saved');
});

test('missing file → empty (ts:0)', () => {
	const ns = mockNs();
	eq(loadSubsystem(ns, 'corp'), emptySubsystem('corp'), 'empty on miss');
});

test('corrupt file → empty, never throws', () => {
	const ns = mockNs();
	ns.write('status/subsystems/sleeve.json', '{not json', 'w');
	eq(loadSubsystem(ns, 'sleeve'), emptySubsystem('sleeve'), 'empty on corrupt');
});

test('partial file merges over empty (no undefined fields)', () => {
	const ns = mockNs();
	ns.write('status/subsystems/stanek.json', JSON.stringify({ headline: 'charging' }), 'w');
	const got = loadSubsystem(ns, 'stanek');
	eq(got.metrics, {}, 'metrics defaulted');
	assert(got.id === 'stanek', 'id forced to requested id');
	assert(got.available === false, 'available defaulted false');
});

test('loadAllSubsystems returns one per id, in order', () => {
	const ns = mockNs();
	saveSubsystem(ns, { ...emptySubsystem('gang'), headline: 'g' });
	const all = loadAllSubsystems(ns, ['gang', 'corp']);
	assert(all.length === 2, 'two results');
	eq(all.map(x => x.id), ['gang', 'corp'], 'order preserved');
});

console.log(`\nsubsystem_state: ${passed} passed`);
