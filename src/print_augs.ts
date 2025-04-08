import { NS } from '@ns';

const PURCHASE_AUGS = false;
const PRINT_REMAINING_AUGS = false;

export async function main(ns: NS): Promise<void> {
    ns.disableLog('ALL');
    const player = ns.getPlayer();
    const ownedAugs = new Set(ns.singularity.getOwnedAugmentations(true));
    const joinedFactions = player.factions;
    // const allAugs: { name: string; price: number; repReq: number; faction: string }[] = [];
    const affordableAugs: Set<string> = new Set();
    const notAffordableAugs: Set<string> = new Set();
    const augFactionMap: Map<string, string> = new Map();
    for (const faction of joinedFactions) {
        const factionRep = ns.singularity.getFactionRep(faction);
        const augNames = ns.singularity.getAugmentationsFromFaction(faction);
        for (const aug of augNames) {
            if (ownedAugs.has(aug)) continue;
            const repReq = ns.singularity.getAugmentationRepReq(aug);
            const price = ns.singularity.getAugmentationPrice(aug);
            if (factionRep >= repReq && price <= player.money) {
                affordableAugs.add(aug);
                augFactionMap.set(aug, faction);
            } else {
                notAffordableAugs.add(aug);
                augFactionMap.set(aug, faction);
            }
        }
    }
    const affordableAugsDesc = Array.from(affordableAugs).sort((a, b) => ns.singularity.getAugmentationPrice(b) - ns.singularity.getAugmentationPrice(a));
    for (const aug of affordableAugsDesc) {
        if (PURCHASE_AUGS) {
            const playerMoney = ns.getServerMoneyAvailable('home');
            const updatedPrice = ns.singularity.getAugmentationPrice(aug);
            if (playerMoney >= updatedPrice) {
                ns.singularity.purchaseAugmentation(augFactionMap.get(aug)!, aug);
            }
        }
        ns.tprint(`${aug.padEnd(40)} | ${ns.formatNumber(ns.singularity.getAugmentationPrice(aug)).padStart(10)} | ${augFactionMap.get(aug)}`);
    }
    for (const aug of notAffordableAugs) {
        const priceUnaffordable = ns.singularity.getAugmentationPrice(aug) > player.money;
        const repUnaffordable = ns.singularity.getFactionRep(augFactionMap.get(aug)!) < ns.singularity.getAugmentationRepReq(aug);
        ns.tprint(`${aug.padEnd(40)} | ${ns.formatNumber(ns.singularity.getAugmentationPrice(aug)).padStart(10)} | ${augFactionMap.get(aug)} | ${priceUnaffordable ? 'PRICE' : ''}${priceUnaffordable && repUnaffordable ? ' & ' : ''}${repUnaffordable ? 'REP' : ''}`);
    }
}
