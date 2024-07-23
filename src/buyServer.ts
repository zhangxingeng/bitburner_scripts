import { NS } from "@ns";
/** 
  * @param {NS} ns
 */

function getServerName(ns: NS) {
    const ownedList = ns.getPurchasedServers();
    let index = 1;
    let serverName = `home${index}`;
    while (ownedList.includes(serverName)) {
        index++;
        serverName = `home${index}`;
    }
    return serverName;
}

function upgradeLowRamServer(ns: NS, ramThreshold: number, budget: number) {
    const ownedList = ns.getPurchasedServers();
    const lowRamList = ownedList.filter(server => ns.getServerMaxRam(server) < ramThreshold);
    let spent = 0;
    for (const server of lowRamList) {
        const cost = ns.getPurchasedServerUpgradeCost(server, ramThreshold);
        if (spent + cost > budget) { break; }
        ns.upgradePurchasedServer(server, ramThreshold);
        spent += cost;
    }
    return spent;
}

async function buyServers(ns: NS, ram: number, budget: number) {
    let spent = 0;
    const serverCost = ns.getPurchasedServerCost(ram);
    const reachMaxCount = () => ns.getPurchasedServers().length >= ns.getPurchasedServerLimit();
    let cnt = 0;
    while (spent + serverCost < budget && !reachMaxCount()) {
        const serverName = getServerName(ns);
        if (ns.purchaseServer(serverName, ram)) {
            spent += serverCost;
            cnt++;
        } else { throw new Error('Failed to purchase server'); }
    }
    return cnt;
}

async function ramPrompt(ns: NS) {
    const _ramStr = await ns.prompt('Enter server ram(default 64): ', { type: 'text' });
    const ramStr = String(_ramStr).trim();
    const ramNum = parseInt(ramStr);
    if (isNaN(ramNum)) {
        return 64;
    }
    return ramNum;
}

function getRamByBudget(ns: NS, budget: number): { ram: number, count: number }[] {
    const rams = [];
    for (let i = 12; i >= 3; i--) {
        rams.push(2 ** i);
    }
    const ramCount: { ram: number, count: number }[] = [];
    rams.forEach(r => {
        ramCount.push({
            ram: r,
            count: Math.floor(budget / ns.getPurchasedServerCost(r))
        });
    });
    const ramOptions = ramCount.filter(r => r.count > 0 && r.count <= 25);
    return ramOptions;
}

async function getRamOption(ns: NS, budget: number): Promise<number> {
    const ramOptions = getRamByBudget(ns, budget);
    const optionStrList = ramOptions.map(r => `${r.count}x${r.ram}GB`);
    const option = await ns.prompt('Which options?', { type: 'select', choices: optionStrList });
    const optionIndex = optionStrList.indexOf(String(option));
    return ramOptions[optionIndex].ram;
}

async function getBudget(ns: NS): Promise<number> {
    const rawInput = await ns.prompt('Enter percent: ', { type: 'text' });
    const input = parseInt(String(rawInput).trim());
    if (isNaN(input)) { return 0; }
    const budget = (input / 100) * ns.getServerMoneyAvailable('home');
    return budget;
}

async function confirmPurchase(ns: NS, serverCost: number, estimatedCount: number): Promise<boolean> {
    const estimateText = `Estimated server cost: ${serverCost} count: ${estimatedCount}\n`;
    const confirm = await ns.prompt(`${estimateText}Confirm purchase?`, { type: 'boolean' });
    if (confirm == false) { ns.tprint("Transaction aborted."); }
    return Boolean(confirm);
}


export async function main(ns: NS) {
    // first ask for money percentage
    const budget = await getBudget(ns);
    // then provide available ram options
    const ram = await getRamOption(ns, budget);
    const cost = ns.getPurchasedServerCost(ram);
    const count = Math.floor(budget / cost);
    // ask confirmation to purchase
    const confirm = await confirmPurchase(ns, cost, count);
    if (!confirm) { return; }
    // buy on confirmation
    const remainBudget = budget - upgradeLowRamServer(ns, ram, budget);
    await buyServers(ns, ram, remainBudget);
}