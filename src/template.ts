import { NS } from '@ns';
export async function main(ns: NS): Promise<void> {
    ns.disableLog('ALL');
    ns.ui.openTail();
    ns.print('Hello, world!');
}