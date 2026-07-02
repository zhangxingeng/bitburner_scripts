import {
    NS, FactionWorkType, CompanyName, JobField, JobName,
    PlayerRequirement, CompanyReputationRequirement,
} from '@ns';
import { formatTime, shortNumber } from '../lib/format';
import { executeCommand } from '../lib/ns_dodge';
import { hasSF4 } from '../lib/sf_check';

// ── Faction priority list ─────────────────────────────────────────────────────
// Mirrors alainbryden's preferredEarlyFactionOrder with full-game coverage.
// Earlier entries are worked before later ones when scope allows (scope 1).
const FACTION_PRIORITY: string[] = [
    'Netburners', 'Tian Di Hui', 'Aevum',
    'CyberSec', 'NiteSec', 'Tetrads',
    'Daedalus', 'Bachman & Associates',
    'BitRunners', 'The Black Hand', 'The Dark Army',
    'Clarke Incorporated', 'OmniTek Incorporated', 'NWO',
    'Chongqing', 'ECorp', 'Fulcrum Secret Technologies',
    'MegaCorp', 'KuaiGong International', 'Four Sigma',
    'Blade Industries', 'Illuminati', 'The Covenant',
    'Slum Snakes', 'Speakers for the Dead', 'The Syndicate',
    'Volhaven', 'Sector-12', 'New Tokyo', 'Ishima',
];

// City-locked factions and their required city of residence.
const CITY_FACTIONS: Record<string, string> = {
    Aevum:     'Aevum',
    Chongqing: 'Chongqing',
    'Sector-12': 'Sector-12',
    'New Tokyo': 'New Tokyo',
    Ishima:    'Ishima',
    Volhaven:  'Volhaven',
};

// Hacking level required before working for (or receiving invites from) these factions.
const FACTION_HACK_REQ: Record<string, number> = {
    'NiteSec':        80,
    'BitRunners':    200,
    'The Black Hand':300,
    'Daedalus':     2500,
};

// Karma threshold for gang-invite eligible factions.
const GANG_KARMA_THRESHOLD = -54_000;
const GANG_FACTIONS = new Set(['Daedalus', 'The Black Hand', 'The Dark Army', 'Speakers for the Dead']);

// Factions whose best work type is always hacking.
const HACKING_FACTIONS = new Set([
    'CyberSec', 'NiteSec', 'BitRunners', 'The Black Hand',
    'Netburners', 'Tian Di Hui', 'Daedalus',
]);

// Factions whose best work type is combat/field.
const COMBAT_FACTIONS = new Set([
    'Slum Snakes', 'Tetrads', 'The Syndicate', 'The Dark Army',
    'Speakers for the Dead', 'Volhaven',
]);

// ── Tuning ────────────────────────────────────────────────────────────────────

const STATUS_UPDATE_INTERVAL_MS = 5_000;
const MEASUREMENT_DURATION_MS   = 1_000;
const MEASUREMENT_FREQUENCY     = 20;   // ticks between rep-rate re-measurements
const TIME_MARGIN_PERCENT       = 0.10; // add 10 % margin to estimated work duration
const SCOPE_MAX                 = 2;    // 1 = priority factions; 2 = all joined
const IDLE_SLEEP_MS             = 30_000;

// ── Types ─────────────────────────────────────────────────────────────────────

interface FactionWorkTarget {
    type:          'FACTION';
    factionName:   string;
    augName:       string;
    repNeeded:     number;
    repCurrent:    number;
    repPerSecond:  number;
    timeRemaining: number; // seconds
}

/**
 * A gate on joining `gatedFaction`: the player must reach `repNeeded` reputation
 * with `companyName` (via employment there) to unlock the faction invitation.
 */
interface CompanyWorkTarget {
    type:          'COMPANY';
    companyName:   CompanyName;
    gatedFaction:  string;
    field:         JobField;
    repNeeded:     number;
    repCurrent:    number;
    repPerSecond:  number;
    timeRemaining: number; // seconds
}

