import { NS } from '@ns';
import { executeCommand } from './basic/simple_through_file';
import { CrimeType, CrimeStats } from './lib/ns_types';

export async function main(ns: NS): Promise<void> {
    const properCommandString = `ns.singularity.getCrimeStats("${CrimeType.shoplift}")`;
    const properCrimeStats = await executeCommand<CrimeStats>(ns, properCommandString);
    ns.print(`Result with proper quotes: ${properCrimeStats ? JSON.stringify(properCrimeStats) : 'UNDEFINED'}`);

}