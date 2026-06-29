import { NS } from '@ns';

// Types for the contract solver
interface ContractInfo {
    filename: string;
    server: string;
    type: string;
    data: unknown;
}

// Custom types for contract data
type StockData = [number, number[]];
type MathExpressionData = [string, number];
type Matrix<T> = T[][];

/**
 * Main function to scan for and solve coding contracts.
 * Usage: run /player/contract_solver.js
 */
export async function main(ns: NS): Promise<void> {
    ns.disableLog('ALL');

    const contracts = findAllContracts(ns);
    contracts.forEach(contract => {
        const result = solveContract(contract, ns);
        ns.print(`${contract.server} - ${contract.filename} - ${contract.type} - ${result || 'FAILED!'}`);
    });
}

/** Find all coding contracts across the network using inline BFS. */
function findAllContracts(ns: NS): ContractInfo[] {
    return getAllServers(ns).flatMap(server =>
        ns.ls(server, '.cct').map(filename => ({
            filename,
            server,
            type: ns.codingcontract.getContractType(filename, server),
            data: ns.codingcontract.getData(filename, server),
        }))
    );
}

/** BFS scan of the entire network. */
function getAllServers(ns: NS): string[] {
    const servers: string[] = ['home'];
    const scanned: Set<string> = new Set(['home']);
    for (let i = 0; i < servers.length; i++) {
        for (const server of ns.scan(servers[i])) {
            if (!scanned.has(server)) {
                scanned.add(server);
                servers.push(server);
            }
        }
    }
    return servers;
}

/** Attempt to solve a coding contract; returns the attempt result or empty string. */
function solveContract(contract: ContractInfo, ns: NS): string {
    const { type, data, server, filename } = contract;
    let solution: unknown = '';

    switch (type) {
        case 'Algorithmic Stock Trader I':
            solution = StockTrader.solve([1, data as number[]]);
            break;
        case 'Algorithmic Stock Trader II':
            solution = StockTrader.solve([Math.ceil((data as number[]).length / 2), data as number[]]);
            break;
        case 'Algorithmic Stock Trader III':
            solution = StockTrader.solve([2, data as number[]]);
            break;
        case 'Algorithmic Stock Trader IV':
            solution = StockTrader.solve(data as StockData);
            break;
        case 'Minimum Path Sum in a Triangle':
            solution = TriangleSum.solve(data as number[][]);
            break;
        case 'Unique Paths in a Grid I':
            solution = GridPaths.solveUniquePaths1(data as number[]);
            break;
        case 'Unique Paths in a Grid II':
            solution = GridPaths.solveUniquePaths2(data as number[][]);
            break;
        case 'Generate IP Addresses':
            solution = IpAddresses.generate(data as string | number);
            break;
        case 'Find Largest Prime Factor':
            solution = PrimeFactor.findLargest(data as number);
            break;
        case 'Spiralize Matrix':
            solution = SpiralMatrix.spiralize(data as Matrix<unknown>);
            break;
        case 'Merge Overlapping Intervals':
            solution = MergeIntervals.solve(data as number[][]);
            break;
        case 'Array Jumping Game':
            solution = ArrayJumping.solve(data as number[]);
            break;
        case 'Find All Valid Math Expressions':
            solution = MathExpressions.findAll(data as MathExpressionData);
            break;
        case 'Subarray with Maximum Sum':
            solution = MaxSubarray.solve(data as number[]);
            break;
        case 'Total Ways to Sum':
            solution = WaysToSum.solve(data as number);
            break;
        case 'Sanitize Parentheses in Expression':
            solution = SanitizeParentheses.solve(data as string);
            break;
        default:
            return '';
    }

    return solution !== '' ? ns.codingcontract.attempt(solution as string | number | string[], filename, server) : '';
}

// ── Contract Solvers ──────────────────────────────────────────────────────────

class StockTrader {
    static solve(arrayData: StockData | [number, number[]]): number {
        const maxTrades   = arrayData[0];
        const stockPrices = arrayData[1];
        const profits: number[][] = Array(maxTrades)
            .fill(0)
            .map(() => Array(stockPrices.length).fill(0));

        for (let i = 0; i < maxTrades; i++) {
            for (let j = 0; j < stockPrices.length; j++) {
                for (let k = j; k < stockPrices.length; k++) {
                    if (i > 0 && j > 0 && k > 0) {
                        profits[i][k] = Math.max(profits[i][k], profits[i - 1][k], profits[i][k - 1], profits[i - 1][j - 1] + stockPrices[k] - stockPrices[j]);
                    } else if (i > 0 && j > 0) {
                        profits[i][k] = Math.max(profits[i][k], profits[i - 1][k], profits[i - 1][j - 1] + stockPrices[k] - stockPrices[j]);
                    } else if (i > 0 && k > 0) {
                        profits[i][k] = Math.max(profits[i][k], profits[i - 1][k], profits[i][k - 1], stockPrices[k] - stockPrices[j]);
                    } else if (j > 0 && k > 0) {
                        profits[i][k] = Math.max(profits[i][k], profits[i][k - 1], stockPrices[k] - stockPrices[j]);
                    } else {
                        profits[i][k] = Math.max(profits[i][k], stockPrices[k] - stockPrices[j]);
                    }
                }
            }
        }
        return profits[maxTrades - 1][stockPrices.length - 1];
    }
}

