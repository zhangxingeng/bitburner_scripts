import { NS, Player } from '@ns';
import { CrimeType, GymType, UniversityClassType, CrimeStats } from '../lib/types';
import { shortNumber, formatPercent } from '../lib/format';
import { executeCommand } from '../lib/ns_dodge';
import { saveSubsystem } from '../lib/subsystem_state';
import type { SubsystemStatus } from '../lib/subsystem_state';
import { loadSettings } from '../lib/settings';
import { hasSF4 } from '../lib/sf_check';

/**
 * Crime manager (docs/design/11 idiom) — auto karma/money-crime daemon.
 *
 * Contract: a PERSISTENT daemon, mirroring grafting_manager.ts / gang_manager.ts.
 * Each loop: loadSettings(ns) then hasSF4(ns) FIRST (crime relies entirely on
 * ns.singularity.* — commitCrime, universityCourse, gymWorkout, travelToCity —
 * all SF4-gated). If disabled or SF4 absent, publish { available, enabled,
 * running:false } and idle (DO NOT exit — sequencer keeps it alive so it picks
 * up availability after a dev-cheat SF grant or a toggle flip).
 *
 * Training (university/gym) only works while resident in Sector-12 (Rothman
 * University + Powerhouse Gym are both Sector-12 locations — see
 * NetscriptDefinitions.d.ts LocationName enum) — trainStat() travels there
 * first if needed, otherwise training silently no-ops from any other city.
 */

/** Minimum stats to aim for during baseline training, one stat-step per tick. */
const MIN_STAT_THRESHOLD = 100;
/** Success rate threshold to start training for next crime */
const TRAINING_THRESHOLD = 0.8;
/** Success rate threshold to start committing next crime */
const COMMIT_THRESHOLD = 0.95;

/** City required for university/gym training (Rothman University, Powerhouse Gym). */
const SECTOR_12 = 'Sector-12';

/** Availability/disabled idle cadence — mirrors grafting_manager.ts's SLEEP_MS. */
const IDLE_SLEEP_MS = 10_000;

/** Available crimes to consider, roughly easiest → hardest (re-sorted by live success chance anyway). */
const AVAILABLE_CRIMES = [
    CrimeType.shoplift,
    CrimeType.robStore,
    CrimeType.mug,
    CrimeType.larceny,
    CrimeType.dealDrugs,
    CrimeType.bondForgery,
    CrimeType.traffickArms,
    CrimeType.homicide,
    CrimeType.grandTheftAuto,
    CrimeType.kidnap,
    CrimeType.assassination,
    CrimeType.heist,
];

/**
 * Main script function
 * @param {NS} ns - Netscript API
 */
export async function main(ns: NS): Promise<void> {
    ns.disableLog('ALL');

    while (true) {
        const settings = loadSettings(ns);
        const enabled = settings.autoCrime;
        const available = hasSF4(ns);

        // ── Availability/enabled guard — mirrors grafting_manager.ts exactly ──
        if (!enabled || !available) {
            saveSubsystem(ns, {
                id: 'crime',
                available,
                enabled,
                running: false,
                headline: available
                    ? 'Crime idle (autoCrime disabled)'
                    : 'Crime unavailable (need SF4 / Singularity API)',
                metrics: {},
                ts: Date.now(),
            });
            await ns.sleep(IDLE_SLEEP_MS);
            continue;
        }

        // ── Per-tick baseline training check (one stat-step per tick — reacts
        // to the toggle within a single tick instead of a blocking pre-loop
        // training phase) ──────────────────────────────────────────────────
        const player = ns.getPlayer();
        if (!checkAllStatsAboveThreshold(player)) {
            const lowestStat = findLowestStat(player);
            saveSubsystem(ns, {
                id: 'crime',
                available: true,
                enabled,
                running: true,
                headline: `Training ${lowestStat.name} (${lowestStat.value}) toward ${MIN_STAT_THRESHOLD} baseline`,
                metrics: { statTraining: lowestStat.name, statValue: lowestStat.value },
                ts: Date.now(),
            });
            await trainStat(ns, lowestStat.name);
            continue;
        }

        // Build the dynamic crime ladder based on current success rates
        const crimeLadder = await buildCrimeLadder(ns);

        // Find the current crime index (highest crime with sufficient success rate)
        const currentCrimeIndex = await findCurrentCrimeIndex(ns, crimeLadder);

        let headline: string;

        // Check if we should commit current crime or train for next
        if (currentCrimeIndex >= 0) {
            const currentCrime = crimeLadder[currentCrimeIndex];
            const currentSuccessRate = await executeCommand<number>(ns, `ns.singularity.getCrimeChance("${currentCrime}")`);

            // If we can move to next crime and it has decent chance, train for it
            if (currentCrimeIndex < crimeLadder.length - 1 && currentSuccessRate >= TRAINING_THRESHOLD) {
                const nextCrime = crimeLadder[currentCrimeIndex + 1];
                const nextCrimeRate = await executeCommand<number>(ns, `ns.singularity.getCrimeChance("${nextCrime}")`);

                if (nextCrimeRate >= COMMIT_THRESHOLD) {
                    // Good enough success rate, commit next crime
                    await myCommitCrime(ns, nextCrime);
                    headline = `Committed ${nextCrime}`;
                } else {
                    // Train to improve for next crime
                    await trainForCrime(ns, nextCrime);
                    headline = `Training toward ${nextCrime}`;
                }
            } else {
                // Commit current crime
                await myCommitCrime(ns, currentCrime);
                headline = `Committed ${currentCrime}`;
            }
        } else {
            // Train for first crime if nothing else is appropriate
            await trainForCrime(ns, crimeLadder[0]);
            headline = `Training toward ${crimeLadder[0]}`;
        }

        // ── Publish status ───────────────────────────────────────────────────
        saveSubsystem(ns, await buildStatus(ns, ns.getPlayer(), headline, enabled));
    }
}

