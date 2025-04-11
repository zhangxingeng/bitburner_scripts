import { NS } from '@ns';

/** @param {NS} ns */
export async function main(ns: NS): Promise<void> {
    const target = 'n00dles';

    // === Get base times (approx) ===
    const approxHackTime = ns.getHackTime(target);
    const approxGrowTime = ns.getGrowTime(target);
    const approxWeakenTime = ns.getWeakenTime(target);

    const now = Date.now();
    const buffer = 1000;

    const approxEndTime = now + approxWeakenTime + buffer;
    const approxHackStart = approxEndTime - approxHackTime;
    const approxGrowStart = approxEndTime - approxGrowTime;
    const approxWeakenStart = approxEndTime - approxWeakenTime;

    const duration = approxWeakenTime;

    const description = 'approx-batch';
    const manipulateStock = false;
    const silentMisfires = false;
    const loopingMode = false;

    ns.tprint(`🟡 Approx Batch end target: ${toPreciseTime(approxEndTime)}`);

    ns.exec('remote_batch/hack.js', 'home', 1, target, approxHackStart, duration, description, manipulateStock, silentMisfires, loopingMode);
    ns.exec('remote_batch/grow.js', 'home', 1, target, approxGrowStart, duration, description, manipulateStock, silentMisfires, loopingMode);
    ns.exec('remote_batch/weaken.js', 'home', 1, target, approxWeakenStart, duration, description, silentMisfires, loopingMode);

    // === Formula-based version (only if Formulas.exe exists) ===
    if (ns.fileExists('Formulas.exe', 'home')) {
        const server = ns.getServer(target);
        const player = ns.getPlayer();

        const formulaHackTime = ns.formulas.hacking.hackTime(server, player);
        const formulaGrowTime = ns.formulas.hacking.growTime(server, player);
        const formulaWeakenTime = ns.formulas.hacking.weakenTime(server, player);

        const formulaEndTime = Date.now() + formulaWeakenTime + buffer;
        const formulaHackStart = formulaEndTime - formulaHackTime;
        const formulaGrowStart = formulaEndTime - formulaGrowTime;
        const formulaWeakenStart = formulaEndTime - formulaWeakenTime;

        ns.tprint(`🟢 Formula Batch end target: ${toPreciseTime(formulaEndTime)}`);

        ns.exec('remote_batch/hack.js', 'home', 1, target, formulaHackStart, formulaWeakenTime, 'formula-batch', manipulateStock, silentMisfires, loopingMode);
        ns.exec('remote_batch/grow.js', 'home', 1, target, formulaGrowStart, formulaWeakenTime, 'formula-batch', manipulateStock, silentMisfires, loopingMode);
        ns.exec('remote_batch/weaken.js', 'home', 1, target, formulaWeakenStart, formulaWeakenTime, 'formula-batch', silentMisfires, loopingMode);
    } else {
        ns.tprint('⚠️ Formulas.exe not found. Skipping formula-based batch.');
    }
}

// 💡 Utility to print timestamps with ms precision
function toPreciseTime(timestamp: number): string {
    const d = new Date(timestamp);
    return `${d.toLocaleTimeString('en-US', { hour12: false })}.${d.getMilliseconds().toString().padStart(3, '0')}`;
}
