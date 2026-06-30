import type { NS } from '@ns';

/**
 * ⚠️ DEV-ONLY cheat tool — NOT part of the autonomous gameplay system.
 *
 * Boundary (user-ratified 2026-06-30): cheating is for DEVELOPMENT ONLY. This
 * script is deliberately segregated under src/dev/, is NEVER imported by any
 * production module, and is NEVER auto-launched (absent from SCRIPT_PATHS /
 * DAEMON_CATALOG / the manager registry). It exists solely to validate
 * SF/BitNode-gated automation (gang/corp/bladeburner/sleeve/stanek/grafting,
 * and SF4 Singularity) in a dev game without grinding to unlock the SourceFiles.
 *
 * How it works (recon of ../bitburner-src): dev builds expose the live Player
 * singleton at `globalThis.Bitburner.Player` (src/engine.tsx, gated on
 * NODE_ENV==='development'). We reach it via eval('globalThis') — 0 GB, same
 * trick lib/react.ts uses for the DOM. In a PRODUCTION build that global is
 * undefined, so this script no-ops with an error — the guard IS the boundary.
 *
 * Setting a SourceFile (both Player.sourceFiles and
 * bitNodeOptions.sourceFileOverrides) unlocks canAccessBitNodeFeature(n)
 * immediately — no reset needed.
 *
 * Usage:
 *   run /dev/cheat.js                 # grant everything (money, RAM, skills, karma, all SFs)
 *   run /dev/cheat.js --money 1e12
 *   run /dev/cheat.js --sf 2,3,6,10,13   # only these SourceFiles (level 3)
 *   run /dev/cheat.js --sf none --ram 0  # skip SFs and RAM
 *   run /dev/cheat.js --help
 */

const ALL_SF = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
const SKILL_KEYS = ['hacking', 'strength', 'defense', 'dexterity', 'agility', 'charisma', 'intelligence'] as const;

const USAGE = [
	'DEV-ONLY cheat tool (works only in a dev build — npm run dev in bitburner-src).',
	'  --money <n>   set money (default 1e15; 0 to skip)',
	'  --ram <gb>    set home max RAM (default 1048576; 0 to skip)',
	'  --exp <n>     exp dumped into every skill (default 1e12)',
	'  --skills      level up all skills (default true; --skills=false to skip)',
	'  --sf <spec>   "all" (default) | comma list e.g. 2,3,6,10,13 | "none" — granted at level 3',
	'  --karma <n>   set karma (default -1e6; enables gang creation)',
	'  --help        show this',
	'Note: sleeves (SF10) may need one DevMenu→SourceFiles→SF10 click to populate',
	'      (recalculateNumberOfOwnedSleeves is module-scoped, not reachable from a script).',
].join('\n');

export async function main(ns: NS): Promise<void> {
	const flags = ns.flags([
		['money', 1e15],
		['ram', 1048576],
		['exp', 1e12],
		['skills', true],
		['sf', 'all'],
		['karma', -1e6],
		['help', false],
	]);

	if (flags.help) { ns.tprint('\n' + USAGE); return; }

	// Reach the live Player singleton (dev builds only). eval keeps this 0 GB and
	// hides the global from the static RAM analyzer (same as lib/react.ts).
	// eslint-disable-next-line no-eval
	const P = eval('globalThis.Bitburner && globalThis.Bitburner.Player') as any;
	if (!P) {
		ns.tprint('ERROR: dev cheats unavailable — globalThis.Bitburner.Player is undefined.');
		ns.tprint('This only works in a DEV build (run the game with `npm run dev` from bitburner-src).');
		return;
	}

	const changed: string[] = [];

	const money = flags.money as number;
	if (money > 0) { P.money = money; changed.push(`money=$${ns.formatNumber(money)}`); }

	const ram = flags.ram as number;
	if (ram > 0) {
		try { P.getHomeComputer().maxRam = ram; changed.push(`homeRAM=${ns.formatNumber(ram)}GB`); }
		catch (e) { ns.tprint(`WARN: set RAM failed: ${String(e)}`); }
	}

	if (flags.skills) {
		const amt = flags.exp as number;
		try {
			for (const k of SKILL_KEYS) P.exp[k] = amt;
			P.updateSkillLevels();
			changed.push(`skills(exp=${ns.formatNumber(amt)})`);
		} catch (e) { ns.tprint(`WARN: set skills failed: ${String(e)}`); }
	}

	const karma = flags.karma as number;
	try { P.karma = karma; changed.push(`karma=${ns.formatNumber(karma)}`); }
	catch (e) { ns.tprint(`WARN: set karma failed: ${String(e)}`); }

	const sfSpec = String(flags.sf);
	if (sfSpec !== 'none') {
		const list = sfSpec === 'all'
			? ALL_SF
			: sfSpec.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0);
		try {
			for (const n of list) {
				P.sourceFiles.set(n, 3);
				P.bitNodeOptions.sourceFileOverrides.set(n, 3);
			}
			if (typeof P.reapplyAllSourceFiles === 'function') P.reapplyAllSourceFiles();
			changed.push(`SF[${list.join(',')}]@3`);
		} catch (e) { ns.tprint(`WARN: set SourceFiles failed: ${String(e)}`); }
	}

	try { if (typeof P.reapplyAllAugmentations === 'function') P.reapplyAllAugmentations(); } catch { /* best effort */ }

	ns.tprint('DEV CHEAT applied: ' + (changed.join(' · ') || '(nothing)'));
	if (sfSpec !== 'none' && (sfSpec === 'all' || sfSpec.split(',').map(s => s.trim()).includes('10'))) {
		ns.tprint('Note: if sleeves stay at 0, click DevMenu → SourceFiles → SF10 once (populates sleeve count).');
	}
}