class TriangleSum {
    static solve(triangle: number[][]): number {
        let previousRow = triangle[0];
        for (let i = 1; i < triangle.length; i++) {
            const currentRow: number[] = [];
            for (let j = 0; j < triangle[i].length; j++) {
                if (j === 0) {
                    currentRow.push(previousRow[j] + triangle[i][j]);
                } else if (j === triangle[i].length - 1) {
                    currentRow.push(previousRow[j - 1] + triangle[i][j]);
                } else {
                    currentRow.push(Math.min(previousRow[j], previousRow[j - 1]) + triangle[i][j]);
                }
            }
            previousRow = currentRow;
        }
        return Math.min(...previousRow);
    }
}

class GridPaths {
    static factorial(n: number): number { return GridPaths.factorialDivision(n, 1); }

    static factorialDivision(n: number, d: number): number {
        if (n === 0 || n === 1 || n === d) return 1;
        return GridPaths.factorialDivision(n - 1, d) * n;
    }

    static solveUniquePaths1(grid: number[]): number {
        const rightMoves = grid[0] - 1;
        const downMoves  = grid[1] - 1;
        return Math.round(GridPaths.factorialDivision(rightMoves + downMoves, rightMoves) / GridPaths.factorial(downMoves));
    }

    static solveUniquePaths2(grid: number[][], ignoreFirst = false, ignoreLast = false): number {
        const rightMoves = grid[0].length - 1;
        const downMoves  = grid.length - 1;
        let totalPossiblePaths = Math.round(
            GridPaths.factorialDivision(rightMoves + downMoves, rightMoves) / GridPaths.factorial(downMoves)
        );

        for (let i = 0; i < grid.length; i++) {
            for (let j = 0; j < grid[i].length; j++) {
                if (grid[i][j] === 1 &&
                    (!ignoreFirst || (i !== 0 || j !== 0)) &&
                    (!ignoreLast  || (i !== grid.length - 1 || j !== grid[i].length - 1))) {
                    const newArray: number[][] = [];
                    for (let k = i; k < grid.length; k++) {
                        newArray.push(grid[k].slice(j, grid[i].length));
                    }
                    let removedPaths = GridPaths.solveUniquePaths2(newArray, true, ignoreLast);
                    removedPaths *= GridPaths.solveUniquePaths1([i + 1, j + 1]);
                    totalPossiblePaths -= removedPaths;
                }
            }
        }
        return totalPossiblePaths;
    }
}

class IpAddresses {
    private static isValidSegment(segment: string): boolean {
        if (segment[0] === '0' && segment !== '0') return false;
        const num = Number(segment);
        return num >= 0 && num <= 255;
    }

    static generate(input: string | number): string[] {
        const num    = input.toString();
        const length = num.length;
        const ips: string[] = [];

        for (let i = 1; i < length - 2; i++) {
            for (let j = i + 1; j < length - 1; j++) {
                for (let k = j + 1; k < length; k++) {
                    const segments = [num.slice(0, i), num.slice(i, j), num.slice(j, k), num.slice(k)];
                    if (segments.every(IpAddresses.isValidSegment)) {
                        ips.push(segments.join('.'));
                    }
                }
            }
        }
        return ips;
    }
}

class PrimeFactor {
    static findLargest(num: number): number {
        for (let div = 2; div <= Math.sqrt(num); div++) {
            if (num % div !== 0) continue;
            num = num / div;
            div = 2;
        }
        return num;
    }
}

class SpiralMatrix {
    private static extractColumn<T>(arr: T[][], index: number): T[] {
        const result: T[] = [];
        for (let i = 0; i < arr.length; i++) {
            const element = arr[i].splice(index, 1)[0];
            if (element !== undefined) result.push(element);
        }
        return result;
    }

    static spiralize<T>(arr: T[][], accumulator: T[] = []): T[] {
        if (arr.length === 0 || arr[0].length === 0) return accumulator;
        accumulator = accumulator.concat(arr.shift() || []);
        if (arr.length === 0 || arr[0].length === 0) return accumulator;
        accumulator = accumulator.concat(SpiralMatrix.extractColumn(arr, arr[0].length - 1));
        if (arr.length === 0 || arr[0].length === 0) return accumulator;
        accumulator = accumulator.concat((arr.pop() || []).reverse());
        if (arr.length === 0 || arr[0].length === 0) return accumulator;
        accumulator = accumulator.concat(SpiralMatrix.extractColumn(arr, 0).reverse());
        if (arr.length === 0 || arr[0].length === 0) return accumulator;
        return SpiralMatrix.spiralize(arr, accumulator);
    }
}

