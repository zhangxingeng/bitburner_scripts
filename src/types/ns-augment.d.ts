/**
 * Augment the @ns `Player` type with runtime fields that exist in-game but are
 * absent from NetscriptDefinitions.d.ts.
 *
 * ⚠️ DANGER: every declaration here is an UNCHECKED promise to the type checker.
 * tsc validates your code against it WITHOUT verifying the runtime actually has
 * it. A wrong declaration makes tsc green while the call crashes at runtime. We
 * learned this twice the hard way: a fake `formatNumber()` and the removed
 * top-level purchased-server APIs both lived here and crashed in production
 * (formatNumber → use ns.format.number; the pserv APIs → moved to ns.cloud.*).
 *
 * Before adding ANYTHING here: confirm it exists in the current engine — check
 * ../bitburner-src and make sure it is NOT listed in src/utils/APIBreaks/*.ts —
 * and cite the source in a comment. When in doubt, leave it out.
 */

declare module '@ns' {
    interface Player {
        /** Money earned per second from current work action (crime, job, study). 0 if idle/hacking. */
        workMoneyGainRate?: number;
        /** Reputation earned per second from current work action. */
        workRepGainRate?: number;
    }
}

export {};
