import { NS, Player } from '@ns';
import { CrimeType, GymType, UniversityClassType, CrimeStats } from './lib/ns_types';
import { shortNumber, formatPercent } from './utils';


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
        const crimeLadder = buildCrimeLadder(ns);
        const player = ns.getPlayer();

        // Find the current crime index (highest crime with sufficient success rate)
        const currentCrimeIndex = findCurrentCrimeIndex(ns, crimeLadder);

        // Check if we should commit current crime or train for next
        if (currentCrimeIndex >= 0) {
            const currentCrime = crimeLadder[currentCrimeIndex];
            const currentSuccessRate = ns.singularity.getCrimeChance(currentCrime);

            // If we can move to next crime and it has decent chance, train for it
            if (currentCrimeIndex < crimeLadder.length - 1 && currentSuccessRate >= TRAINING_THRESHOLD) {
                const nextCrime = crimeLadder[currentCrimeIndex + 1];
                const nextCrimeRate = ns.singularity.getCrimeChance(nextCrime);

                if (nextCrimeRate >= COMMIT_THRESHOLD) {
                    // Good enough success rate, commit next crime
                    await commitCrime(ns, nextCrime);
                } else {
                    // Train to improve for next crime
                    await trainForCrime(ns, nextCrime);
                }
            } else {
                // Commit current crime
                await commitCrime(ns, currentCrime);
            }
        } else {
            // Train for first crime if nothing else is appropriate
            await trainForCrime(ns, crimeLadder[0]);
        }

        // Brief pause between actions
        await ns.sleep(100);
    }
}

/**
 * Builds a crime ladder sorted by success chance (ascending)
 * This creates a dynamic ladder from easiest to hardest crimes
 * @param {NS} ns - Netscript API
 * @returns {CrimeType[]} - Sorted crime ladder
 */
function buildCrimeLadder(ns: NS): CrimeType[] {
    const crimeChances: Array<{ crime: CrimeType, chance: number, profit: number }> = [];

    // Calculate success chance and expected profit for each crime
    for (const crime of AVAILABLE_CRIMES) {
        const chance = ns.singularity.getCrimeChance(crime);
        const stats = ns.singularity.getCrimeStats(crime);
        // Expected profit per second = (money * chance) / (time / 1000)
        const profit = (stats.money * chance) / (stats.time / 1000);
        crimeChances.push({ crime, chance, profit });
    }

    // First sort by success chance (ascending - easiest to hardest)
    crimeChances.sort((a, b) => b.chance - a.chance);

    // Get the crime types in order
    return crimeChances.map(c => c.crime);
}

/**
 * Initial pure training phase to reach minimum stats
 * @param {NS} ns - Netscript API
 */
async function pureTrainingPhase(ns: NS): Promise<void> {
    ns.print('Starting pure training phase');
    let allStatsAboveThreshold = false;

    while (!allStatsAboveThreshold) {
        const player = ns.getPlayer();
        const lowestStat = findLowestStat(player);

        ns.print(`Training ${lowestStat.name} (${lowestStat.value}) to reach minimum threshold of ${MIN_STAT_THRESHOLD}`);

        // Train the lowest stat for multiple cycles
        for (let i = 0; i < TRAINING_MULTIPLIER; i++) {
            await trainStat(ns, lowestStat.name);
        }

        // Check if all stats are above threshold
        allStatsAboveThreshold = checkAllStatsAboveThreshold(ns.getPlayer());
    }

    ns.print('Pure training phase complete - all stats above threshold');
}

/**
 * Checks if all stats are above the minimum threshold
 * @param {Player} player - Player object
 * @returns {boolean} - True if all stats are above threshold
 */
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

/**
 * Find the lowest stat that needs training
 * @param {Player} player - Player object
 * @returns {Object} - Object containing name and value of lowest stat
 */
function findLowestStat(player: Player): { name: string, value: number } {
    const stats = [
        { name: 'strength', value: player.skills.strength },
        { name: 'defense', value: player.skills.defense },
        { name: 'dexterity', value: player.skills.dexterity },
        { name: 'agility', value: player.skills.agility },
        { name: 'hacking', value: player.skills.hacking },
        { name: 'charisma', value: player.skills.charisma }
    ];

    // Sort stats by value and return the lowest
    stats.sort((a, b) => a.value - b.value);
    return stats[0];
}

/**
 * Trains a specific stat
 * @param {NS} ns - Netscript API
 * @param {string} stat - Stat name to train
 */
async function trainStat(ns: NS, stat: string): Promise<void> {
    // Ensure player is healthy
    if (ns.getPlayer().hp.current < ns.getPlayer().hp.max) {
        ns.singularity.hospitalize();
    }

    // Stop any current action before starting a new one
    if (ns.singularity.isBusy()) {
        ns.singularity.stopAction();
    }

    // Define a reasonable action time based on the type of stat we're training
    let actionTime = 0;

    if (stat === 'hacking' || stat === 'charisma') {
        // Train hacking at university'
        const course = stat === 'hacking' ? UniversityClassType.algorithms : UniversityClassType.leadership;
        ns.singularity.universityCourse('Rothman University', course, false);
        // Use a basic crime for reference duration (like shoplift or mug)
        const crimeForDuration = CrimeType.shoplift;
        const crimeStats = ns.singularity.getCrimeStats(crimeForDuration);
        actionTime = crimeStats.time;
    } else {
        // Train physical stat at gym
        const gymStat = stat as keyof typeof GymType;
        const gymStatType = GymType[gymStat];
        ns.singularity.gymWorkout('Powerhouse Gym', gymStatType, false);
        // Use a basic crime for reference duration
        const crimeForDuration = CrimeType.mug;
        const crimeStats = ns.singularity.getCrimeStats(crimeForDuration);
        actionTime = crimeStats.time;
    }

    // Wait for action to complete, then stop it
    ns.print(`Training ${stat} for ${actionTime / 1000} seconds`);
    await ns.sleep(actionTime);
    ns.singularity.stopAction();
}

