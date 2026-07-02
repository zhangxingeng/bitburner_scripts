import { SCRIPT_PATHS } from './config';
import type { BooleanSettingKey } from './settings';

/**
 * Player-subsystem manager registry (docs/design/11 §3.3).
 *
 * THE single declaration of which subsystem daemons exist, where they live, and
 * which settings toggle gates each. The player_sequencer walks this list every
 * tick: toggle ON → keep the daemon alive (crash-guard/relaunch); toggle OFF →
 * ensure it's stopped. Each manager is a PERSISTENT daemon that self-guards on
 * SF/BitNode availability and idles (does not exit) when its feature is absent.
 *
 * Adding a subsystem = a SCRIPT_PATHS entry + a row here + the manager script.
 * The sequencer never changes — that's what keeps the parallel build disjoint.
 *
 * NOTE: hacknet/stock engines are already launched by lib/config.ts's
 * DAEMON_CATALOG (walked each tick by lib/daemon_launcher.ts, called from
 * brain.ts — bootstrap.ts, which used to own this, is gone); their rows here
 * point at lightweight STATUS-SHIM daemons that publish a SubsystemStatus for
 * the console (they report on the running engine, they don't relaunch it).
 */
export interface ManagerSpec {
	id:         string;             // SubsystemStatus id ('gang' | 'corp' | …)
	path:       string;             // daemon script path (SCRIPT_PATHS value)
	settingKey: BooleanSettingKey;  // boolean toggle that gates it
	label:      string;             // human label for logs
}

export const PLAYER_MANAGERS: ManagerSpec[] = [
	{ id: 'contracts',   path: SCRIPT_PATHS.contractManager,    settingKey: 'autoSolveContracts', label: 'Contracts'   },
	{ id: 'gang',        path: SCRIPT_PATHS.gangManager,        settingKey: 'autoGang',           label: 'Gang'        },
	{ id: 'corp',        path: SCRIPT_PATHS.corpManager,        settingKey: 'autoCorp',           label: 'Corp'        },
	{ id: 'bladeburner', path: SCRIPT_PATHS.bladeburnerManager, settingKey: 'autoBladeburner',    label: 'Bladeburner' },
	{ id: 'sleeve',      path: SCRIPT_PATHS.sleeveManager,      settingKey: 'autoSleeve',         label: 'Sleeve'      },
	{ id: 'stanek',      path: SCRIPT_PATHS.stanekManager,      settingKey: 'autoStanek',         label: 'Stanek'      },
	{ id: 'grafting',    path: SCRIPT_PATHS.graftingManager,    settingKey: 'autoGrafting',       label: 'Grafting'    },
	{ id: 'hacknet',     path: SCRIPT_PATHS.hacknetStatus,      settingKey: 'autoHacknet',        label: 'Hacknet'     },
	{ id: 'stock',       path: SCRIPT_PATHS.stockStatus,        settingKey: 'autoStock',          label: 'Stock'       },
	{ id: 'crime',       path: SCRIPT_PATHS.crime,              settingKey: 'autoCrime',          label: 'Crime'       },
	{ id: 'bitnode',     path: SCRIPT_PATHS.bitnodeSelector,    settingKey: 'autoBitNode',        label: 'BitNode'     },
];

/** Subsystem ids in registry order (the console loads statuses for these). */
export const SUBSYSTEM_IDS: readonly string[] = PLAYER_MANAGERS.map(m => m.id);
