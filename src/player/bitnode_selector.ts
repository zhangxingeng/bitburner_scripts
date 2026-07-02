import type { NS } from '@ns';
import { saveSubsystem } from '../lib/subsystem_state';
import { loadSettings } from '../lib/settings';
import { upsertPending, removePending, drainReplies, loadPending } from '../lib/decisions';
import { executeCommand } from '../lib/ns_dodge';
import { SCRIPT_PATHS } from '../lib/config';
import { notify } from '../cross/notification';

/**
 * BitNode Selector (docs/design/14 §8 Q3) — end-of-BitNode "suggest + approve" daemon.
 *
 * Contract: a PERSISTENT daemon, gated on `settings.autoBitNode` (already declared in
 * lib/settings.ts). Each loop: detect whether the current BitNode is beatable (hacking
 * route OR Bladeburner route), and if so — after TWO consecutive confirming polls, to
 * rule out a single-tick glitch/stale-read false positive — derive a next-BitNode
 * suggestion from a hardcoded priority order (below, distilled from
 * bitburner-src's own bitnode_recommendation_comprehensive_guide.md) and surface it as
 * a PendingDecision (lib/decisions.ts). This is an END-OF-RUN, whole-game-state-destroying
 * action — mirrors the aug/reset judgment call in cross/player_sequencer.ts and every
 * other irreversible action in this codebase (gang warfare engage, black ops, grafting,
 * corp founding): the daemon NEVER auto-fires. Every jump requires an explicit
 * human/MCP 'approve' verdict on the shared decision queue.
 *
 * Detection is batched into ONE lib/ns_dodge.ts executeCommand() call per tick (mirrors
 * cross/player_sequencer.ts's publishPlayerState pattern) so this daemon's own resident
 * RAM stays low — none of ns.getResetInfo/getPlayer/getServer/hasRootAccess/bladeburner.*
 * are ever referenced directly in this file's own top-level code.
 *
 * KNOWN RISK (flagged, not fixed here — see this file's own final-report writeup):
 * ns.singularity.destroyW0r1dD43m0n requires LIVE ROOT ACCESS (ns.hasRootAccess, not
 * just a backdoor) on host 'w0r1d_d43m0n'. Per bitburner-src's own server topology
 * (src/Server/data/servers.ts + src/Server/ServerHelpers.ts:initForeignServers), that
 * host has no `networkLayer` entry and is never wired in via connectServers() anywhere
 * in the game's source — so ns.scan() from any host never reaches it, and this repo's
 * BFS nuke sweep (lib/daemon_launcher.ts's nukeAndScan, which walks ns.scan()) can never
 * visit or root it. hasRoot will read false forever unless something elsewhere directly
 * targets the hardcoded hostname string (NS root-access functions take a hostname
 * argument and don't require scan-adjacency) — that fix is out of scope for this file.
 *
 * NOT in v1 scope (per design decision): b1tflum3 (BitFlume re-enter — no win-condition
 * gate exists for it) and BitNodeOptions customization (always passed as undefined).
 */

// ── Tuning constants ──────────────────────────────────────────────────────────
const SLEEP_MS = 20_000;              // rare, end-of-BN event — not a hot loop (15-30s cadence)
const BEATABLE_CONFIRM_POLLS = 2;     // consecutive agreeing polls required before surfacing
const DEFER_TICKS = 15;               // ~5 min at SLEEP_MS cadence
const DENY_COOLDOWN_TICKS = 180;      // ~1 hour — long cooldown fallback for a denied suggestion
const SF_SUFFICIENT_LEVEL = 2;        // "done enough" SF threshold — skip BNs already at/above this

/** Stable id for the (single) BitNode-jump judgment call. */
const BITNODE_DECISION_ID = 'bitNodeJump';

/** Subsystem id this daemon publishes under (status/subsystems/bitnode.json). */
const SUBSYSTEM_ID = 'bitnode';

const WORLD_DAEMON_HOST = 'w0r1d_d43m0n';

