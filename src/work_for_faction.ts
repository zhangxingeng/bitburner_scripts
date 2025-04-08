import { NS, FactionWorkType, CompanyName } from '@ns';
import { formatTime, shortNumber } from './lib/utils';

// Constants
const STATUS_UPDATE_INTERVAL = 5000; // 5 seconds for status updates
const MEASUREMENT_DURATION = 1000; // 1 second to measure rep gain
const MEASUREMENT_FREQUENCY = 20; // Re-measure rep gain every 20 ticks
const TIME_MARGIN_PERCENT = 0.1; // Add 10% margin to estimated completion time

/** Types */
interface FactionWorkTarget {
    factionName: string;
    augName: string;
    repNeeded: number;
    repCurrent: number;
    repPerSecond: number;
    timeRemaining: number;
}

interface CurrentWork {
    type: 'FACTION' | 'COMPANY' | '';
    factionName?: string;
    factionWorkType?: FactionWorkType;
    companyName?: string;
}

/** 
 * Main function - continuous work approach with periodic re-measurement
 */
export async function main(ns: NS): Promise<void> {
    ns.disableLog('ALL');
    ns.ui.openTail();

    let tickCounter = 0;

    // Main program loop
    while (true) {
        // Periodically re-measure reputation gain rates
        const shouldMeasure = tickCounter % MEASUREMENT_FREQUENCY === 0;

        // Get the best faction to work for (re-measuring if needed)
        const target = await findOptimalFactionTarget(ns, shouldMeasure);

        if (!target) {
            ns.print('No more faction work needed! All augmentations acquired.');
            break;
        }

        // Log the current target we're working for
        ns.print(`\nWorking for faction: ${target.factionName} to unlock ${target.augName}`);
        ns.print(`Current reputation: ${shortNumber(target.repCurrent)}/${shortNumber(target.repNeeded)}`);
        ns.print(`Estimated time to completion: ${formatTime(target.timeRemaining * 1000)}`);

        // Start working for the selected faction
        await workContinuouslyForFaction(ns, target);

        // Increment the tick counter
        tickCounter++;
    }
}

/**
 * Work continuously for a faction until reaching the target reputation
 */
async function workContinuouslyForFaction(ns: NS, target: FactionWorkTarget): Promise<void> {
    // Begin working for the faction
    const shouldFocus = ns.singularity.isFocused();
    const workType = findBestWorkType(ns, target.factionName);

    if (!workForFaction(ns, target.factionName, workType, shouldFocus)) {
        ns.print(`Failed to start working for faction ${target.factionName}. Will retry.`);
        await ns.sleep(5000); // Wait 5 seconds before retrying
        return;
    }

    // Calculate how long to work for this faction (with margin)
    const workDuration = target.timeRemaining * 1000 * (1 + TIME_MARGIN_PERCENT);
    ns.print(`Working continuously for ${formatTime(workDuration)} (includes ${TIME_MARGIN_PERCENT * 100}% margin)`);

    // Track start time to calculate progress
    const startTime = Date.now();
    const startRep = target.repCurrent;

    // Work continuously, periodically checking progress
    const continueWorking = true;

    while (continueWorking) {
        // Check if work was interrupted
        if (!isWorkingForTargetFaction(ns, target.factionName)) {
            ns.print(`Work for ${target.factionName} was interrupted. Restarting...`);
            if (!workForFaction(ns, target.factionName, workType, shouldFocus)) {
                return; // If we can't restart, exit and try a different faction
            }
        }

        // Update current reputation and calculate time elapsed
        const currentRep = ns.singularity.getFactionRep(target.factionName);
        const timeElapsed = Date.now() - startTime;

        // Check if we've reached our target rep
        if (currentRep >= target.repNeeded) {
            ns.print(`✓ Success! Reached target reputation of ${shortNumber(target.repNeeded)} with ${target.factionName} for ${target.augName}`);
            return;
        }

        // Check if we've worked for the estimated duration (with margin)
        if (timeElapsed >= workDuration) {
            const actualGainRate = (currentRep - startRep) / (timeElapsed / 1000);
            ns.print(`⚠ Time allocation for ${target.factionName} complete, but target not reached.`);
            ns.print(`Expected rate: ${shortNumber(target.repPerSecond)}/sec, Actual: ${shortNumber(actualGainRate)}/sec`);
            return;
        }

        // Update progress display
        const percentComplete = ((currentRep / target.repNeeded) * 100).toFixed(1);
        const remainingRep = target.repNeeded - currentRep;
        const remainingTimeEstimate = remainingRep / target.repPerSecond;

        ns.print(`${target.factionName}: ${shortNumber(currentRep)}/${shortNumber(target.repNeeded)} rep ` +
            `(${percentComplete}%) - ETA: ${formatTime(remainingTimeEstimate * 1000)} - ` +
            `Time elapsed: ${formatTime(timeElapsed)}`);

        // Sleep for a short interval before checking again
        await ns.sleep(STATUS_UPDATE_INTERVAL);
    }
}

