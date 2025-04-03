import { NS } from '@ns';

export async function main(ns: NS): Promise<void> {
    await ns.sleep(ns.args[1] as number);
    const server = ns.args[0] as string;
    const configs = ns.args.length >= 3 ? { stock: ns.args[2] as boolean } : {};
    await ns.hack(server, configs);
} 