// ── v1 hardcoded priority order ───────────────────────────────────────────────
//
// Distilled from bitburner-src's own
// src/Documentation/doc/en/advanced/bitnode_recommendation_comprehensive_guide.md
// ("Order advice" section), which explicitly warns there's no single "perfect" order
// but gives a clear rough shape: BN1 first (repeat for its huge SF buff) → early/
// beginner-friendly BNs (Gang, Intelligence) → "situational" BNs that unlock big
// utility mechanics (Singularity, Bladeburner, Sleeves+Grafting, IPvGO) → BNs the
// guide calls genuinely hard and worth preparing for first (HackNet server,
// Stanek's Gift) → "challenging" BNs the guide treats as optional/late (Corp, stock
// market) → BN15 (complex, guide says experiment with the base mechanic elsewhere
// first) → BN12 (guide says "try after unlocking all mechanics") → BN11 last (guide
// explicitly calls it "bad" — hard with mediocre rewards, "only do it at the end").
const BITNODE_PRIORITY_ORDER: readonly number[] = [
    1,                  // repeat first — huge SF1 buff, no penalty multipliers
    2, 5,               // early/beginner picks — Gang, Intelligence + free Formulas.exe
    4, 6, 7, 10, 14,    // situational utility unlocks — Singularity, Bladeburner x2, Sleeves+Grafting, IPvGO
    9, 13,              // guide calls these "extremely harsh" — prepare via the above first
    3, 8,               // "challenging" BNs the guide treats as optional — Corp, stock market
    15,                 // complex — guide recommends trying the base mechanic elsewhere first
    12,                 // guide: try only after unlocking all mechanics
    11,                 // guide explicitly calls this "bad" (hard, mediocre reward) — last
];

/** One-line rationale per BN, surfaced in the decision prompt (from the same guide). */
const BITNODE_BLURBS: Record<number, string> = {
    1:  'repeat for the SF1 buff (huge — worth stacking to at least level 2)',
    2:  'Gang — simple, useful, benefits persist through resets',
    3:  'Corporation — powerful but complex; guide treats it as optional/late',
    4:  'Singularity APIs — automation, but harsh multipliers on a first pass',
    5:  'Intelligence + permanent free Formulas.exe access',
    6:  'Bladeburner (no penalty mods) — slow but rarely nerfed elsewhere',
    7:  'Bladeburner (with penalty mods) — buffs Bladeburner multipliers, free Blade\'s Simulacrum',
    8:  'stock-market-only economy — guide calls this an interesting but slow challenge',
    9:  'HackNet Servers — powerful utility, but guide calls multipliers "extremely harsh"',
    10: 'Sleeves + Grafting — strong utility, synergizes with Gang/Bladeburner karma/rank farming',
    11: 'guide explicitly calls this a "bad" BitNode — hard, mediocre rewards; do it last',
    12: 'infinitely-scaling NFG rewards — guide: attempt only after unlocking all other mechanics',
    13: 'Stanek\'s Gift — powerful, but guide calls multipliers "extremely harsh"',
    14: 'IPvGO buffs + cheat APIs — guide calls this fairly harsh but IPvGO itself is well-tuned',
    15: 'enhanced darknet — guide recommends experimenting with the base mechanic first',
};

// ── Detection ──────────────────────────────────────────────────────────────────

interface BitNodeSnapshot {
    currentNode:           number;
    ownedSF:               Record<number, number>;
    hacking:               number;
    requiredHackingSkill:  number;
    hasRoot:               boolean;
    allBlackOpsComplete:   boolean;
}

/**
 * Gather everything needed to evaluate "is the current BitNode beatable?" in ONE
 * batched executeCommand() call — keeps every RAM-costly/gated NS call (Bladeburner
 * especially, which is 16x/4x-multiplied without SF6/7, same shape as Singularity)
 * paid for by the ephemeral temp script, not this daemon's own resident footprint.
 *
 * The Bladeburner probe distinguishes "not accessible" (not unlocked / not joined —
 * ns.bladeburner.getNextBlackOp() throws) from "genuinely all Black Ops complete"
 * (resolves to null) — collapsing both to true would falsely mark BEATABLE for every
 * player who has never touched Bladeburner.
 */
