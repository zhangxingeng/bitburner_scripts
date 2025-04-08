import { NS } from '@ns';

const PURCHASE_AUGS = false;
const PRINT_REMAINING_AUGS = true;

export async function main(ns: NS): Promise<void> {
    ns.disableLog('ALL');
    const player = ns.getPlayer();
    const ownedAugs = new Set(ns.singularity.getOwnedAugmentations(true));
    const joinedFactions = player.factions;

    // Track augmentations and their best source faction
    const allAugs = new Map<string, { faction: string; repReq: number; price: number; affordable: boolean }>();

    // First pass: collect all unique augmentations and check if they're affordable
    for (const faction of joinedFactions) {
        const factionRep = ns.singularity.getFactionRep(faction);
        const augNames = ns.singularity.getAugmentationsFromFaction(faction);

        for (const aug of augNames) {
            if (ownedAugs.has(aug)) continue;

            const repReq = ns.singularity.getAugmentationRepReq(aug);
            const price = ns.singularity.getAugmentationPrice(aug);
            const isAffordable = factionRep >= repReq && price <= player.money;

            // If we haven't seen this aug before or this faction offers better terms
            if (!allAugs.has(aug) || (isAffordable && !allAugs.get(aug)!.affordable)) {
                allAugs.set(aug, {
                    faction,
                    repReq,
                    price,
                    affordable: isAffordable
                });
            }
        }
    }

    // Separate and sort augmentations
    const affordableAugs: Array<[string, string]> = [];
    const unaffordableAugs: Array<[string, { faction: string; repReq: number; price: number }]> = [];

    for (const [aug, details] of allAugs.entries()) {
        if (details.affordable) {
            affordableAugs.push([aug, details.faction]);
        } else if (PRINT_REMAINING_AUGS) {
            unaffordableAugs.push([aug, details]);
        }
    }

    // Sort affordable augs by price (highest to lowest)
    affordableAugs.sort((a, b) => ns.singularity.getAugmentationPrice(b[0]) - ns.singularity.getAugmentationPrice(a[0]));

    // Print affordable augmentations
    for (const [aug, faction] of affordableAugs) {
        if (PURCHASE_AUGS) {
            const playerMoney = ns.getServerMoneyAvailable('home');
            const updatedPrice = ns.singularity.getAugmentationPrice(aug);
            if (playerMoney >= updatedPrice) {
                ns.singularity.purchaseAugmentation(faction, aug);
            }
        }
        ns.tprint(`${aug.padEnd(40)} | ${ns.formatNumber(ns.singularity.getAugmentationPrice(aug)).padStart(10)} | ${faction}`);
    }

    if (PRINT_REMAINING_AUGS) {
        // Sort unaffordable augs by price (highest to lowest)
        unaffordableAugs.sort((a, b) => ns.singularity.getAugmentationPrice(b[0]) - ns.singularity.getAugmentationPrice(a[0]));

        // Print unaffordable augmentations with reason
        for (const [aug, details] of unaffordableAugs) {
            const priceUnaffordable = details.price > player.money;
            const repUnaffordable = ns.singularity.getFactionRep(details.faction) < details.repReq;
            ns.tprint(`${aug.padEnd(40)} | ${ns.formatNumber(details.price).padStart(10)} | ${details.faction} | ${priceUnaffordable ? 'PRICE' : ''}${priceUnaffordable && repUnaffordable ? ' & ' : ''}${repUnaffordable ? 'REP' : ''}`);
        }
    }
}

