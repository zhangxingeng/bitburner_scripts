/**
 * Thread allocator for distributing batches across servers
 * Converted from the original hack/bat/allocator.js implementation
 * with optimizations for better RAM utilization
 */
export class Allocator {
    private availableAllocs: number[];
    private availableAscRank: number[];
    private serverUtilization: number[];  // Tracks utilization percentage of each server

    /**
     * Create a new thread allocator
     * @param availableAllocs Number of available threads per server
     */
    constructor(availableAllocs: number[]) {
        this.availableAllocs = availableAllocs.slice();
        this.availableAscRank = availableAllocs.map((_, ind) => ind);
        this.serverUtilization = availableAllocs.map(() => 0);
        this._rerank();
    }

    /**
     * Sort servers by available thread count and utilization
     * @private
     */
    private _rerank(): void {
        // Sort by available threads but with a preference for less utilized servers
        this.availableAscRank = this.availableAllocs.map((_, ind) => ind)
            .sort((indA, indB) => {
                // If one server is much more utilized than the other, prioritize the less utilized one
                const utilizationDiff = this.serverUtilization[indA] - this.serverUtilization[indB];
                if (Math.abs(utilizationDiff) > 0.2) { // 20% threshold
                    return utilizationDiff;
                }
                // Otherwise, sort by available threads
                return this.availableAllocs[indA] - this.availableAllocs[indB];
            });
    }

    /**
     * Allocate threads across servers
     * @param count Number of threads to allocate
     * @param splitable Whether the allocation can be split across servers
     * @returns Allocation result with success status and allocation array
     */
    alloc(count: number, splitable: boolean = true): { success: boolean; allocation: number[] } {
        if (count <= 0) {
            return { success: true, allocation: this.availableAllocs.map(() => 0) };
        }

        const availableAllocTmp = this.availableAllocs.slice();
        const allocation = this.availableAllocs.map(() => 0);
        const origCount = count;

        if (splitable) {
            // If splittable, we can use a more balanced approach
            // First try to allocate to servers with higher RAM to reduce fragmentation
            const descendingRank = [...this.availableAscRank].reverse();

            // Try to allocate a portion to each server proportional to its available RAM
            for (const serverIndex of descendingRank) {
                const availThreads = this.availableAllocs[serverIndex];
                if (availThreads <= 0) continue;

                // Calculate how many threads to allocate to this server
                // Use a proportion of the server's capacity, but with minimum of 1 thread
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

            // If we still have threads to allocate, use the traditional approach
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
            // For non-splittable allocations, find a server with enough capacity
            // Sort by available threads (descending) to find largest server first
            const descendingRank = [...this.availableAscRank].reverse();

            for (const serverIndex of descendingRank) {
                if (this.availableAllocs[serverIndex] >= count) {
                    availableAllocTmp[serverIndex] -= count;
                    allocation[serverIndex] += count;
                    count = 0;
                    break;
                }
            }

            // If no single server is large enough, try to find the largest server
            if (count > 0) {
                // Find the server with the most available threads
                let maxThreads = 0;
                let maxThreadsIndex = -1;

                for (const serverIndex of descendingRank) {
                    if (this.availableAllocs[serverIndex] > maxThreads) {
                        maxThreads = this.availableAllocs[serverIndex];
                        maxThreadsIndex = serverIndex;
                    }
                }

                // If we found a server and it has at least 80% of needed threads, use it
                if (maxThreadsIndex >= 0 && maxThreads >= count * 0.8) {
                    availableAllocTmp[maxThreadsIndex] -= maxThreads;
                    allocation[maxThreadsIndex] += maxThreads;
                    count -= maxThreads;
                }
            }
        }

        // If all threads were allocated, update available allocs
        if (count === 0) {
            this.availableAllocs = availableAllocTmp;

            // Update utilization metrics
            for (let i = 0; i < allocation.length; i++) {
                if (allocation[i] > 0) {
                    // Calculate new utilization as percentage of original capacity used
                    const originalCapacity = this.availableAllocs[i] + allocation[i];
                    this.serverUtilization[i] = 1 - (this.availableAllocs[i] / originalCapacity);
                }
            }

            this._rerank();
            return { success: true, allocation: allocation };
        } else {
            return { success: false, allocation: this.availableAllocs.map(() => 0) };
        }
    }

    /**
     * Free previously allocated threads
     * @param allocation Array of thread allocations to free
     */
    free(allocation: number[]): void {
        for (let i = 0; i < allocation.length; ++i) {
            if (allocation[i] > 0) {
                this.availableAllocs[i] += allocation[i];

                // Recalculate utilization after freeing
                const totalCapacity = this.availableAllocs[i];
                const used = totalCapacity - this.availableAllocs[i];
                this.serverUtilization[i] = totalCapacity > 0 ? used / totalCapacity : 0;
            }
        }
        this._rerank();
    }

    /**
     * Get total available threads across all servers
     * @returns Total number of available threads
     */
    getTotalAvailableThreads(): number {
        return this.availableAllocs.reduce((sum, threads) => sum + threads, 0);
    }

    /**
     * Get the number of servers with available threads
     * @returns Number of servers with available threads
     */
    getAvailableServerCount(): number {
        return this.availableAllocs.filter(threads => threads > 0).length;
    }
} 