type WorkTarget = FactionWorkTarget | CompanyWorkTarget;

interface CurrentWork {
    type:             'FACTION' | 'COMPANY' | '';
    factionName?:     string;
    factionWorkType?: FactionWorkType;
    companyName?:     CompanyName;
}

/** Module-level rep-gain rate cache (per faction, and per "company:<name>" key). */
const repRateCache = new Map<string, { rate: number; timestamp: number }>();

/**
 * Module-level cache of the (single) companyReputation gate requirement found in
 * each faction's invite requirement tree — null when a faction has no such gate.
 * Static per faction, so this is fetched via ns_dodge only once per faction ever.
 */
const companyGateCache = new Map<string, CompanyReputationRequirement | null>();

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * Faction Manager — join eligible factions, choose optimal work type,
 * handle prerequisites (city travel, hacking level, karma), and grind rep
 * for the next unowned augmentation.
 *
 * Scope system (alainbryden-style):
 *   scope 1 → FACTION_PRIORITY factions only (highest value first)
 *   scope 2 → all joined factions (fallback if scope-1 has nothing)
 * Scope resets to 1 whenever work is found.
 *
 * Usage: run /player/faction_manager.js
 */
export async function main(ns: NS): Promise<void> {
    ns.disableLog('ALL');
    ns.ui.openTail();
    ns.ui.setTailTitle('Faction Manager');

    // Guard: Singularity API required (SF4).
    if (!hasSF4(ns)) {
        ns.tprint('ERROR: faction_manager requires SF4 (Singularity). Exiting.');
        return;
    }

    let scope     = 1;
    let tickCount = 0;

    while (true) {
        // Auto-join any pending invitations
        await joinEligibleFactions(ns);

        const shouldMeasure = tickCount % MEASUREMENT_FREQUENCY === 0;
        const target = await findBestTarget(ns, scope, shouldMeasure);

        if (!target) {
            if (scope < SCOPE_MAX) {
                ns.print(`No work at scope ${scope} — expanding to scope ${scope + 1}`);
                scope++;
            } else {
                ns.print(`No faction or company-gate work available at any scope. Waiting ${IDLE_SLEEP_MS / 1000}s.`);
                // Idle karma grinding (crime.ts) runs as its own independently
                // auto-toggle-gated daemon; it is not launched or referenced here.
                await ns.sleep(IDLE_SLEEP_MS);
                scope = 1;
            }
            tickCount++;
            continue;
        }

        // Work found — reset scope and execute
        scope = 1;
        if (target.type === 'FACTION') {
            ns.print(`\nTarget: ${target.factionName} for aug "${target.augName}"`);
        } else {
            ns.print(`\nTarget: ${target.companyName} rep to unlock faction "${target.gatedFaction}"`);
        }
        ns.print(`Rep: ${shortNumber(target.repCurrent)} / ${shortNumber(target.repNeeded)}`);
        ns.print(`ETA: ${formatTime(target.timeRemaining * 1000)}`);

        await workContinuously(ns, target);
        tickCount++;
    }
}

// ── Faction auto-join ─────────────────────────────────────────────────────────

/** Join all pending faction invitations. */
async function joinEligibleFactions(ns: NS): Promise<void> {
    const invitations = await executeCommand<string[]>(ns, 'ns.singularity.checkFactionInvitations()') ?? [];
    for (const faction of invitations) {
        const joined = await executeCommand<boolean>(ns, `ns.singularity.joinFaction("${faction}")`);
        if (joined) ns.print(`Joined faction: ${faction}`);
    }
}

// ── Target selection ──────────────────────────────────────────────────────────

/**
 * Find the best faction to work for, limited by scope.
 * Returns the faction + aug target with the shortest ETA, or null if nothing to do.
 */
