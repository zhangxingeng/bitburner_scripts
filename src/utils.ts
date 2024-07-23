import { NS } from "@ns";
import { ScanUtils } from "./ScanUtils";


/**
 * Find the max or min element in an array based on the selector function.
 */
export function maxMin<T>(arr: T[], selector: (item: T) => number, max: boolean = true, index: boolean = false): T | number | null {
    if (arr.length === 0) { return null; }
    let resultIndex = arr.reduce((resultIdx, currentElem, currentIndex) => {
        const currentVal = selector(currentElem);
        const resultVal = selector(arr[resultIdx]);
        if (max ? currentVal > resultVal : currentVal < resultVal) {
            return currentIndex;
        }
        return resultIdx;
    }, 0);
    return index ? resultIndex : arr[resultIndex];
}

export function maxBy<T>(arr: T[], selector: (item: T) => number = (item: T) => item as any as number): T | null {
    return maxMin(arr, selector, true, false) as T;
}
export function minBy<T>(arr: T[], selector: (item: T) => number = (item: T) => item as any as number): T | null {
    return maxMin(arr, selector, false, false) as T;
}
export function iMaxBy<T>(arr: T[], selector: (item: T) => number = (item: T) => item as any as number): number | null {
    return maxMin(arr, selector, true, true) as number;
}
export function iMinBy<T>(arr: T[], selector: (item: T) => number = (item: T) => item as any as number): number | null {
    return maxMin(arr, selector, false, true) as number;
}


// try to find server matching user input
export function findServer(ns: NS, keyword: string): { [key: string]: string[] }[] {
    // prompt for keyword
    const target = keyword.trim().toLowerCase();
    const allSeverList = ScanUtils.discoverServers(ns);
    const matchServers = allSeverList.filter(s => s.toLowerCase().includes(target));
    const res: { [key: string]: string[] }[] = [];
    ns.tprint(`Found ${matchServers.length} servers matching: ${target}`);
    if (matchServers.length === 0) { return res; }
    for (const matchServer of matchServers) {
        const path = ScanUtils.GetServerPath(ns, matchServer);
        res.push({ [matchServer]: path });
    }
    return res;
}

export function killAll(ns: NS) {
    const allSeverList = ScanUtils.discoverServers(ns);
    for (const server of allSeverList) {
        ns.killall(server);
    }
}