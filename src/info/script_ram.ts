import { NS } from '@ns';

export async function main(ns: NS): Promise<void> {
    // Define the scripts to check
    const scripts = {
        hack: 'remote/hack.js',
        weaken: 'remote/weaken.js',
        grow: 'remote/grow.js',
        share: 'remote/share.js',
        solveContracts: 'remote/solve-contracts.js',
    };

    // Format header
    ns.tprint('\n=============================================');
    ns.tprint('              SCRIPT RAM USAGE               ');
    ns.tprint('=============================================');

    // Print individual script RAM usage
    ns.tprint('\nIndividual Script RAM:');
    ns.tprint('---------------------------------------------');

    let totalSlaveRam = 0;
    for (const [name, path] of Object.entries(scripts)) {
        const ramUsage = ns.getScriptRam(path, 'home');
        ns.tprint(`${name.padEnd(15)}: ${ramUsage.toFixed(2)} GB`);

        // Sum up the slave scripts (hack, weaken, grow)
        if (name === 'hack' || name === 'weaken' || name === 'grow') {
            totalSlaveRam += ramUsage;
        }
    }

    // Print useful combinations
    ns.tprint('\nCombinations for SCRIPT_RAM in distributed_hack.ts:');
    ns.tprint('---------------------------------------------');

    // Calculate the average or max of the slave scripts
    const maxSlaveRam = Math.max(
        ns.getScriptRam(scripts.hack, 'home'),
        ns.getScriptRam(scripts.weaken, 'home'),
        ns.getScriptRam(scripts.grow, 'home')
    );

    ns.tprint(`slaveScript      : ${maxSlaveRam.toFixed(2)} GB (max of hack/weaken/grow)`);
    ns.tprint(`shareScript      : ${ns.getScriptRam(scripts.share, 'home').toFixed(2)} GB`);
    ns.tprint(`solveContractsScript: ${ns.getScriptRam(scripts.solveContracts, 'home').toFixed(2)} GB`);

    // Print suggested SCRIPT_RAM object
    ns.tprint('\nSuggested SCRIPT_RAM Configuration:');
    ns.tprint('---------------------------------------------');
    ns.tprint(`const SCRIPT_RAM = {
    slaveScript: ${maxSlaveRam.toFixed(2)},
    shareScript: ${ns.getScriptRam(scripts.share, 'home').toFixed(2)},
    solveContractsScript: ${ns.getScriptRam(scripts.solveContracts, 'home').toFixed(2)},
};`);

    // Print additional info
    ns.tprint('\nAdditional Info:');
    ns.tprint('---------------------------------------------');
    ns.tprint(`Total RAM for all slave scripts: ${totalSlaveRam.toFixed(2)} GB`);
    ns.tprint(`Average RAM per slave script: ${(totalSlaveRam / 3).toFixed(2)} GB`);

    ns.tprint('\n=============================================');
}