/**
 * Finds the current position on the crime ladder (highest crime with COMMIT_THRESHOLD)
 * @param {NS} ns - Netscript API
 * @param {CrimeType[]} crimeLadder - Current crime ladder
 * @returns {number} - Index of current crime in crimeLadder, or -1 if none meet threshold
 */
function findCurrentCrimeIndex(ns: NS, crimeLadder: CrimeType[]): number {
    // Start from the end (hardest crime) and work backwards
    for (let i = crimeLadder.length - 1; i >= 0; i--) {
        if (ns.singularity.getCrimeChance(crimeLadder[i]) >= COMMIT_THRESHOLD) {
            return i;
        }
    }
    return -1; // No crime meets the minimum success rate
}

/**
 * Commits a crime and waits for it to complete
 * @param {NS} ns - Netscript API
 * @param {CrimeType} crime - Crime to commit
 */
async function commitCrime(ns: NS, crime: CrimeType): Promise<void> {
    // Ensure player is healthy
    if (ns.getPlayer().hp.current < ns.getPlayer().hp.max) {
        ns.singularity.hospitalize();
    }

    // Stop any current action before starting a new one
    if (ns.singularity.isBusy()) {
        ns.singularity.stopAction();
    }

    // Get crime stats for duration
    const crimeStats = ns.singularity.getCrimeStats(crime);
    const successRate = ns.singularity.getCrimeChance(crime);

    // Display expected profit
    const expectedProfit = (crimeStats.money * successRate) / (crimeStats.time / 1000);
    ns.print(`Committing crime: ${crime} (${formatPercent(successRate)} success rate, $${shortNumber(expectedProfit)}/sec)`);

    // Commit the crime
    ns.singularity.commitCrime(crime, false);

    // Wait for crime to complete
    await ns.sleep(crimeStats.time);

    // Stop action
    ns.singularity.stopAction();

    // Display result
    displayStatus(ns, ns.getPlayer());
}

/**
 * Trains stats optimized for a specific crime
 * @param {NS} ns - Netscript API
 * @param {CrimeType} targetCrime - Crime to train for
 */
async function trainForCrime(ns: NS, targetCrime: CrimeType): Promise<void> {
    // Get stats for target crime
    const crimeStats = ns.singularity.getCrimeStats(targetCrime);

    // Get current player stats
    const player = ns.getPlayer();

    // Calculate weighted importance of each stat for the crime
    const statImportance = calculateStatImportance(crimeStats, player);

    // Find the most important stat to train
    const statToTrain = statImportance[0].name;

    ns.print(`Training ${statToTrain} for crime: ${targetCrime} (Current success: ${formatPercent(ns.singularity.getCrimeChance(targetCrime))})`);

    // Train the selected stat for multiple cycles
    for (let i = 0; i < TRAINING_MULTIPLIER; i++) {
        await trainStat(ns, statToTrain);
    }
}

/**
 * Calculates the importance of each stat for a crime based on
 * both the crime requirements and the player's current stats
 * @param {CrimeStats} crimeStats - Stats for the target crime
 * @param {Player} player - Player object
 * @returns {Array} - Array of stats sorted by importance
 */
function calculateStatImportance(crimeStats: CrimeStats, player: Player): Array<{ name: string, importance: number }> {
    // Calculate importance for each stat
    const importance = [
        {
            name: 'hacking',
            importance: crimeStats.hacking_success_weight / Math.max(1, player.skills.hacking)
        },
        {
            name: 'strength',
            importance: crimeStats.strength_success_weight / Math.max(1, player.skills.strength)
        },
        {
            name: 'defense',
            importance: crimeStats.defense_success_weight / Math.max(1, player.skills.defense)
        },
        {
            name: 'dexterity',
            importance: crimeStats.dexterity_success_weight / Math.max(1, player.skills.dexterity)
        },
        {
            name: 'agility',
            importance: crimeStats.agility_success_weight / Math.max(1, player.skills.agility)
        },
        {
            name: 'charisma',
            importance: crimeStats.charisma_success_weight / Math.max(1, player.skills.charisma)
        }
    ];

    // Filter stats with positive weight and sort by importance (highest first)
    return importance
        .filter(stat => stat.importance > 0)
        .sort((a, b) => b.importance - a.importance);
}

/**
 * Displays current status information
 * @param {NS} ns - Netscript API
 * @param {Player} player - Player object
 */
function displayStatus(ns: NS, player: Player): void {
    const stats = player.skills;
    const karma = ns.heart.break();

    // Get current crime ladder
    const crimeLadder = buildCrimeLadder(ns);

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

    // Show success rates for crimes in ladder
    ns.print('CRIME LADDER (by success rate):');
    for (const crime of crimeLadder) {
        const successRate = ns.singularity.getCrimeChance(crime);
        const crimeStats = ns.singularity.getCrimeStats(crime);
        const expectedProfit = (crimeStats.money * successRate) / (crimeStats.time / 1000);

        let indicator = '❌';
        if (successRate >= COMMIT_THRESHOLD) indicator = '✅';
        else if (successRate >= TRAINING_THRESHOLD) indicator = '🔶';

        ns.print(`${indicator} ${crime}: ${formatPercent(successRate)} - $${shortNumber(expectedProfit)}/sec`);
    }
}
