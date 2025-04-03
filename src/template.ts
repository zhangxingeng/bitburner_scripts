import { NS } from '@ns';
import { findAllServers } from './utils';
export async function main(ns: NS): Promise<void> {
    ns.disableLog('ALL');
    ns.ui.openTail();
    ns.print('Hello, world!');
    const allServers = [];
    for (const server of findAllServers(ns)) {
        allServers.push(server);
    }
    ns.tprint(`Total of ${allServers.length} servers`);
    ns.tprint(allServers);
}