async function gatherSnapshot(ns: NS): Promise<BitNodeSnapshot | null> {
    return executeCommand<BitNodeSnapshot>(
        ns,
        `(() => {
            const resetInfo = ns.getResetInfo();
            const ownedSF = {};
            for (const [k, v] of resetInfo.ownedSF) ownedSF[k] = v;
            const player = ns.getPlayer();
            // '${WORLD_DAEMON_HOST}' is registered as an "isolated non-dnet server" until
            // the player has installed "The Red Pill" (confirmed against bitburner-src's
            // NetscriptHelpers.tsx getServer() doc comment: "Throw an error if the server
            // does not exist or is an isolated non-dnet server (e.g. ... pre-TRP WD)") —
            // ns.getServer/ns.hasRootAccess on this host THROW unconditionally until then,
            // not just when unreachable via scan. Found live 2026-07-02: this crashed the
            // whole snapshot every tick pre-TRP, surfacing as a generic "detection failed"
            // status. ownedAugs is already fetched via getResetInfo (zero extra RAM) and is
            // keyed by augmentation display name, so gate the entire WD probe on it instead
            // of guessing from a try/catch around getServer itself.
            const hasTRP = resetInfo.ownedAugs.has('The Red Pill');
            let requiredHackingSkill = Infinity;
            let hasRoot = false;
            if (hasTRP) {
                // Network-topology note (still true, independent of the TRP gate above):
                // '${WORLD_DAEMON_HOST}' has no scan-adjacency entry, so the general BFS
                // nuke sweep (lib/daemon_launcher.ts's nukeAndScan) never visits or roots
                // it even once hacking level clears the requirement. NS root functions take
                // a hostname string directly and don't require scan-adjacency, so attempt
                // it here by hostname every tick (cheap no-op once already rooted or if
                // ports are still insufficient).
                const wd = ns.getServer('${WORLD_DAEMON_HOST}');
                requiredHackingSkill = wd.requiredHackingSkill ?? Infinity;
                if (!ns.hasRootAccess('${WORLD_DAEMON_HOST}')) {
                    const openers = [
                        ['BruteSSH.exe',  h => ns.brutessh(h)],
                        ['FTPCrack.exe',  h => ns.ftpcrack(h)],
                        ['relaySMTP.exe', h => ns.relaysmtp(h)],
                        ['HTTPWorm.exe',  h => ns.httpworm(h)],
                        ['SQLInject.exe', h => ns.sqlinject(h)],
                    ];
                    for (const [file, open] of openers) {
                        if (ns.fileExists(file)) { try { open('${WORLD_DAEMON_HOST}'); } catch {} }
                    }
                    try { ns.nuke('${WORLD_DAEMON_HOST}'); } catch { /* not enough ports open yet */ }
                }
                hasRoot = ns.hasRootAccess('${WORLD_DAEMON_HOST}');
            }
            let allBlackOpsComplete = false;
            try {
                allBlackOpsComplete = ns.bladeburner.getNextBlackOp() === null;
            } catch {
                allBlackOpsComplete = false; // not unlocked/joined — route unavailable, not "complete"
            }
            return {
                currentNode: resetInfo.currentNode,
                ownedSF,
                hacking: player.skills.hacking,
                requiredHackingSkill,
                hasRoot,
                allBlackOpsComplete,
            };
        })()`,
    );
}

/** Stable signature of the ownedSF map — used to detect "something materially changed". */
function ownedSFSignature(ownedSF: Record<number, number>): string {
    return Object.entries(ownedSF)
        .map(([bn, lvl]) => `${bn}:${lvl}`)
        .sort()
        .join(',');
}

/**
 * Walk BITNODE_PRIORITY_ORDER and pick the highest-priority BN the player has not
 * already reached a "done enough" SF level on (design decision: SF level ≥
 * SF_SUFFICIENT_LEVEL is sufficient for v1 — matches the game's own SF-level display
 * convention of treating higher levels as diminishing-return territory). Returns null
 * if every BN in the priority list is already sufficiently leveled.
 */