class MergeIntervals {
    static solve(intervals: number[][]): number[][] {
        intervals.sort(([minA], [minB]) => minA - minB);
        for (let i = 0; i < intervals.length; i++) {
            for (let j = i + 1; j < intervals.length; j++) {
                const [min, max] = intervals[i];
                const [laterMin, laterMax] = intervals[j];
                if (laterMin <= max) {
                    intervals[i] = [min, laterMax > max ? laterMax : max];
                    intervals.splice(j, 1);
                    j = i;
                }
            }
        }
        return intervals;
    }
}

class ArrayJumping {
    static solve(data: number[]): number {
        const reachable = Array(data.length).fill(false);
        reachable[0] = true;
        for (let i = 0; i < data.length; i++) {
            if (!reachable[i]) continue;
            const maxJump = Math.min(i + data[i], data.length - 1);
            for (let j = i; j <= maxJump; j++) reachable[j] = true;
        }
        return reachable[data.length - 1] ? 1 : 0;
    }
}

class MathExpressions {
    static findAll(data: MathExpressionData): string {
        const [expression, target] = data;
        const operators = ['', '+', '-', '*'];
        const validExpressions: string[] = [];
        const permutations = Math.pow(4, expression.length - 1);

        for (let i = 0; i < permutations; i++) {
            const summands: number[] = [];
            let candidate = expression[0];
            summands[0] = parseInt(expression[0]);

            for (let j = 1; j < expression.length; j++) {
                const operatorIndex = (i >> ((j - 1) * 2)) % 4;
                const operator = operators[operatorIndex];
                const digit = expression[j];
                candidate += operator + digit;
                const num = parseInt(digit);

                switch (operator) {
                    case '': {
                        const sign = summands[summands.length - 1] >= 0 ? 1 : -1;
                        summands[summands.length - 1] = summands[summands.length - 1] * 10 + (num * sign);
                        break;
                    }
                    case '+': summands.push(num); break;
                    case '-': summands.push(-num); break;
                    case '*': {
                        let currentDigit = num;
                        let j2 = j;
                        while (j2 < expression.length - 1 && ((i >> (j2 * 2)) % 4) === 0) {
                            j2++;
                            candidate += expression[j2];
                            currentDigit = currentDigit * 10 + parseInt(expression[j2]);
                            j = j2;
                        }
                        summands[summands.length - 1] *= currentDigit;
                        break;
                    }
                }
            }

            if (summands.reduce((a, b) => a + b, 0) === target) {
                validExpressions.push(candidate);
            }
        }

        return JSON.stringify(validExpressions);
    }
}

class MaxSubarray {
    static solve(data: number[]): number {
        let maxSoFar = data[0];
        let maxEndingHere = data[0];
        for (let i = 1; i < data.length; i++) {
            maxEndingHere = Math.max(data[i], maxEndingHere + data[i]);
            maxSoFar = Math.max(maxSoFar, maxEndingHere);
        }
        return maxSoFar;
    }
}

class WaysToSum {
    static solve(n: number): number {
        const ways = Array(n + 1).fill(0);
        ways[0] = 1;
        for (let i = 1; i <= n - 1; i++) {
            for (let j = i; j <= n; j++) ways[j] += ways[j - i];
        }
        return ways[n];
    }
}

class SanitizeParentheses {
    private static isParenthesis(char: string): boolean { return char === '(' || char === ')'; }

    private static isValidString(str: string): boolean {
        let count = 0;
        for (const ch of str) {
            if (ch === '(') count++;
            else if (ch === ')') count--;
            if (count < 0) return false;
        }
        return count === 0;
    }

    static solve(str: string): string[] {
        if (str.length === 0) return [];
        const visited = new Set<string>();
        const queue: string[] = [];
        const solutions: string[] = [];
        let foundValid = false;

        queue.push(str);
        visited.add(str);

        while (queue.length > 0) {
            const current = queue.shift()!;
            if (SanitizeParentheses.isValidString(current)) {
                solutions.push(current);
                foundValid = true;
            }
            if (foundValid) continue;

            for (let i = 0; i < current.length; i++) {
                if (!SanitizeParentheses.isParenthesis(current[i])) continue;
                const next = current.substring(0, i) + current.substring(i + 1);
                if (!visited.has(next)) {
                    queue.push(next);
                    visited.add(next);
                }
            }
        }

        return solutions.length > 0 ? solutions : [''];
    }
}