/**
 * Builds a crime ladder sorted by success chance (descending)
 * This creates a dynamic ladder from easiest to hardest crimes
 */
async function buildCrimeLadder(ns: NS): Promise<CrimeType[]> {
    const crimeChances: Array<{ crime: CrimeType, chance: number, profit: number }> = [];

    for (const crime of AVAILABLE_CRIMES) {
        const chance = await executeCommand<number>(ns, `ns.singularity.getCrimeChance("${crime}")`);
        const stats = await executeCommand<CrimeStats>(ns, `ns.singularity.getCrimeStats("${crime}")`);
        const profit = (stats.money * chance) / (stats.time / 1000);
        crimeChances.push({ crime, chance, profit });
    }

    crimeChances.sort((a, b) => b.chance - a.chance);
    return crimeChances.map(c => c.crime);
}

function checkAllStatsAboveThreshold(player: Player): boolean {
    return (
        player.skills.strength >= MIN_STAT_THRESHOLD &&
        player.skills.defense >= MIN_STAT_THRESHOLD &&
        player.skills.dexterity >= MIN_STAT_THRESHOLD &&
        player.skills.agility >= MIN_STAT_THRESHOLD &&
        player.skills.hacking >= MIN_STAT_THRESHOLD &&
        player.skills.charisma >= MIN_STAT_THRESHOLD
    );
}

function findLowestStat(player: Player): { name: string, value: number } {
    const stats = [
        { name: 'strength', value: player.skills.strength },
        { name: 'defense', value: player.skills.defense },
        { name: 'dexterity', value: player.skills.dexterity },
        { name: 'agility', value: player.skills.agility },
        { name: 'hacking', value: player.skills.hacking },
        { name: 'charisma', value: player.skills.charisma }
    ];
    stats.sort((a, b) => a.value - b.value);
    return stats[0];
}

/**
 * Trains the given stat via university course (hacking/charisma) or gym workout
 * (physical stats). Both Rothman University and Powerhouse Gym are Sector-12
 * locations (NetscriptDefinitions.d.ts LocationName enum) — travel there first
 * if the player is elsewhere, otherwise the course/workout call silently no-ops.
 */
async function trainStat(ns: NS, stat: string): Promise<void> {
    if (ns.getPlayer().city !== SECTOR_12) {
        await executeCommand(ns, `ns.singularity.travelToCity("${SECTOR_12}")`);
    }

    if (ns.getPlayer().hp.current < ns.getPlayer().hp.max) {
        await executeCommand(ns, 'ns.singularity.hospitalize()');
    }

    await executeCommand(ns, 'ns.singularity.stopAction()');

    let actionTime = 0;

    if (stat === 'hacking' || stat === 'charisma') {
        const course = stat === 'hacking' ? UniversityClassType.algorithms : UniversityClassType.leadership;
        await executeCommand(ns, `ns.singularity.universityCourse('Rothman University', "${course}", false)`);
        const crimeStats = await executeCommand<CrimeStats>(ns, `ns.singularity.getCrimeStats("${CrimeType.shoplift}")`);
        actionTime = crimeStats?.time ?? 10000;
    } else {
        const gymStatType = GymType[stat as keyof typeof GymType];
        await executeCommand(ns, `ns.singularity.gymWorkout('Powerhouse Gym', "${gymStatType}", false)`);
        const crimeStats = await executeCommand<CrimeStats>(ns, `ns.singularity.getCrimeStats("${CrimeType.mug}")`);
        actionTime = crimeStats?.time ?? 10000;
    }

    ns.print(`Training ${stat} for ${actionTime / 1000} seconds`);
    await ns.sleep(actionTime);
}

