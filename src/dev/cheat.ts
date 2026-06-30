import type { NS } from '@ns';

/**
 * ⚠️ DEV-ONLY surgical cheat tool — NOT part of the autonomous gameplay system.
 *
 * Boundary (user-ratified 2026-06-30): cheating is for DEVELOPMENT ONLY. This
 * script is deliberately segregated under src/dev/, is NEVER imported by any
 * production module, and is NEVER auto-launched (absent from SCRIPT_PATHS /
 * DAEMON_CATALOG / the manager registry). In a PRODUCTION build the live Player
 * singleton is undefined, so this script no-ops with an error — the guard IS the
 * boundary.
 *
 * PHILOSOPHY (user 2026-06-30): grant NOTHING by default. Each invocation must
 * name exactly the capability it wants to unlock. Rationale: the point of a
 * cheat is to test ONE gated feature (e.g. SF4 Singularity) under otherwise-real
 * conditions. Blanket grants (piles of money/RAM) MASK bugs that would otherwise
 * be obvious. So: surgical, opt-in, one knob at a time.
 *
 *   run /dev/cheat.js                       # no-op — prints status + usage
 *   run /dev/cheat.js --sf 4                # unlock ONLY SF4 (Singularity), nothing else
 *   run /dev/cheat.js --sf 2,3,6 --level 3  # unlock these SFs at level 3
 *   run /dev/cheat.js --money 1e9           # set ONLY money
 *   run /dev/cheat.js --ram 256             # set ONLY home max RAM (GB)
 *   run /dev/cheat.js --exp 1e6             # dump exp into every skill, relevel
 *   run /dev/cheat.js --karma -54000        # set ONLY karma (gang threshold = -54000)
 *   run /dev/cheat.js --help
 *
 * How it works (recon of ../bitburner-src): dev builds expose the live Player
 * singleton at globalThis.Bitburner.Player (src/engine.tsx, gated on
 * NODE_ENV==='development'). We reach it via eval('globalThis') — 0 GB, same
 * trick lib/react.ts uses for the DOM. Setting a SourceFile (both
 * Player.sourceFiles and bitNodeOptions.sourceFileOverrides) unlocks
 * canAccessBitNodeFeature(n) immediately — no reset needed.
 */

const SKILL_KEYS = ['hacking', 'strength', 'defense', 'dexterity', 'agility', 'charisma', 'intelligence'] as const;

const USAGE = [
	'DEV-ONLY surgical cheat (works only in a dev build of bitburner-src).',
	'Grants NOTHING unless you name a knob — so you test one gated feature, not a masked one.',
	'  --sf <list>   unlock SourceFiles, e.g. 4  or  2,3,6   (level from --level)',
	'  --level <n>   SF level to grant (default 3; SF functions work at 1 with higher RAM)',
	'  --money <n>   set money exactly (e.g. 1e9)',
	'  --ram <gb>    set home max RAM exactly, in GB',
	'  --exp <n>     dump <n> exp into every skill and relevel',
	'  --karma <n>   set karma exactly (gang unlock threshold is -54000)',
	'  --help        show this',
	'Note: sleeves (SF10) may need one DevMenu -> SourceFiles -> SF10 click to populate',
	'      (recalculateNumberOfOwnedSleeves is module-scoped, not reachable from a script).',
].join('\n');

/** Parse an ns.flags string value into a finite number, or null if blank/invalid. */
function asNum(v: unknown): number | null {
	const s = String(v ?? '').trim();
	if (s === '') return null;
	const n = Number(s);
	return Number.isFinite(n) ? n : null;
}

export async function main(ns: NS): Promise<void> {
	const flags = ns.flags([
		['sf', ''],
		['level', 3],
		['money', ''],
		['ram', ''],
		['exp', ''],
		['karma', ''],
		['help', false],
	]);

	if (flags.help) { ns.tprint('\n' + USAGE); return; }

	// Reach the live Player singleton (dev builds only). eval keeps this 0 GB and
	// hides the global from the static RAM analyzer (same as lib/react.ts).
	// eslint-disable-next-line no-eval
	const P = eval('globalThis.Bitburner && globalThis.Bitburner.Player') as any;
	if (!P) {
		ns.tprint('ERROR: dev cheats unavailable — globalThis.Bitburner.Player is undefined.');
		ns.tprint('This only works in a DEV build (run the game with `npm run start:dev` from bitburner-src).');
		return;
	}

	const fmt = (n: number) => ns.format.number(n);
	const changed: string[] = [];

	// ── SourceFiles (the primary purpose: unlock a gated feature) ──────────────
	const sfSpec = String(flags.sf).trim();
	if (sfSpec !== '') {
		const level = (asNum(flags.level) ?? 3) | 0;
		const list = sfSpec.toLowerCase() === 'all'
			? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]
			: sfSpec.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0);
		try {
			for (const n of list) {
				P.sourceFiles.set(n, level);
				P.bitNodeOptions.sourceFileOverrides.set(n, level);
			}
			if (typeof P.reapplyAllSourceFiles === 'function') P.reapplyAllSourceFiles();
			if (typeof P.reapplyAllAugmentations === 'function') P.reapplyAllAugmentations();
			changed.push(`SF[${list.join(',')}]@${level}`);
			if (list.includes(10)) {
				ns.tprint('Note: if sleeves stay at 0, click DevMenu → SourceFiles → SF10 once (populates sleeve count).');
			}
		} catch (e) { ns.tprint(`WARN: set SourceFiles failed: ${String(e)}`); }
	}

	// ── Money ──────────────────────────────────────────────────────────────────
	const money = asNum(flags.money);
	if (money !== null) { try { P.money = money; changed.push(`money=$${fmt(money)}`); } catch (e) { ns.tprint(`WARN: money: ${String(e)}`); } }

	// ── Home RAM ─────────────────────────────────────────────────────────────────
	const ram = asNum(flags.ram);
	if (ram !== null) {
		try { P.getHomeComputer().maxRam = ram; changed.push(`homeRAM=${ns.format.ram(ram)}`); }
		catch (e) { ns.tprint(`WARN: ram: ${String(e)}`); }
	}

	// ── Skill exp ────────────────────────────────────────────────────────────────
	const exp = asNum(flags.exp);
	if (exp !== null) {
		try {
			for (const k of SKILL_KEYS) P.exp[k] = exp;
			P.updateSkillLevels();
			changed.push(`skills(exp=${fmt(exp)})`);
		} catch (e) { ns.tprint(`WARN: exp: ${String(e)}`); }
	}

	// ── Karma ──────────────────────────────────────────────────────────────────────
	const karma = asNum(flags.karma);
	if (karma !== null) { try { P.karma = karma; changed.push(`karma=${fmt(karma)}`); } catch (e) { ns.tprint(`WARN: karma: ${String(e)}`); } }

	if (changed.length === 0) {
		ns.tprint('DEV CHEAT: nothing requested (no-op). Name a knob to grant it.\n' + USAGE);
		return;
	}
	ns.tprint('DEV CHEAT applied (surgical): ' + changed.join(' · '));
}
