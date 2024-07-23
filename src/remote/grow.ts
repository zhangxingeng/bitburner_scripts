import { NS } from "@ns";
/** @param {NS} ns **/
export async function main(ns: NS): Promise<void> {
    // Parse and handle arguments with type checking and default values
    const threads = ns.args[0] as number;
    const time = ns.args[1] as number;
    const target = ns.args[2] as string;
    await ns.sleep(time);
    await ns.grow(target, { threads });
}