async function findBestTarget(
    ns: NS,
    scope: number,
    measureRepRates: boolean,
): Promise<WorkTarget | null> {
    const player     = ns.getPlayer();
    // Cast FactionName[] → string[] so we can compare freely with our string constants.
    const allJoined  = [...player.factions] as string[];
    const ownedAugs  = await executeCommand<string[]>(
        ns, 'ns.singularity.getOwnedAugmentations(true)',
    ) ?? [];

    // Scope 1: prioritised subset; scope 2: all joined.
    const candidates: string[] = scope === 1
        ? FACTION_PRIORITY.filter(f => allJoined.includes(f))
        : allJoined;

    const targets: FactionWorkTarget[] = [];

    for (const faction of candidates) {
        // Skip factions whose prerequisites we cannot yet meet.
        if (!await checkPrerequisites(ns, faction)) continue;

        const availableAugs = await executeCommand<string[]>(
            ns, `ns.singularity.getAugmentationsFromFaction("${faction}")`,
        ) ?? [];

        const unowned = availableAugs.filter(aug => !ownedAugs.includes(aug));
        if (unowned.length === 0) continue;

        const currentRep = await executeCommand<number>(
            ns, `ns.singularity.getFactionRep("${faction}")`,
        ) ?? 0;

        let repPerSecond: number;
        const cached = repRateCache.get(faction);
        if (!measureRepRates && cached) {
            repPerSecond = cached.rate;
        } else {
            repPerSecond = await measureRepGainRate(ns, faction);
            repRateCache.set(faction, { rate: repPerSecond, timestamp: Date.now() });
        }

        for (const aug of unowned) {
            const repNeeded = await executeCommand<number>(
                ns, `ns.singularity.getAugmentationRepReq("${aug}")`,
            ) ?? 0;
            if (currentRep >= repNeeded || repPerSecond <= 0) continue;

            targets.push({
                type:          'FACTION',
                factionName:   faction,
                augName:       aug,
                repNeeded,
                repCurrent:    currentRep,
                repPerSecond,
                timeRemaining: (repNeeded - currentRep) / repPerSecond,
            });
        }
    }

    // Keep only the fastest aug per faction.
    const byFaction = new Map<string, FactionWorkTarget>();
    for (const t of targets) {
        const prev = byFaction.get(t.factionName);
        if (!prev || t.timeRemaining < prev.timeRemaining) byFaction.set(t.factionName, t);
    }

    // Merge in company-reputation gates for not-yet-joined factions so that
    // company-gate work and faction-rep work compete fairly for the one work slot.
    const companyTargets = await findCompanyGateTargets(ns, measureRepRates);

    const merged: WorkTarget[] = [...byFaction.values(), ...companyTargets];
    const sorted = merged.sort((a, b) => a.timeRemaining - b.timeRemaining);

    if (sorted.length > 0) {
        ns.print('\nWork priorities (shortest ETA first):');
        sorted.slice(0, 5).forEach((t, i) => {
            const label = t.type === 'FACTION'
                ? `${t.factionName} — ${t.augName}`
                : `${t.companyName} rep → unlock ${t.gatedFaction}`;
            ns.print(`  ${i + 1}. ${label} (${formatTime(t.timeRemaining * 1000)})`);
        });
    }

    return sorted[0] ?? null;
}

// ── Company-reputation gates ───────────────────────────────────────────────────

/**
 * Recursively walk a faction invite requirement tree looking for a
 * `companyReputation` leaf requirement. `not`-typed requirements are ignored
 * (per this file's existing partial-coverage precedent in checkPrerequisites);
 * `everyCondition`/`someCondition` both recurse into their `.conditions` array,
 * returning the first companyReputation leaf found.
 */
function findCompanyReputationRequirement(
    requirements: PlayerRequirement[],
): CompanyReputationRequirement | null {
    for (const req of requirements) {
        if (req.type === 'companyReputation') return req;
        if (req.type === 'everyCondition' || req.type === 'someCondition') {
            const found = findCompanyReputationRequirement(req.conditions);
            if (found) return found;
        }
        // 'not' and other leaf requirement types are not relevant here.
    }
    return null;
}

