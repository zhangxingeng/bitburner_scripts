import { NS } from '@ns';
import { executeCommand } from './simple_through_file';
import { isSingleInstance } from '../lib/util_low_ram';
export async function main(ns: NS): Promise<void> {
    ns.disableLog('ALL');
    if (!isSingleInstance(ns)) { return; }
    while (true) {
        await upgradeHomeServer(ns);
        await ns.sleep(20000);
    }
}

async function upgradeHomeServer(ns: NS): Promise<void> {
    const homeServerUpgradeCost = await executeCommand<number>(ns, 'ns.singularity.getUpgradeHomeRamCost()');
    const coreUpgradeCost = await executeCommand<number>(ns, 'ns.singularity.getUpgradeHomeCoresCost()');
    const funcStr = homeServerUpgradeCost > coreUpgradeCost ? 'ns.singularity.upgradeHomeRam()' : 'ns.singularity.upgradeHomeCores()';
    try {
        const func = await executeCommand<boolean>(ns, funcStr);
    } catch (error) { /*pass*/ }
}
