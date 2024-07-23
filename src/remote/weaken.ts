import { NS } from "@ns";
/** @param {NS} ns **/
export async function main(ns: NS): Promise<void> {
    // Parse and handle arguments with type checking and default values
    const threads = ns.args[0] as number;
    const target = ns.args[1] as string;
    await ns.weaken(target, { threads });
}