/**
 * Fetch (and cache) the companyReputation gate — if any — blocking invitation
 * to `faction`. Cached forever per faction since invite requirements are static
 * and re-fetching would spin up a real temp script via ns_dodge every tick.
 */
async function getCompanyGateRequirement(
    ns: NS, faction: string,
): Promise<CompanyReputationRequirement | null> {
    if (companyGateCache.has(faction)) return companyGateCache.get(faction) ?? null;

    const requirements = await executeCommand<PlayerRequirement[]>(
        ns, `ns.singularity.getFactionInviteRequirements("${faction}")`,
    ) ?? [];
    const gate = findCompanyReputationRequirement(requirements);
    companyGateCache.set(faction, gate);
    return gate;
}

/**
 * Build work targets for every not-yet-joined FACTION_PRIORITY faction that is
 * gated behind a companyReputation requirement we haven't yet satisfied.
 */
async function findCompanyGateTargets(
    ns: NS,
    measureRepRates: boolean,
): Promise<CompanyWorkTarget[]> {
    const player    = ns.getPlayer();
    const allJoined = [...player.factions] as string[];

    const targets: CompanyWorkTarget[] = [];

    for (const faction of FACTION_PRIORITY) {
        if (allJoined.includes(faction)) continue;

        const gate = await getCompanyGateRequirement(ns, faction);
        if (!gate) continue;

        const companyName = gate.company;
        const repCurrent = await executeCommand<number>(
            ns, `ns.singularity.getCompanyRep("${companyName}")`,
        ) ?? 0;
        if (repCurrent >= gate.reputation) continue; // Gate already satisfied.

        const field = await resolveCompanyField(ns, companyName);

        let repPerSecond: number;
        const cacheKey = `company:${companyName}`;
        const cached   = repRateCache.get(cacheKey);
        if (!measureRepRates && cached) {
            repPerSecond = cached.rate;
        } else {
            repPerSecond = await measureCompanyRepGainRate(ns, companyName, field);
            repRateCache.set(cacheKey, { rate: repPerSecond, timestamp: Date.now() });
        }
        if (repPerSecond <= 0) continue;

        targets.push({
            type:          'COMPANY',
            companyName,
            gatedFaction:  faction,
            field,
            repNeeded:     gate.reputation,
            repCurrent,
            repPerSecond,
            timeRemaining: (gate.reputation - repCurrent) / repPerSecond,
        });
    }

    return targets;
}

// ── Prerequisites ─────────────────────────────────────────────────────────────

/**
 * Check and handle faction prerequisites (city travel, hacking level, karma).
 * Returns true when this faction is ready to work for, false if blocked.
 */
async function checkPrerequisites(ns: NS, faction: string): Promise<boolean> {
    const player = ns.getPlayer();

    // City factions: travel there if not already resident.
    const requiredCity = CITY_FACTIONS[faction];
    if (requiredCity && player.city !== requiredCity) {
        const ok = await executeCommand<boolean>(
            ns, `ns.singularity.travelToCity("${requiredCity}")`,
        );
        if (!ok) {
            ns.print(`Cannot travel to ${requiredCity} for ${faction} (insufficient funds?)`);
            return false;
        }
        ns.print(`Traveled to ${requiredCity} for ${faction}`);
    }

    // Hacking level requirement: study at university until met.
    const hackReq = FACTION_HACK_REQ[faction] ?? 0;
    if (hackReq > 0 && player.skills.hacking < hackReq) {
        ns.print(
            `Hack ${player.skills.hacking}/${hackReq} required for ${faction}. ` +
            'Starting Algorithms course at Rothman University.',
        );
        await executeCommand(
            ns, 'ns.singularity.universityCourse("Rothman University", "Algorithms", false)',
        );
        return false; // Re-evaluated next tick
    }

    // Karma check for gang-invite eligible factions (Daedalus, TBH, TDA, SftD).
    if (GANG_FACTIONS.has(faction)) {
        const karma = ns.heart.break();
        if (karma > GANG_KARMA_THRESHOLD) {
            ns.print(
                `${faction} needs karma ≤ ${GANG_KARMA_THRESHOLD} (current: ${shortNumber(karma)}). ` +
                'Waiting for karma to grind down independently (crime.ts).',
            );
            return false;
        }
    }

    return true;
}

