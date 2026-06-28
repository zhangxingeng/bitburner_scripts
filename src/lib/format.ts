/** Format RAM amount to a human-readable string (GB → TB → PB → …). */
export function formatRam(ram: number): string {
    const units = ['GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    let unit = units[0];
    for (let i = 0; i < units.length; i++) {
        if (ram >= Math.pow(1024, i + 1)) unit = units[i];
    }
    return `${(ram / Math.pow(1024, units.indexOf(unit))).toFixed(2)}${unit}`;
}

/** Shorten a number with metric suffixes (K, M, B, T, …). Set sci=true for scientific notation. */
export function shortNumber(n: number, sci = false): string {
    if (n === 0) return '0';
    const neg = n < 0 ? '-' : '';
    const absN = Math.abs(n);

    if (sci) {
        const exp = Math.floor(Math.log10(absN));
        const coefficient = n / Math.pow(10, exp);
        return `${coefficient.toFixed(3)}e${exp}`.replace(/\.?0+e/, 'e');
    }

    const units = ['', 'K', 'M', 'B', 'T', 'Q', 'H', 'Z', 'Y'];
    const exp = Math.floor(Math.log10(absN) / 3);
    if (exp < units.length) {
        return `${neg}${(n / Math.pow(1000, exp)).toLocaleString('en-US', {
            maximumFractionDigits: 2,
            minimumFractionDigits: 2,
        })}${units[exp]}`;
    }
    const sciExp = Math.floor(Math.log10(absN));
    return `${(n / Math.pow(10, sciExp)).toFixed(3)}e${sciExp}`.replace(/\.?0+e/, 'e');
}

/** Format a money amount with $ prefix and shortened number. */
export function formatMoney(money: number): string {
    const symbol = money < 0 ? '-$' : '$';
    return `${symbol}${shortNumber(Math.abs(money))}`;
}

/** Format a 0–1 fraction as a padded percentage string. */
export function formatPercent(n: number): string {
    if (n === 0) return '';
    const clamped = Math.min(Math.max(n, -0.99999), 0.99999);
    return `${(clamped * 100).toFixed(1)}%`.padStart('-999.9%'.length, ' ');
}

/** Format milliseconds as HH:MM (or HH:MM:SS:mmm when precise=true). */
export function formatTime(ms: number, precise = false): string {
    const hours = Math.floor(ms / 3_600_000);
    const minutes = Math.floor((ms % 3_600_000) / 60_000);
    if (!precise) {
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    }
    const seconds = Math.floor((ms % 60_000) / 1000);
    const millis = ms % 1000;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}:${String(millis).padStart(3, '0')}`;
}

/** Pad a string to a fixed width with a pipe prefix. */
export function pad(str: string | number | undefined, len: number): string {
    return `| ${(str?.toString() ?? ' ').padEnd(len, ' ')}`;
}

/** Zero-pad a number to a fixed width. */
export function padNum(num: number, len: number): string {
    return num.toString().padStart(len, '0');
}
