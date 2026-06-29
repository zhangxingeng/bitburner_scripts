import { NS, Player } from '@ns';
import { CrimeType, GymType, UniversityClassType, CrimeStats } from '../lib/types';
import { shortNumber, formatPercent } from '../lib/format';
import { executeCommand } from '../lib/ns_dodge';


/** Training multiplier for actions (how many times to train before checking stats) */
const TRAINING_MULTIPLIER = 3;
/** Minimum stats to aim for during pure training */
const MIN_STAT_THRESHOLD = 100;
/** Success rate threshold to start training for next crime */
const TRAINING_THRESHOLD = 0.8;
/** Success rate threshold to start committing next crime */
const COMMIT_THRESHOLD = 0.95;

/** Available crimes to consider */
const AVAILABLE_CRIMES = [
    CrimeType.mug,
    CrimeType.homicide,
    CrimeType.traffickArms,
    CrimeType.grandTheftAuto,
    CrimeType.kidnap,
    CrimeType.assassination,
    CrimeType.heist
];

/**
 * Main script function
 * @param {NS} ns - Netscript API
 */
export async function main(ns: NS): Promise<void> {
    ns.disableLog('ALL');
    ns.ui.openTail();
    ns.ui.setTailTitle('Auto Crime');

    // Initial pure training phase
    await pureTrainingPhase(ns);

    // Main crime-training loop
    while (true) {
        // Build the dynamic crime ladder based on current success rates
        const crimeLadder = await buildCrimeLadder(ns);
        const player = ns.getPlayer();

        // Find the current crime index (highest crime with sufficient success rate)
        const currentCrimeIndex = await findCurrentCrimeIndex(ns, crimeLadder);

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
                } else {
                    // Train to improve for next crime
                    await trainForCrime(ns, nextCrime);
                }
            } else {
                // Commit current crime
                await myCommitCrime(ns, currentCrime);
            }
        } else {
            // Train for first crime if nothing else is appropriate
            await trainForCrime(ns, crimeLadder[0]);
        }
    }
}

/**
 * Builds a crime ladder sorted by success chance (ascending)
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

/** Initial pure training phase to reach minimum stats */
async function pureTrainingPhase(ns: NS): Promise<void> {
    ns.print('Starting pure training phase');
    let allStatsAboveThreshold = false;

    while (!allStatsAboveThreshold) {
        const player = ns.getPlayer();
        const lowestStat = findLowestStat(player);
        ns.print(`Training ${lowestStat.name} (${lowestStat.value}) to reach minimum threshold of ${MIN_STAT_THRESHOLD}`);

        for (let i = 0; i < TRAINING_MULTIPLIER; i++) {
            await trainStat(ns, lowestStat.name);
        }

        allStatsAboveThreshold = checkAllStatsAboveThreshold(ns.getPlayer());
    }

    ns.print('Pure training phase complete - all stats above threshold');
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

async function trainStat(ns: NS, stat: string): Promise<void> {
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

    displayStatus(ns, ns.getPlayer());
}

async function trainForCrime(ns: NS, targetCrime: CrimeType): Promise<void> {
    const crimeStats = await executeCommand<CrimeStats>(ns, `ns.singularity.getCrimeStats("${targetCrime}")`);
    const player = ns.getPlayer();
    const statImportance = calculateStatImportance(crimeStats, player);
    const statToTrain = statImportance[0].name;
    const crimeChance = await executeCommand<number>(ns, `ns.singularity.getCrimeChance("${targetCrime}")`);
    ns.print(`Training ${statToTrain} for crime: ${targetCrime} (Current success: ${formatPercent(crimeChance)})`);

    for (let i = 0; i < TRAINING_MULTIPLIER; i++) {
        await trainStat(ns, statToTrain);
    }
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

async function displayStatus(ns: NS, player: Player): Promise<void> {
    const stats = player.skills;
    const karma = ns.heart.break();
    const crimeLadder = await buildCrimeLadder(ns);

    ns.print('--------------------------------------');
    ns.print(`Money: ${shortNumber(player.money)}`);
    ns.print(`Karma: ${shortNumber(karma)}`);
    ns.print(`HP: ${player.hp.current}/${player.hp.max}`);
    ns.print('--------------------------------------');
    ns.print(`Hacking: ${stats.hacking}`);
    ns.print(`Strength: ${stats.strength}`);
    ns.print(`Defense: ${stats.defense}`);
    ns.print(`Dexterity: ${stats.dexterity}`);
    ns.print(`Agility: ${stats.agility}`);
    ns.print(`Charisma: ${stats.charisma}`);
    ns.print(`Intelligence: ${stats.intelligence || 0}`);
    ns.print('--------------------------------------');
    ns.print('CRIME LADDER (by success rate):');

    for (const crime of crimeLadder) {
        const successRate = await executeCommand<number>(ns, `ns.singularity.getCrimeChance("${crime}")`);
        const crimeStats = await executeCommand<CrimeStats>(ns, `ns.singularity.getCrimeStats("${crime}")`);
        const expectedProfit = (crimeStats.money * successRate) / (crimeStats.time / 1000);
        const indicator = successRate >= COMMIT_THRESHOLD ? '[OK]' : successRate >= TRAINING_THRESHOLD ? '[TR]' : '[  ]';
        ns.print(`${indicator} ${crime}: ${formatPercent(successRate)} - $${shortNumber(expectedProfit)}/sec`);
    }
}
