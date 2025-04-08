import { NS } from '@ns';

/**
 * Auto-grow a target server
 * @param {NS} ns - NetScript API
 */
export async function main(ns: NS): Promise<void> {
    const target = ns.args[0] as string;

    // Get actual thread count from the running script
    const threads = ns.getRunningScript()?.threads || 1;

    // Disable logs
    ns.disableLog('ALL');
    ns.enableLog('print');

    // Keep growing and weakening until the server is at max money and min security
    while (true) {
        // Get current server status
        const currentMoney = ns.getServerMoneyAvailable(target);
        const maxMoney = ns.getServerMaxMoney(target);
        const currentSecurity = ns.getServerSecurityLevel(target);
        const minSecurity = ns.getServerMinSecurityLevel(target);

        // Calculate how far we are from optimal
        const moneyPercent = currentMoney / maxMoney;
        const securityDiff = currentSecurity - minSecurity;

        // If we're done, exit
        // Use 90% as the money threshold to match the HackingConfig.getAutoGrowConfig() threshold
        if (moneyPercent >= 0.9 && securityDiff <= 3) {
            ns.print(`${target} prepared: Money ${ns.formatNumber(currentMoney)}/${ns.formatNumber(maxMoney)}, Security ${currentSecurity.toFixed(2)}/${minSecurity.toFixed(2)}`);
            break;
        }

        // Prioritize security
        if (securityDiff > 0.1 * threads || securityDiff > 3) {
            ns.print(`Weakening ${target}: Security ${currentSecurity.toFixed(2)}/${minSecurity.toFixed(2)}`);
            await ns.weaken(target);
        }
        // Then money
        else {
            ns.print(`Growing ${target}: Money ${ns.formatNumber(currentMoney)}/${ns.formatNumber(maxMoney)} (${(moneyPercent * 100).toFixed(2)}%)`);
            await ns.grow(target);
        }
    }
}