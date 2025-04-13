/** @param {NS} ns */
export async function main(ns) {
    // Parse budget from arguments or use default budget (20% of current money)
    const budget = ns.args[0] || (ns.getServerMoneyAvailable('home') * 0.2);
    
    // Get current purchased servers
    const currentServers = ns.getPurchasedServers();
    const serverLimit = ns.getPurchasedServerLimit();
    
    // If we've reached the server limit, try to upgrade existing servers
    if (currentServers.length >= serverLimit) {
        await upgradeServers(ns, budget);
        return;
    }
    
    // Calculate max RAM we can afford
    const maxRam = getMaxAffordableRam(ns, budget);
    if (maxRam < 8) {
        ns.print(`Not enough money to buy even an 8GB server. Need $${ns.formatNumber(ns.getPurchasedServerCost(8))}`);
        return;
    }
    
    // Generate unique server name
    const serverName = generateServerName(ns);
    
    // Purchase the server
    const cost = ns.getPurchasedServerCost(maxRam);
    const newServer = ns.purchaseServer(serverName, maxRam);
    
    if (newServer) {
        ns.print(`SUCCESS: Purchased server ${newServer} with ${maxRam}GB RAM for $${ns.formatNumber(cost)}`);
        
        // Copy essential scripts to the new server
        const scripts = [
            '/remote/hack.js',
            '/remote/grow.js', 
            '/remote/weaken.js',
            '/remote/share.js',
            '/remote/auto_grow.js'
        ];
        
        // Copy each script if it exists
        for (const script of scripts) {
            if (ns.fileExists(script, 'home')) {
                await ns.scp(script, newServer);
            }
        }
    } else {
        ns.print(`ERROR: Failed to purchase server with ${maxRam}GB RAM for $${ns.formatNumber(cost)}`);
    }
}

/**
 * Finds the maximum RAM we can afford with the given budget
 * @param {NS} ns - NetScript API
 * @param {number} budget - Available money to spend
 * @returns {number} Maximum RAM in GB
 */
function getMaxAffordableRam(ns, budget) {
    // RAM must be a power of 2
    let maxRam = 8; // Start with 8GB minimum
    
    while (ns.getPurchasedServerCost(maxRam * 2) <= budget) {
        maxRam *= 2;
    }
    
    return maxRam;
}

/**
 * Generate a unique name for the server
 * @param {NS} ns - NetScript API
 * @returns {string} - Unique server name
 */
function generateServerName(ns) {
    const existingServers = ns.getPurchasedServers();
    let counter = 0;
    let name;
    
    do {
        counter++;
        name = `daemon-${counter}`;
    } while (existingServers.includes(name));
    
    return name;
}

/**
 * Try to upgrade existing servers with the given budget
 * @param {NS} ns - NetScript API
 * @param {number} budget - Available money to spend
 */
async function upgradeServers(ns, budget) {
    // Get all current servers, sorted by RAM (ascending)
    const servers = ns.getPurchasedServers()
        .map(name => ({
            name,
            ram: ns.getServerMaxRam(name)
        }))
        .sort((a, b) => a.ram - b.ram);
    
    // Try to upgrade the smallest server first
    for (const server of servers) {
        // Calculate next RAM level (doubling)
        const nextRam = server.ram * 2;
        
        // Check if we can afford this upgrade
        const upgradeCost = ns.getPurchasedServerUpgradeCost(server.name, nextRam);
        
        if (upgradeCost <= budget && upgradeCost !== Infinity) {
            // Upgrade the server
            const success = ns.upgradePurchasedServer(server.name, nextRam);
            
            if (success) {
                ns.print(`SUCCESS: Upgraded server ${server.name} from ${server.ram}GB to ${nextRam}GB RAM for $${ns.formatNumber(upgradeCost)}`);
                return;
            }
        }
    }
    
    // If we get here, we couldn't afford to upgrade any server
    ns.print(`Couldn't upgrade any servers with budget of $${ns.formatNumber(budget)}`);
} 