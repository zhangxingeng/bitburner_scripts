/**
 * Thread allocator for distributing batches across servers
 * Based on the Allocator class from the high-income script
 */
export class Allocator {
    private availableAllocs: number[];
    private availableAscRank: number[];

    /**
     * Create a new thread allocator
     * @param availableAllocs Number of available threads per server
     */
    constructor(availableAllocs: number[]) {
        this.availableAllocs = availableAllocs.slice();
        this.availableAscRank = availableAllocs.map((_, ind) => ind);
        this._rerank();
    }

    /**
     * Sort servers by available thread count
     * @private
     */
    private _rerank(): void {
        this.availableAscRank = this.availableAllocs.map((_, ind) => ind)
            .sort((indA, indB) => this.availableAllocs[indA] - this.availableAllocs[indB]);
    }

    /**
     * Allocate threads across servers
     * @param count Number of threads to allocate
     * @param splitable Whether the allocation can be split across servers
     * @returns Allocation result with success status and allocation array
     */
    alloc(count: number, splitable: boolean = true): { success: boolean; allocation: number[] } {
        const availableAllocTmp = this.availableAllocs.slice();
        const allocation = this.availableAllocs.map(() => 0);

        if (splitable) {
            // Split allocation across servers
            for (let i = 0; i < this.availableAscRank.length; ++i) {
                const serverIndex = this.availableAscRank[i];
                const curAlloc = Math.min(this.availableAllocs[serverIndex], count);

                availableAllocTmp[serverIndex] -= curAlloc;
                allocation[serverIndex] += curAlloc;
                count -= curAlloc;

                if (count === 0) {
                    break;
                }
            }
        } else {
            // Find a single server with enough capacity
            for (let i = 0; i < this.availableAscRank.length; ++i) {
                const serverIndex = this.availableAscRank[i];
                if (this.availableAllocs[serverIndex] >= count) {
                    availableAllocTmp[serverIndex] -= count;
                    allocation[serverIndex] += count;
                    count = 0;
                    break;
                }
            }
        }

        // If all threads were allocated, update available allocs
        if (count === 0) {
            this.availableAllocs = availableAllocTmp;
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
            this.availableAllocs[i] += allocation[i];
        }
        this._rerank();
    }
} 