// ── Continuous work loop ──────────────────────────────────────────────────────

/** Dispatch to the faction- or company-work loop, whichever the target needs. */
async function workContinuously(ns: NS, target: WorkTarget): Promise<void> {
    if (target.type === 'FACTION') {
        await workForFactionContinuously(ns, target);
    } else {
        await workForCompanyContinuously(ns, target);
    }
}

/** Work for the target faction until the required rep is reached. */
async function workForFactionContinuously(ns: NS, target: FactionWorkTarget): Promise<void> {
    const focused  = await executeCommand<boolean>(ns, 'ns.singularity.isFocused()') ?? false;
    const workType = chooseBestWorkType(ns, target.factionName);

    if (!await startWorkForFaction(ns, target.factionName, workType, focused)) {
        ns.print(`Failed to start working for ${target.factionName}. Retrying next tick.`);
        await ns.sleep(5_000);
        return;
    }

    const workDeadline = Date.now() + target.timeRemaining * 1000 * (1 + TIME_MARGIN_PERCENT);
    const startTime    = Date.now();
    const startRep     = target.repCurrent;

    while (true) {
        // Check work wasn't interrupted by something else.
        if (!await isWorkingForFaction(ns, target.factionName)) {
            ns.print(`Work interrupted for ${target.factionName} — restarting`);
            if (!await startWorkForFaction(ns, target.factionName, workType, focused)) return;
        }

        const currentRep = await executeCommand<number>(
            ns, `ns.singularity.getFactionRep("${target.factionName}")`,
        ) ?? 0;
        const elapsed = Date.now() - startTime;

        if (currentRep >= target.repNeeded) {
            ns.print(`SUCCESS: Reached rep ${shortNumber(target.repNeeded)} with ${target.factionName}`);
            return;
        }

        if (Date.now() >= workDeadline) {
            const actualRate = (currentRep - startRep) / (elapsed / 1000);
            ns.print(
                `Time allocation for ${target.factionName} elapsed. ` +
                `Actual rate: ${shortNumber(actualRate)}/s vs expected ${shortNumber(target.repPerSecond)}/s`,
            );
            return;
        }

        const pct       = ((currentRep / target.repNeeded) * 100).toFixed(1);
        const remaining = (target.repNeeded - currentRep) / target.repPerSecond;
        ns.print(
            `${target.factionName}: ${shortNumber(currentRep)}/${shortNumber(target.repNeeded)} ` +
            `(${pct}%) | ETA ${formatTime(remaining * 1000)} | elapsed ${formatTime(elapsed)}`,
        );

        await ns.sleep(STATUS_UPDATE_INTERVAL_MS);
    }
}

