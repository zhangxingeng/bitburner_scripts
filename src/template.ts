import { NS } from '@ns';
import { findAllServers } from './lib/utils';
export async function main(ns: NS): Promise<void> {
    ns.disableLog('ALL');
    ns.ui.openTail();
    ns.print('Hello, world!');
}