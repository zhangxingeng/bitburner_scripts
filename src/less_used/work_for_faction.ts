import { NS } from '@ns';
import { shortNumber, formatTime } from '../utils';

/** Available work types for faction work */
type FactionWorkType = 'hacking' | 'field' | 'security';

/** Configuration options for the work_for_faction script */
interface WorkForFactionConfig {
    factionName: string;         // Name of the faction to work for
    targetRep?: number;          // Target reputation to work towards
    focus?: boolean;             // Whether to focus on work
    autoWorkType?: boolean;      // Whether to automatically select the most efficient work type
    workType?: FactionWorkType;  // Specific work type to use (if not auto)
}

/**
 * Main script function
 * @param ns - Netscript API
 */
export async function main(ns: NS): Promise<void> {
    // Disable default logging
    ns.disableLog('ALL');

    // Parse command line arguments
    const args = ns.flags([
        ['help', false],
        ['faction', ''],
        ['rep', 0],
        ['focus', false],
        ['auto', true],
        ['type', '']
    ]);

    // If help flag is provided, display usage information
    if (args.help) {
        showHelp(ns);
        return;
    }

    // Check for required arguments
    if (!args.faction) {
        ns.tprint('ERROR: Faction name is required. Use --help for usage information.');
        return;
    }

    // Configure work parameters
    const config: WorkForFactionConfig = {
        factionName: String(args.faction),
        targetRep: typeof args.rep === 'number' && args.rep > 0 ? args.rep : undefined,
        focus: Boolean(args.focus),
        autoWorkType: Boolean(args.auto),
        workType: args.type ? String(args.type) as FactionWorkType : undefined
    };

    // Start working for the faction
    await workForFaction(ns, config);
}

/**
 * Display help information
 * @param ns - Netscript API
 */
function showHelp(ns: NS): void {
    ns.tprint('\n==================== Work For Faction Script Help ====================');
    ns.tprint('This script automates working for a faction to gain reputation.');
    ns.tprint('\nUSAGE:');
    ns.tprint('  run work_for_faction.ts [options]');
    ns.tprint('\nOPTIONS:');
    ns.tprint('  --help                  Show this help information');
    ns.tprint('  --faction FACTION_NAME  Specify the faction to work for (required)');
    ns.tprint('  --rep TARGET_REP        Work until reaching this reputation (optional)');
    ns.tprint('  --focus                 Enable focus mode for better reputation gain');
    ns.tprint('  --auto                  Auto-detect best work type (default: true)');
    ns.tprint('  --type WORK_TYPE        Specify work type: "hacking", "field", or "security"');
    ns.tprint('\nEXAMPLES:');
    ns.tprint('  run work_for_faction.ts --faction "CyberSec"');
    ns.tprint('  run work_for_faction.ts --faction "NiteSec" --rep 50000 --focus');
    ns.tprint('  run work_for_faction.ts --faction "BitRunners" --type hacking');
    ns.tprint('  run work_for_faction.ts --faction "Tian Di Hui" --auto false --type field');
    ns.tprint('=====================================================================\n');
}

/**
 * Main function to handle working for a faction
 * @param ns - Netscript API
 * @param config - Configuration options
 */