/** Work for the target company until enough reputation is banked to unlock its gated faction. */
async function workForCompanyContinuously(ns: NS, target: CompanyWorkTarget): Promise<void> {
    const focused = await executeCommand<boolean>(ns, 'ns.singularity.isFocused()') ?? false;

    if (!await startWorkForCompany(ns, target.companyName, target.field, focused)) {
        ns.print(`Failed to start working for ${target.companyName}. Retrying next tick.`);
        await ns.sleep(5_000);
        return;
    }

    const workDeadline = Date.now() + target.timeRemaining * 1000 * (1 + TIME_MARGIN_PERCENT);
    const startTime    = Date.now();
    const startRep     = target.repCurrent;

    while (true) {
        // Check work wasn't interrupted by something else.
        if (!await isWorkingForCompany(ns, target.companyName)) {
            ns.print(`Work interrupted for ${target.companyName} — restarting`);
            if (!await startWorkForCompany(ns, target.companyName, target.field, focused)) return;
        }

        const currentRep = await executeCommand<number>(
            ns, `ns.singularity.getCompanyRep("${target.companyName}")`,
        ) ?? 0;
        const elapsed = Date.now() - startTime;

        if (currentRep >= target.repNeeded) {
            ns.print(
                `SUCCESS: Reached rep ${shortNumber(target.repNeeded)} with ${target.companyName} ` +
                `(unlocks ${target.gatedFaction} invite)`,
            );
            return; // joinEligibleFactions() picks up the new invite next tick.
        }

        if (Date.now() >= workDeadline) {
            const actualRate = (currentRep - startRep) / (elapsed / 1000);
            ns.print(
                `Time allocation for ${target.companyName} elapsed. ` +
                `Actual rate: ${shortNumber(actualRate)}/s vs expected ${shortNumber(target.repPerSecond)}/s`,
            );
            return;
        }

        const pct       = ((currentRep / target.repNeeded) * 100).toFixed(1);
        const remaining = (target.repNeeded - currentRep) / target.repPerSecond;
        ns.print(
            `${target.companyName}: ${shortNumber(currentRep)}/${shortNumber(target.repNeeded)} ` +
            `(${pct}%) | ETA ${formatTime(remaining * 1000)} | elapsed ${formatTime(elapsed)} ` +
            `| unlocks ${target.gatedFaction}`,
        );

        await ns.sleep(STATUS_UPDATE_INTERVAL_MS);
    }
}

// ── Rep-gain measurement ──────────────────────────────────────────────────────

/**
 * Temporarily start working for a faction, measure rep/s for 1 s, then restore
 * the previous action. Returns rep per second.
 */
async function measureRepGainRate(ns: NS, faction: string): Promise<number> {
    const savedWork  = await executeCommand<CurrentWork | null>(ns, 'ns.singularity.getCurrentWork()');
    const wasFocused = await executeCommand<boolean>(ns, 'ns.singularity.isFocused()') ?? false;
    const workType   = chooseBestWorkType(ns, faction);

    if (!await startWorkForFaction(ns, faction, workType, wasFocused)) return 0;

    const before = await executeCommand<number>(ns, `ns.singularity.getFactionRep("${faction}")`) ?? 0;
    await ns.sleep(MEASUREMENT_DURATION_MS);
    const after  = await executeCommand<number>(ns, `ns.singularity.getFactionRep("${faction}")`) ?? 0;

    await restorePreviousWork(ns, savedWork, wasFocused);
    return (after - before) * (1000 / MEASUREMENT_DURATION_MS);
}

/**
 * Temporarily start working for a company, measure rep/s for 1 s, then restore
 * the previous action. Returns rep per second.
 */
async function measureCompanyRepGainRate(ns: NS, companyName: CompanyName, field: JobField): Promise<number> {
    const savedWork  = await executeCommand<CurrentWork | null>(ns, 'ns.singularity.getCurrentWork()');
    const wasFocused = await executeCommand<boolean>(ns, 'ns.singularity.isFocused()') ?? false;

    if (!await startWorkForCompany(ns, companyName, field, wasFocused)) return 0;

    const before = await executeCommand<number>(ns, `ns.singularity.getCompanyRep("${companyName}")`) ?? 0;
    await ns.sleep(MEASUREMENT_DURATION_MS);
    const after  = await executeCommand<number>(ns, `ns.singularity.getCompanyRep("${companyName}")`) ?? 0;

    await restorePreviousWork(ns, savedWork, wasFocused);
    return (after - before) * (1000 / MEASUREMENT_DURATION_MS);
}

async function restorePreviousWork(ns: NS, work: CurrentWork | null, focused: boolean): Promise<void> {
    if (!work?.type) {
        await executeCommand(ns, 'ns.singularity.stopAction()');
        return;
    }
    if (work.type === 'FACTION' && work.factionName && work.factionWorkType) {
        await startWorkForFaction(ns, work.factionName, work.factionWorkType, focused);
    } else if (work.type === 'COMPANY' && work.companyName) {
        // Reuse whatever field the player is already employed under at this
        // company — applyToCompany with a different field would restart them
        // at that ladder's entry position and discard promotion progress.
        const field = await resolveCompanyField(ns, work.companyName);
        await startWorkForCompany(ns, work.companyName, field, focused);
    } else {
        await executeCommand(ns, 'ns.singularity.stopAction()');
    }
}