async function findCurrentCrimeIndex(ns: NS, crimeLadder: CrimeType[]): Promise<number> {
    for (let i = crimeLadder.length - 1; i >= 0; i--) {
        const crimeChance = await executeCommand<number>(ns, `ns.singularity.getCrimeChance("${crimeLadder[i]}")`);
        if (crimeChance >= COMMIT_THRESHOLD) return i;
    }
    return -1;
}

async function myCommitCrime(ns: NS, crime: CrimeType): Promise<void> {
    if (ns.getPlayer().hp.current < ns.getPlayer().hp.max) {
        await executeCommand(ns, 'ns.singularity.hospitalize()');
    }

    await executeCommand(ns, 'ns.singularity.stopAction()');

    const crimeStats = await executeCommand<CrimeStats>(ns, `ns.singularity.getCrimeStats("${crime}")`);
    const successRate = await executeCommand<number>(ns, `ns.singularity.getCrimeChance("${crime}")`);

    const expectedProfit = (crimeStats.money * successRate) / (crimeStats.time / 1000);
    ns.print(`Committing crime: ${crime} (${formatPercent(successRate)} success rate, $${shortNumber(expectedProfit)}/sec)`);

    await executeCommand(ns, `ns.singularity.commitCrime("${crime}", false)`);
    await ns.sleep(crimeStats.time);
}

async function trainForCrime(ns: NS, targetCrime: CrimeType): Promise<void> {
    const crimeStats = await executeCommand<CrimeStats>(ns, `ns.singularity.getCrimeStats("${targetCrime}")`);
    const player = ns.getPlayer();
    const statImportance = calculateStatImportance(crimeStats, player);
    const statToTrain = statImportance[0].name;
    const crimeChance = await executeCommand<number>(ns, `ns.singularity.getCrimeChance("${targetCrime}")`);
    ns.print(`Training ${statToTrain} for crime: ${targetCrime} (Current success: ${formatPercent(crimeChance)})`);

    await trainStat(ns, statToTrain);
}

function calculateStatImportance(crimeStats: CrimeStats, player: Player): Array<{ name: string, importance: number }> {
    const importance = [
        { name: 'hacking',   importance: crimeStats.hacking_success_weight   / Math.max(1, player.skills.hacking) },
        { name: 'strength',  importance: crimeStats.strength_success_weight   / Math.max(1, player.skills.strength) },
        { name: 'defense',   importance: crimeStats.defense_success_weight    / Math.max(1, player.skills.defense) },
        { name: 'dexterity', importance: crimeStats.dexterity_success_weight  / Math.max(1, player.skills.dexterity) },
        { name: 'agility',   importance: crimeStats.agility_success_weight    / Math.max(1, player.skills.agility) },
        { name: 'charisma',  importance: crimeStats.charisma_success_weight   / Math.max(1, player.skills.charisma) },
    ];
    return importance.filter(s => s.importance > 0).sort((a, b) => b.importance - a.importance);
}

/** Builds this tick's SubsystemStatus publish (docs/design/11 §3.2) — replaces the old print-only displayStatus(). */
async function buildStatus(ns: NS, player: Player, headline: string, enabled: boolean): Promise<SubsystemStatus> {
    const karma = ns.heart.break();
    const crimeLadder = await buildCrimeLadder(ns);

    const metrics: Record<string, number | string> = {
        money: shortNumber(player.money),
        karma: shortNumber(karma),
        hp: `${player.hp.current}/${player.hp.max}`,
        hacking: player.skills.hacking,
        strength: player.skills.strength,
        defense: player.skills.defense,
        dexterity: player.skills.dexterity,
        agility: player.skills.agility,
        charisma: player.skills.charisma,
    };

    for (const crime of crimeLadder) {
        const successRate = await executeCommand<number>(ns, `ns.singularity.getCrimeChance("${crime}")`);
        metrics[`chance_${crime}`] = formatPercent(successRate);
    }

    return {
        id: 'crime',
        available: true,
        enabled,
        running: true,
        headline,
        metrics,
        ts: Date.now(),
    };
}