function pickNextBitNode(ownedSF: Record<number, number>): { bn: number; blurb: string } | null {
    for (const bn of BITNODE_PRIORITY_ORDER) {
        const level = ownedSF[bn] ?? 0;
        if (level < SF_SUFFICIENT_LEVEL) {
            return { bn, blurb: BITNODE_BLURBS[bn] ?? '' };
        }
    }
    return null;
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function main(ns: NS): Promise<void> {
    ns.disableLog('ALL');

    let tick = 0;

    // Two-consecutive-poll confirmation guard (safety rule: never surface on a
    // single-tick glitch/stale-read). Any disagreeing poll resets the counter.
    let beatableConfirmCount = 0;

    // "Deny" suppression: remember which BN + ownedSF-signature was denied, plus a
    // long-cooldown fallback (mirrors grafting_manager.ts's denied-value pattern,
    // adapted with an additional cooldown since a BitNode jump is far rarer/higher
    // stakes than a graft). Suppressed while ALL of: same suggested BN, same ownedSF
    // signature (nothing materially changed), AND cooldown not yet elapsed.
    let deniedNextBN = -1;
    let deniedSFSignature = '';
    let deniedCooldownUntilTick = 0;

    // "Defer" suppression: tick-cooldown (mirrors gang_manager.ts's warfare defer).
    let deferUntilTick = 0;

    while (true) {
        tick++;

        const settings = loadSettings(ns);
        const enabled = settings.autoBitNode;

        // Snapshot is fetched BEFORE reply processing so a 'deny' this tick can
        // capture the ownedSF signature it was denied at immediately (rather than
        // needing a stale placeholder that only gets filled in on some later tick).
        const snap = await gatherSnapshot(ns);
        if (snap == null) {
            // Dodge script failed (RAM-starved / transient) — never crash, just idle.
            saveSubsystem(ns, {
                id: SUBSYSTEM_ID, available: false, enabled, running: false,
                headline: 'BitNode selector: detection failed (RAM-starved dodge script?)',
                metrics: {}, ts: Date.now(),
            });
            await ns.sleep(SLEEP_MS);
            continue;
        }

        // ── Apply human/MCP verdicts on the bitnode-jump decision ────────────────
        // Scoped strictly to our own decision id — the shared reply port has other
        // consumers (gang/sleeve/bladeburner/grafting/stanek managers + player_sequencer);
        // an unscoped drain would steal their replies.
        const repliesReceived = drainReplies(ns, id => id === BITNODE_DECISION_ID);
        if (repliesReceived.length > 0) {
            const pendingNow = loadPending(ns).find(p => p.id === BITNODE_DECISION_ID);
            const ctxNextBN = (pendingNow?.context?.['nextBN'] as number | undefined) ?? -1;
            const ctxRoute  = (pendingNow?.context?.['route'] as string | undefined) ?? '';
            for (const reply of repliesReceived) {
                removePending(ns, BITNODE_DECISION_ID);
                if (reply.verdict === 'approve') {
                    if (ctxNextBN > 0) {
                        ns.print(`DECISION approved — firing destroyW0r1dD43m0n(${ctxNextBN}) via route=${ctxRoute}`);
                        await executeCommand<void>(
                            ns,
                            `ns.singularity.destroyW0r1dD43m0n(${ctxNextBN}, "${SCRIPT_PATHS.brain}")`,
                        );
                        // The reset tears down this daemon (and every other process) —
                        // nothing further to do; the game will relaunch brain.js fresh.
                    } else {
                        ns.print('WARN: approve verdict received but no cached BitNode candidate — ignored');
                    }
                } else if (reply.verdict === 'deny') {
                    deniedNextBN = ctxNextBN;
                    deniedSFSignature = ownedSFSignature(snap.ownedSF);
                    deniedCooldownUntilTick = tick + DENY_COOLDOWN_TICKS;
                    ns.print(`DECISION denied — BN${deniedNextBN} suppressed until ownedSF changes or ${DENY_COOLDOWN_TICKS} ticks pass`);
                } else if (reply.verdict === 'defer') {
                    deferUntilTick = tick + DEFER_TICKS;
                    ns.print(`DECISION deferred — re-surfacing in ${DEFER_TICKS} ticks`);
                }
            }
        }

        const hackingRouteMet     = snap.hacking >= snap.requiredHackingSkill && snap.hasRoot;
        const bladeburnerRouteMet = snap.allBlackOpsComplete;
        const beatableThisTick    = hackingRouteMet || bladeburnerRouteMet;

        // ── Two-consecutive-poll confirmation (safety rule) ──────────────────────
        if (beatableThisTick) {
            beatableConfirmCount++;
        } else {
            beatableConfirmCount = 0;
        }
        const beatableConfirmed = beatableConfirmCount >= BEATABLE_CONFIRM_POLLS;

        if (!beatableConfirmed) {
            removePending(ns, BITNODE_DECISION_ID);
            saveSubsystem(ns, {
                id: SUBSYSTEM_ID, available: true, enabled, running: false,
                headline: beatableThisTick
                    ? `BitNode ${snap.currentNode}: beatable signal seen (${beatableConfirmCount}/${BEATABLE_CONFIRM_POLLS} confirming polls) — waiting to confirm`
                    : `BitNode ${snap.currentNode}: not yet beatable (hacking ${snap.hacking}/${snap.requiredHackingSkill}${snap.hasRoot ? '' : ', no root on ' + WORLD_DAEMON_HOST}; Black Ops ${bladeburnerRouteMet ? 'complete' : 'incomplete'})`,
                metrics: {
                    currentNode: snap.currentNode,
                    hacking: snap.hacking,
                    requiredHackingSkill: snap.requiredHackingSkill,
                    hasRootOnWorldDaemon: String(snap.hasRoot),
                    allBlackOpsComplete: String(snap.allBlackOpsComplete),
                },
                ts: Date.now(),
            });
            await ns.sleep(SLEEP_MS);
            continue;
        }

        // ── Confirmed beatable — derive a suggestion and (maybe) surface it ──────
        const route = hackingRouteMet ? 'hacking' : 'bladeburner';
        const suggestion = pickNextBitNode(snap.ownedSF);

        if (!enabled || suggestion == null) {
            removePending(ns, BITNODE_DECISION_ID);
            saveSubsystem(ns, {
                id: SUBSYSTEM_ID, available: true, enabled, running: false,
                headline: suggestion == null
                    ? `BitNode ${snap.currentNode} beatable (route=${route}) — every priority-list BN already at SF ≥ ${SF_SUFFICIENT_LEVEL}, no v1 suggestion`
                    : `BitNode ${snap.currentNode} beatable (route=${route}) — suggestion available, autoBitNode disabled`,
                metrics: { currentNode: snap.currentNode, route, beatable: 'true' },
                ts: Date.now(),
            });
            await ns.sleep(SLEEP_MS);
            continue;
        }

        const { bn: nextBN, blurb } = suggestion;
        const sfSignature = ownedSFSignature(snap.ownedSF);
        const suppressed =
            (nextBN === deniedNextBN && sfSignature === deniedSFSignature && tick < deniedCooldownUntilTick)
            || tick < deferUntilTick;

        if (suppressed) {
            saveSubsystem(ns, {
                id: SUBSYSTEM_ID, available: true, enabled, running: false,
                headline: `BitNode ${snap.currentNode} beatable (route=${route}) — suggestion BN${nextBN} suppressed (deny/defer cooldown)`,
                metrics: { currentNode: snap.currentNode, route, suggestedBN: nextBN },
                ts: Date.now(),
            });
        } else {
            const prompt =
                `BitNode ${snap.currentNode} beatable via ${route} route — `
                + `suggest jumping to BN${nextBN} (${blurb}). Destroy w0r1d_d43m0n and proceed?`;
            const added = upsertPending(ns, {
                id: BITNODE_DECISION_ID,
                kind: 'bitNode',
                prompt,
                command: `ns.singularity.destroyW0r1dD43m0n(${nextBN}, "${SCRIPT_PATHS.brain}")`,
                context: { nextBN, route },
                ts: Date.now(),
            });
            if (added) {
                notify(
                    ns,
                    prompt,
                    'Approve to destroy the world daemon and jump BitNodes now; this resets ALL current-life progress except Source-Files.',
                    { nextBN, route, currentNode: snap.currentNode },
                );
            }
            saveSubsystem(ns, {
                id: SUBSYSTEM_ID, available: true, enabled, running: true,
                headline: `BitNode ${snap.currentNode} beatable (route=${route}) — awaiting approval to jump to BN${nextBN}`,
                metrics: { currentNode: snap.currentNode, route, suggestedBN: nextBN },
                ts: Date.now(),
            });
        }

        await ns.sleep(SLEEP_MS);
    }
}