async function workForFaction(ns: NS, config: WorkForFactionConfig): Promise<void> {
    const { factionName, targetRep, focus, autoWorkType } = config;
    let { workType } = config;

    // Check if we're a member of the faction
    const playerFactions = ns.getPlayer().factions;
    if (!playerFactions.includes(factionName)) {
        ns.tprint(`ERROR: You are not a member of faction "${factionName}".`);
        return;
    }

    // Set the optimal work type if auto is enabled
    if (autoWorkType || !workType) {
        workType = findBestWorkType(ns, factionName);
        if (!workType) {
            ns.tprint(`ERROR: Unable to determine best work type for faction "${factionName}".`);
            return;
        }
        ns.print(`Selected work type: ${workType} (auto-detected)`);
    } else {
        ns.print(`Selected work type: ${workType} (user-specified)`);
    }

    // Get initial reputation
    const initialRep = ns.singularity.getFactionRep(factionName);
    const targetReputation = targetRep || 0;

    // Start working for the faction
    if (!ns.singularity.workForFaction(factionName, workType, focus)) {
        ns.tprint(`ERROR: Failed to start working for faction "${factionName}" with work type "${workType}".`);
        return;
    }

    ns.tprint(`Started working for faction "${factionName}" (${workType}) with ${focus ? 'focus' : 'no focus'}.`);
    if (targetReputation > 0) {
        ns.tprint(`Working until reputation reaches ${shortNumber(targetReputation)}.`);
    }

    // Set up variables to track progress
    let lastRep = initialRep;
    let lastUpdateTime = Date.now();
    let repGainRate = 0;
    let consecutiveZeroGains = 0;

    // Main loop to monitor reputation and update progress
    while (true) {
        await ns.sleep(2000); // Check every 2 seconds

        // Check if we're still working
        if (!ns.singularity.isFocused()) {
            ns.tprint('WARNING: Work interrupted - focus lost. Exiting...');
            return;
        }

        // Update reputation information
        const currentRep = ns.singularity.getFactionRep(factionName);
        const currentTime = Date.now();
        const timeElapsed = (currentTime - lastUpdateTime) / 1000; // in seconds

        // Calculate reputation gain rate (rep per second)
        if (timeElapsed > 0) {
            const repGained = currentRep - lastRep;
            repGainRate = repGained / timeElapsed;

            // If we're not gaining reputation, increment counter
            if (repGainRate <= 0) {
                consecutiveZeroGains++;
                // If we haven't gained rep in a while, we may have been interrupted
                if (consecutiveZeroGains >= 5) {
                    ns.tprint('WARNING: No reputation gain detected for 10 seconds. Exiting...');
                    return;
                }
            } else {
                consecutiveZeroGains = 0;
            }

            lastRep = currentRep;
            lastUpdateTime = currentTime;
        }

        // Display progress information
        ns.clearLog();
        ns.print(`Faction: ${factionName} (${workType})`);
        ns.print(`Current Reputation: ${shortNumber(currentRep)}`);
        ns.print(`Reputation Gain Rate: ${shortNumber(repGainRate)} rep/sec`);

        // Display target information if applicable
        if (targetReputation > 0) {
            const repRemaining = Math.max(0, targetReputation - currentRep);
            ns.print(`Target Reputation: ${shortNumber(targetReputation)}`);
            ns.print(`Reputation Remaining: ${shortNumber(repRemaining)}`);

            // Calculate ETA if gaining reputation
            if (repGainRate > 0) {
                const eta = repRemaining / repGainRate;
                ns.print(`ETA: ${formatTime(eta)}`);
            }

            // Check if we've reached the target
            if (currentRep >= targetReputation) {
                ns.tprint(`SUCCESS: Reached target reputation of ${shortNumber(targetReputation)} with faction "${factionName}".`);
                return;
            }
        }
    }
}

/**
 * Find the best work type for a faction based on reputation gain rates
 * @param ns - Netscript API
 * @param factionName - Name of the faction
 * @returns The best work type or undefined if unable to determine
 */
function findBestWorkType(ns: NS, factionName: string): FactionWorkType | undefined {
    const workTypes: FactionWorkType[] = ['hacking', 'field', 'security'];

    // Get player's skills
    const player = ns.getPlayer();
    const { hacking, strength, defense, dexterity, charisma } = player.skills;

    // Combat-focused factions generally benefit more from field work
    const combatFactions = ['Slum Snakes', 'Tetrads', 'The Syndicate', 'The Dark Army', 'Speakers for the Dead'];
    const hackingFactions = ['CyberSec', 'NiteSec', 'BitRunners', 'The Black Hand', 'Netburners'];

    // Simple heuristic to determine best work type
    if (combatFactions.includes(factionName)) {
        // For combat factions, choose based on combat stats vs hacking
        const combatAvg = (strength + defense + dexterity) / 3;
        if (combatAvg > hacking * 0.8) {
            return charisma > combatAvg * 0.8 ? 'security' : 'field';
        }
    }
    else if (hackingFactions.includes(factionName)) {
        // Hacking factions benefit most from hacking work
        return 'hacking';
    }

    // For other factions, choose based on highest stat
    const statValues = [
        { type: 'hacking', value: hacking },
        { type: 'field', value: (strength + defense + dexterity) / 3 },
        { type: 'security', value: charisma }
    ];

    // Sort by value in descending order
    statValues.sort((a, b) => b.value - a.value);

    // Return the work type with the highest stat value
    return statValues[0].type as FactionWorkType;
}
