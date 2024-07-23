import { NS } from "@ns";
import { iMinBy } from "./utils";
export async function main(ns: NS): Promise<void> {
    // prompt for percentage
    const _pct = await ns.prompt('Percentage of money(0-100): ', { type: 'text' });
    const _pctNum = parseInt(String(_pct).trim());
    const pct = (!isNaN(_pctNum) && _pctNum >= 0 && _pctNum <= 100) ? _pctNum : 0;
    // get budget
    const budget = Math.floor(ns.getServerMoneyAvailable('home') * (pct / 100));
    if (budget <= 0) { ns.tprint("No budget"); return; }
    const newNodeBudget = Math.floor(budget * 0.5); // spend what percent buy new nodes
    const singleUpgradeBudget = Math.floor(budget * 0.2); // budget for one upgrade
    let remainMoney = budget;
    // buy new nodes
    remainMoney -= buyNewNodes(ns, newNodeBudget);
    // upgrade nodes
    while (remainMoney > 0) { // keep upgrading until no money left
        const waitList = getUpgradeWaitList(ns, singleUpgradeBudget);
        if (waitList.length === 0) { break; }
        const _oldMoney = remainMoney;
        remainMoney -= upgradeByList(ns, remainMoney, waitList);
        if (_oldMoney === remainMoney) { break; } // no upgrade done
    }
}

// buy new nodes within budget
// return spent money
function buyNewNodes(ns: NS, budget: number): number {
    const _budget = budget;
    let spent = 0;
    while (spent < _budget) {
        const cost = ns.hacknet.getPurchaseNodeCost();
        if (spent + cost > _budget) { break; }
        if (ns.hacknet.purchaseNode()) { spent += cost; }
    }
    return spent;
}

function getWeightedCost(ns: NS, i: number, type: string): { cost: number, weightedCost: number } {
    let cost = -1;
    let weightedCost = -1;
    if (type === "level") {
        cost = ns.hacknet.getLevelUpgradeCost(i, 1);
        weightedCost = Math.floor(cost * 30);
    } else if (type === "ram") {
        cost = ns.hacknet.getRamUpgradeCost(i, 1);
        weightedCost = cost;
    } else if (type === "core") {
        cost = ns.hacknet.getCoreUpgradeCost(i, 1);
        weightedCost = Math.floor(cost * 2.5);
    }
    return { cost, weightedCost };
}

// find the best upgrade option for a node
function nodeBestUpgrade(ns: NS, i: number): { i: number, type: string, cost: number, weightedCost: number } {
    const upgradeType = ["level", "ram", "core"];
    const upgradeCost = upgradeType.map(t => getWeightedCost(ns, i, t));
    const minIndex = iMinBy(upgradeCost, x => x.weightedCost); // index of cheapest
    if (minIndex === null) { throw new Error("Impossible"); }
    const { cost, weightedCost } = upgradeCost[minIndex];
    return { i, type: upgradeType[minIndex], cost, weightedCost };
}

function getUpgradeWaitList(ns: NS, singleUpgradeBudget: number): { i: number, type: string, cost: number }[] {
    const nodeCnt = ns.hacknet.numNodes();
    const waitList = [];
    for (let i = 0; i < nodeCnt; i++) {
        waitList.push(nodeBestUpgrade(ns, i));
    }
    const _lim = waitList.filter(x => x.cost <= singleUpgradeBudget);
    const _sorted = _lim.sort((a, b) => a.weightedCost - b.weightedCost); // ascending
    const res = _sorted.map(x => ({ i: x.i, type: x.type, cost: x.cost }));
    return res;
}

function upgradeByList(ns: NS, budget: number, upgradeList: { i: number, type: string, cost: number }[]): number {
    let spent = 0;
    for (const { i, type, cost } of upgradeList) {
        if (spent + cost > budget) { break; }
        if (upgradeNode(ns, i, type)) { spent += cost; }
    }
    return spent;
}

function upgradeNode(ns: NS, nodeIndex: number, upgradeType: string): boolean {
    const hn = ns.hacknet;
    type _UFType = (index: number, n: number) => boolean;
    const funcMap: Record<string, _UFType> = {
        level: hn.upgradeLevel.bind(hn),
        ram: hn.upgradeRam.bind(hn),
        core: hn.upgradeCore.bind(hn),
    };
    return funcMap[upgradeType](nodeIndex, 1);
}
