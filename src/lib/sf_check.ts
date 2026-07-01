import type { NS } from '@ns';

/**
 * Owned-source-file check via ns.getResetInfo() — flat 1 GB, not Singularity-gated.
 *
 * The obvious alternative, ns.singularity.getOwnedSourceFiles(), is SF4Cost-gated
 * (SingularityFn3 = 5 GB base, x16 without SF4 = 80 GB — see docs/ram_evasion_rules.md
 * §4). Every existing dodge-script call site for this check
 * (executeCommand(ns, 'ns.singularity.getOwnedSourceFiles()...')) was therefore
 * asking a temp script to launch at up to 80 GB precisely in the one scenario
 * (SF4 not yet owned) it exists to detect — on any home under ~80 GB the temp
 * script's ns.run() returns pid 0 every time, the check silently resolves to
 * `undefined`/false (accidentally "correct" pre-SF4, for the wrong reason), and
 * the never-cleaned-up temp script/result files pile up in tmp/ forever. Use
 * this instead: ownedSF only lists source files with active level > 0, so a
 * missing key means level 0.
 */
export function checkOwnSF(ns: NS, sfNumber: number, lvl = 0): boolean {
    return (ns.getResetInfo().ownedSF.get(sfNumber) ?? 0) >= lvl;
}

/** Shorthand for the single most common check in this repo. */
export function hasSF4(ns: NS): boolean {
    return checkOwnSF(ns, 4);
}