/**
 * Find the best faction to work for based on time to reach next augmentation
 */
async function findOptimalFactionTarget(ns: NS, measureRepRates: boolean = false): Promise<FactionWorkTarget | null> {
    // Get all possible work targets
    const targets = await getAllFactionWorkTargets(ns, measureRepRates);

    if (targets.length === 0) return null;

    // Log the top targets for visibility
    logTopTargets(ns, targets);

    // Return the target with the shortest time to completion
    return targets[0];
}

/**
 * Wrapper for ns.singularity.workForFaction that respects user's focus preference
 */
function workForFaction(ns: NS, faction: string, workType: FactionWorkType, focus: boolean = true): boolean {
    return ns.singularity.workForFaction(faction, workType, focus);
}

/**
 * Wrapper for ns.singularity.workForCompany that respects user's focus preference
 */
function workForCompany(ns: NS, company: string, focus: boolean = true): boolean {
    return ns.singularity.workForCompany(company as CompanyName, focus);
}

/**
 * Checks if currently working for the specified faction
 */
function isWorkingForTargetFaction(ns: NS, factionName: string): boolean {
    const currentWork = ns.singularity.getCurrentWork();
    return currentWork?.type === 'FACTION' && currentWork.factionName === factionName;
}

/**
 * Log the top targets in order of time efficiency
 */
function logTopTargets(ns: NS, targets: FactionWorkTarget[]): void {
    ns.print('\nFaction work priorities (shortest time first):');
    targets.slice(0, 5).forEach((target, i) => {
        ns.print(`${i + 1}. ${target.factionName}: ${shortNumber(target.repNeeded - target.repCurrent)} ` +
            `rep needed for '${target.augName}' (${formatTime(target.timeRemaining * 1000)})`);
    });
    ns.print('');
}

/**
 * Get all possible faction work targets, sorted by time to completion
 */
async function getAllFactionWorkTargets(ns: NS, measureRepRates: boolean): Promise<FactionWorkTarget[]> {
    const playerFactions = ns.getPlayer().factions;
    const ownedAugs = ns.singularity.getOwnedAugmentations(true);
    const targets: FactionWorkTarget[] = [];

    // Static cache of reputation rates to avoid constant re-measurement
    const repRateCache = new Map<string, { rate: number, timestamp: number }>();

    // For each faction the player has joined, find all possible augmentation targets
    for (const faction of playerFactions) {
        // Get available augmentations from this faction
        const availableAugs = ns.singularity.getAugmentationsFromFaction(faction);

        // Filter out already owned augmentations
        const unownedAugs = availableAugs.filter(aug => !ownedAugs.includes(aug));

        if (unownedAugs.length === 0) continue;

        // Get current reputation with faction
        const currentRep = ns.singularity.getFactionRep(faction);

        // Determine if we need to measure rep gain for this faction
        let repPerSecond: number;

        // Check if we should use the cached value or re-measure
        const cachedRate = repRateCache.get(faction);
        if (!measureRepRates && cachedRate) {
            repPerSecond = cachedRate.rate;
            ns.print(`Using cached rep rate for ${faction}: ${shortNumber(repPerSecond)}/sec`);
        } else {
            // Measure and cache the new rate
            repPerSecond = await measureFactionRepGainRate(ns, faction);
            repRateCache.set(faction, {
                rate: repPerSecond,
                timestamp: Date.now()
            });
            ns.print(`Measured rep rate for ${faction}: ${shortNumber(repPerSecond)}/sec`);
        }

        // For each possible augmentation, create a work target
        for (const aug of unownedAugs) {
            const repNeeded = ns.singularity.getAugmentationRepReq(aug);

            // Skip if we already have enough reputation
            if (currentRep >= repNeeded) continue;

            // Calculate time remaining
            const timeRemaining = (repNeeded - currentRep) / repPerSecond;

            if (repPerSecond <= 0) continue; // Skip if rep gain couldn't be measured

            targets.push({
                factionName: faction,
                augName: aug,
                repNeeded,
                repCurrent: currentRep,
                repPerSecond,
                timeRemaining
            });
        }
    }

    // Group targets by faction, keeping only the fastest one per faction
    const factionBestTargets = new Map<string, FactionWorkTarget>();
    for (const target of targets) {
        if (!factionBestTargets.has(target.factionName) ||
            target.timeRemaining < factionBestTargets.get(target.factionName)!.timeRemaining) {
            factionBestTargets.set(target.factionName, target);
        }
    }

    // Sort by time to completion (ascending)
    return Array.from(factionBestTargets.values())
        .sort((a, b) => a.timeRemaining - b.timeRemaining);
}

