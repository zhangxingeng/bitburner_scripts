import { NS } from '@ns';
import { padNum } from './utils';

export async function main(ns: NS): Promise<void> {
    const servers = ns.getPurchasedServers();
    const len = servers.length;
    for (let i = 0; i < len; i++) {
        ns.renamePurchasedServer(servers[i], `pserv-${padNum(i, 2)}`);
        ns.print(`Renamed ${servers[i]} to pserv-${padNum(i, 2)}`);
    }
}