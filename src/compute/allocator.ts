/**
 * Thread allocator for distributing batches across servers.
 * Moved from engine/allocator.ts.
 *
 * Supports both splittable (weaken) and non-splittable (hack/grow) allocations.
 * Uses utilization-aware sorting to balance load across the botnet.
 */
export class Allocator {
    private availableAllocs: number[];
    private availableAscRank: number[];
    private serverUtilization: number[];  // Tracks utilization percentage of each server
    private readonly totalCapacity: number[];  // Initial capacity per server (stable denominator)

    /**
     * @param availableAllocs Number of available thread slots per server (index-aligned with serverList).
     */
    constructor(availableAllocs: number[]) {
        this.availableAllocs = availableAllocs.slice();
        this.totalCapacity = availableAllocs.slice();
        this.availableAscRank = availableAllocs.map((_, ind) => ind);
        this.serverUtilization = availableAllocs.map(() => 0);
        this._rerank();
    }

    /** Sort servers by available threads, preferring less-utilized servers. */
    private _rerank(): void {
        this.availableAscRank = this.availableAllocs.map((_, ind) => ind)
            .sort((indA, indB) => {
                const utilizationDiff = this.serverUtilization[indA] - this.serverUtilization[indB];
                if (Math.abs(utilizationDiff) > 0.2) { // 20% threshold
                    return utilizationDiff;
                }
                return this.availableAllocs[indA] - this.availableAllocs[indB];
            });
    }

    /**
     * Allocate threads across servers.
     * @param count Number of threads to allocate.
     * @param splitable Whether the allocation can be split across servers.
     * @returns success flag and per-server allocation array.
     */
    alloc(count: number, splitable: boolean = true): { success: boolean; allocation: number[] } {
        if (count <= 0) {
            return { success: true, allocation: this.availableAllocs.map(() => 0) };
        }

        const availableAllocTmp = this.availableAllocs.slice();
        const allocation = this.availableAllocs.map(() => 0);
        const origCount = count;

        if (splitable) {
            // Balanced proportional allocation, then greedy fill-in
            const descendingRank = [...this.availableAscRank].reverse();

            for (const serverIndex of descendingRank) {
                const availThreads = this.availableAllocs[serverIndex];
                if (availThreads <= 0) continue;

                const allocRatio = Math.min(1, count / origCount);
                const allocForServer = Math.floor(Math.max(1, availThreads * allocRatio));
                const threadsToUse = Math.min(count, Math.min(allocForServer, availThreads));

                if (threadsToUse > 0) {
                    availableAllocTmp[serverIndex] -= threadsToUse;
                    allocation[serverIndex] += threadsToUse;
                    count -= threadsToUse;
                    if (count === 0) break;
                }
            }

            if (count > 0) {
                for (const serverIndex of this.availableAscRank) {
                    const curAlloc = Math.min(availableAllocTmp[serverIndex], count);
                    if (curAlloc <= 0) continue;
                    availableAllocTmp[serverIndex] -= curAlloc;
                    allocation[serverIndex] += curAlloc;
                    count -= curAlloc;
                    if (count === 0) break;
                }
            }
        } else {
            // Non-splittable: find a single server with enough capacity
            const descendingRank = [...this.availableAscRank].reverse();

            for (const serverIndex of descendingRank) {
                if (this.availableAllocs[serverIndex] >= count) {
                    availableAllocTmp[serverIndex] -= count;
                    allocation[serverIndex] += count;
                    count = 0;
                    break;
                }
            }

            // Fallback: use the largest server if it has at least 80% of needed threads
            if (count > 0) {
                let maxThreads = 0;
                let maxThreadsIndex = -1;
                for (const serverIndex of descendingRank) {
                    if (this.availableAllocs[serverIndex] > maxThreads) {
                        maxThreads = this.availableAllocs[serverIndex];
                        maxThreadsIndex = serverIndex;
                    }
                }
                if (maxThreadsIndex >= 0 && maxThreads >= count * 0.8) {
                    availableAllocTmp[maxThreadsIndex] -= maxThreads;
                    allocation[maxThreadsIndex] += maxThreads;
                    count -= maxThreads;
                }
            }
        }

        if (count === 0) {
            this.availableAllocs = availableAllocTmp;
            for (let i = 0; i < allocation.length; i++) {
                if (allocation[i] > 0) {
                    const cap = this.totalCapacity[i];
                    this.serverUtilization[i] = cap > 0 ? 1 - (this.availableAllocs[i] / cap) : 0;
                }
            }
            this._rerank();
            return { success: true, allocation };
        } else {
            return { success: false, allocation: this.availableAllocs.map(() => 0) };
        }
    }

    /** Free previously allocated threads and re-rank. */
    free(allocation: number[]): void {
        for (let i = 0; i < allocation.length; ++i) {
            if (allocation[i] > 0) {
                this.availableAllocs[i] += allocation[i];
                const cap = this.totalCapacity[i];
                this.serverUtilization[i] = cap > 0 ? 1 - (this.availableAllocs[i] / cap) : 0;
            }
        }
        this._rerank();
    }

    /** Total thread slots available across all servers. */
    getTotalAvailableThreads(): number {
        return this.availableAllocs.reduce((sum, threads) => sum + threads, 0);
    }

    /** Number of servers that have at least one available thread slot. */
    getAvailableServerCount(): number {
        return this.availableAllocs.filter(threads => threads > 0).length;
    }
}