// ── Work type selection ───────────────────────────────────────────────────────

/**
 * Choose the best work type for a faction based on faction category and player stats.
 * Hacking factions → hacking; combat factions → field/security; others → highest stat.
 */
function chooseBestWorkType(ns: NS, faction: string): FactionWorkType {
    if (HACKING_FACTIONS.has(faction)) return 'hacking' as FactionWorkType;

    const player     = ns.getPlayer();
    const combatAvg  = (player.skills.strength + player.skills.defense +
                        player.skills.dexterity + player.skills.agility) / 4;

    if (COMBAT_FACTIONS.has(faction)) {
        return (player.skills.charisma > combatAvg ? 'security' : 'field') as FactionWorkType;
    }

    // Mixed/corp factions: pick based on highest player stat.
    if (player.skills.hacking >= combatAvg && player.skills.hacking >= player.skills.charisma) {
        return 'hacking' as FactionWorkType;
    }
    return (player.skills.charisma >= combatAvg ? 'security' : 'field') as FactionWorkType;
}

/**
 * Pick a company job field ('Software' vs 'Business') via the same
 * hacking-vs-charisma heuristic chooseBestWorkType() uses for mixed factions.
 */
function chooseCompanyField(ns: NS): JobField {
    const player = ns.getPlayer();
    return (player.skills.hacking >= player.skills.charisma ? 'Software' : 'Business') as JobField;
}

/**
 * Resolve the job field to use at `companyName`. If the player is already
 * employed there, reuse THAT job's field (recovered via getCompanyPositionInfo)
 * so repeat applyToCompany calls auto-promote up the same ladder instead of
 * restarting them at a different ladder's entry position.
 */
async function resolveCompanyField(ns: NS, companyName: CompanyName): Promise<JobField> {
    const player     = ns.getPlayer();
    const currentJob = player.jobs[companyName];
    if (currentJob) {
        const info = await executeCommand<{ field: JobField } | null>(
            ns, `ns.singularity.getCompanyPositionInfo("${companyName}", "${currentJob}")`,
        );
        if (info?.field) return info.field;
    }
    return chooseCompanyField(ns);
}

// ── Singularity wrappers ──────────────────────────────────────────────────────

async function startWorkForFaction(
    ns: NS, faction: string, workType: FactionWorkType, focus: boolean,
): Promise<boolean> {
    return await executeCommand<boolean>(
        ns, `ns.singularity.workForFaction("${faction}", "${workType}", ${focus})`,
    ) ?? false;
}

async function isWorkingForFaction(ns: NS, factionName: string): Promise<boolean> {
    const work = await executeCommand<CurrentWork | null>(ns, 'ns.singularity.getCurrentWork()');
    return work?.type === 'FACTION' && work.factionName === factionName;
}

/**
 * Apply to `companyName` under `field` (a no-op promotion attempt if already
 * employed there under that same field — see resolveCompanyField), then start
 * working. Never call this with a field other than the one resolved for an
 * already-held job at that company.
 */
async function startWorkForCompany(
    ns: NS, companyName: CompanyName, field: JobField, focus: boolean,
): Promise<boolean> {
    await executeCommand<JobName | null>(
        ns, `ns.singularity.applyToCompany("${companyName}", "${field}")`,
    );
    return await executeCommand<boolean>(
        ns, `ns.singularity.workForCompany("${companyName}", ${focus})`,
    ) ?? false;
}

async function isWorkingForCompany(ns: NS, companyName: CompanyName): Promise<boolean> {
    const work = await executeCommand<CurrentWork | null>(ns, 'ns.singularity.getCurrentWork()');
    return work?.type === 'COMPANY' && work.companyName === companyName;
}