/**
 * Measure the reputation gain rate for a faction
 */
async function measureFactionRepGainRate(ns: NS, factionName: string): Promise<number> {
    // Save current work state and focus state
    const originalWork = ns.singularity.getCurrentWork() as CurrentWork;
    const wasFocused = ns.singularity.isFocused();

    // Start working for the faction with the optimal work type
    const workType = findBestWorkType(ns, factionName);
    if (!workForFaction(ns, factionName, workType, wasFocused)) {
        return 0; // Couldn't start working
    }

    // Measure reputation gain
    const startRep = ns.singularity.getFactionRep(factionName);
    await ns.sleep(MEASUREMENT_DURATION);
    const endRep = ns.singularity.getFactionRep(factionName);
    const repPerSecond = (endRep - startRep) * (1000 / MEASUREMENT_DURATION);

    // Restore original work if there was any
    restoreOriginalWork(ns, originalWork, wasFocused);

    return repPerSecond;
}

/**
 * Restore the original work state after measuring rep gain
 */
function restoreOriginalWork(ns: NS, work: CurrentWork, wasFocused: boolean): void {
    if (!work || !work.type) {
        ns.singularity.stopAction();
        return;
    }

    if (work.type === 'FACTION' && work.factionName && work.factionWorkType) {
        workForFaction(ns, work.factionName, work.factionWorkType, wasFocused);
    } else if (work.type === 'COMPANY' && work.companyName) {
        workForCompany(ns, work.companyName, wasFocused);
    } else {
        ns.singularity.stopAction();
    }
}

/**
 * Find the best work type for a faction based on player stats
 */
function findBestWorkType(ns: NS, factionName: string): FactionWorkType {
    const player = ns.getPlayer();

    // Define faction categories
    const hackingFactions = [
        'CyberSec', 'NiteSec', 'BitRunners', 'The Black Hand',
        'Netburners', 'Tian Di Hui', 'Daedalus'
    ];

    const combatFactions = [
        'Slum Snakes', 'Tetrads', 'The Syndicate', 'The Dark Army',
        'Speakers for the Dead', 'Volhaven'
    ];

    // Determine work type based on faction category and player stats
    if (hackingFactions.includes(factionName)) {
        return 'hacking' as FactionWorkType;
    }

    if (combatFactions.includes(factionName)) {
        const combatAvg = (player.skills.strength + player.skills.defense +
            player.skills.dexterity + player.skills.agility) / 4;
        return (player.skills.charisma > combatAvg ? 'security' : 'field') as FactionWorkType;
    }

    // For other factions, choose based on highest stat
    const statOptions = [
        { type: 'hacking' as FactionWorkType, value: player.skills.hacking },
        {
            type: 'field' as FactionWorkType,
            value: (player.skills.strength + player.skills.defense +
                player.skills.dexterity + player.skills.agility) / 4
        },
        { type: 'security' as FactionWorkType, value: player.skills.charisma }
    ];

    statOptions.sort((a, b) => b.value - a.value);
    return statOptions[0].type;
}
