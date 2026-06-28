/**
 * Game Bridge — WebSocket server (port 12525) that replaces bitburner-filesync.
 *
 * Daemon mode (`pnpm run watch:all`):     file sync only
 * Interactive mode (`pnpm run bridge`):   REPL for querying live game state
 */

import { WebSocketServer, type WebSocket } from "ws";
import chokidar from "chokidar";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { dist, allowedFiletypes } from "./config.js";

// ── State ──

let gameSocket: WebSocket | null = null;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
let nextId = 1;
const pendingSync = new Set<string>();

// ── Helpers ──

function log(tag: string, msg: string) {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] [${tag}] ${msg}`);
}

/** Send a JSON-RPC request, return a promise for the response. */
function rpc(method: string, params?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!gameSocket || gameSocket.readyState !== 1) {
      reject(new Error("Game not connected"));
      return;
    }
    const id = nextId++;
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params, id });
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`RPC timeout: ${method}`));
    }, 10000);
    pending.set(id, { resolve, reject, timer });
    gameSocket.send(msg);
  });
}

/** Push a single file from dist/ to the game. */
async function pushFile(filePath: string) {
  const relative = path.relative(dist, filePath).replace(/\\/g, "/");
  const ext = path.extname(relative);
  if (!allowedFiletypes.includes(ext)) return;

  try {
    const content = fs.readFileSync(filePath, "utf-8");
    await rpc("pushFile", { filename: `/${relative}`, content, server: "home" });
    log("SYNC", `${relative} → game`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "Game not connected") {
      pendingSync.add(filePath);
    } else {
      log("ERR", `push ${relative}: ${msg}`);
    }
  }
}

/** Push all files from dist/ to the game. */
async function pushAllFiles() {
  log("SYNC", "Pushing all files…");
  const files = walkDist();
  for (const f of files) {
    await pushFile(f);
    await sleep(10);
  }
  log("SYNC", `Done — ${files.length} files`);
}

function walkDist(): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dist, { recursive: true });
  for (const entry of entries) {
    const full = path.join(dist, entry as string);
    if (fs.statSync(full).isFile() && allowedFiletypes.includes(path.extname(entry as string))) {
      results.push(full);
    }
  }
  return results;
}

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** Handle an incoming message from the game (JSON-RPC response). */
function handleGameMessage(raw: string) {
  try {
    const msg = JSON.parse(raw);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject, timer } = pending.get(msg.id)!;
      clearTimeout(timer);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error));
      else resolve(msg.result);
      return;
    }
    log("GAME", raw);
  } catch { /* ignore malformed */ }
}

// ── File watcher ──

function startFileWatcher() {
  const watcher = chokidar.watch(`${dist}/**/*`, {
    ignored: /(^|[\\/])\\./,
    persistent: true,
    ignoreInitial: true,
  });

  watcher.on("change", async (p: string) => {
    if (fs.existsSync(p)) await pushFile(p);
  });
  watcher.on("add", async (p: string) => {
    await pushFile(p);
  });
  watcher.on("unlink", async (p: string) => {
    const relative = path.relative(dist, p).replace(/\\/g, "/");
    try {
      await rpc("deleteFile", { filename: `/${relative}`, server: "home" });
      log("SYNC", `${relative} deleted from game`);
    } catch { /* game not connected */ }
  });

  log("WATCH", `Watching ${dist}/`);
}

// ── REPL ──

function startRepl() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "game> " });

  rl.on("line", async (line: string) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }
    const [cmd, ...args] = input.split(/\s+/);

    try {
      switch (cmd) {
        case "servers": {
          const servers = await rpc("getAllServers") as Array<{ hostname: string; hasAdminRights: boolean; purchasedByPlayer: boolean }>;
          console.table(servers.map((s) => ({
            hostname: s.hostname,
            root: s.hasAdminRights ? "✓" : "✗",
            purchased: s.purchasedByPlayer ? "✓" : "",
          })));
          break;
        }
        case "files": {
          const host = args[0] || "home";
          const files = await rpc("getFileNames", { server: host }) as string[];
          console.log(files.join("\n") || "(empty)");
          break;
        }
        case "cat": {
          const file = args[0];
          const host = args[1] || "home";
          if (!file) { console.log("Usage: cat <filename> [server]"); break; }
          const content = await rpc("getFile", { filename: file, server: host }) as string;
          console.log(content);
          break;
        }
        case "ram": {
          const file = args[0];
          const host = args[1] || "home";
          if (!file) { console.log("Usage: ram <filename> [server]"); break; }
          const ram = await rpc("calculateRam", { filename: file, server: host }) as number;
          console.log(`${ram} GB`);
          break;
        }
        case "save": {
          log("REPL", "Fetching save data…");
          const result = await rpc("getSaveFile") as { save: string; binary: boolean };
          const outPath = args[0] || "save.json";
          fs.writeFileSync(outPath, result.save);
          log("REPL", `Save → ${outPath} (${result.save.length}B, binary: ${result.binary})`);
          break;
        }
        case "pushall": {
          await pushAllFiles();
          break;
        }
        case "raw": {
          const method = args[0];
          const paramsStr = args.slice(1).join(" ");
          let params: unknown;
          try { params = paramsStr ? JSON.parse(paramsStr) : undefined; } catch { params = undefined; }
          if (!method) { console.log("Usage: raw <method> [json params]"); break; }
          const result = await rpc(method, params);
          console.log(JSON.stringify(result, null, 2));
          break;
        }
        case "status": {
          const connected = gameSocket?.readyState === 1;
          console.log(`Game: ${connected ? "🟢 connected" : "🔴 disconnected"}`);
          console.log(`Pending RPCs: ${pending.size}`);
          console.log(`Pending sync: ${pendingSync.size} files`);
          break;
        }
        case "help":
          console.log(`Commands:
  servers              — list all servers + admin status
  files [host]         — list files on a server (default: home)
  cat <file> [host]    — read a file from the game
  ram <file> [host]    — calculate RAM usage of a script
  save [path]          — download save file
  pushall              — push all dist/ files to game
  raw <method> [json]  — send raw JSON-RPC
  status               — connection status
  help                 — this message
  exit / quit          — stop the bridge`);
          break;
        case "exit":
        case "quit":
          log("REPL", "Shutting down…");
          rl.close();
          process.exit(0);
        default:
          console.log(`Unknown: ${cmd}. Type 'help' for commands.`);
      }
    } catch (err: unknown) {
      log("ERR", err instanceof Error ? err.message : String(err));
    }
    rl.prompt();
  });

  rl.on("close", () => process.exit(0));
  rl.prompt();
}

// ── Main ──

const args = process.argv.slice(2);
const oneshot = args.includes("--oneshot");

log("INIT", "Starting Game Bridge on port 12525…");

const wss = new WebSocketServer({ port: 12525 });

wss.on("connection", (socket: WebSocket) => {
  log("GAME", "Game connected");
  gameSocket = socket;

  socket.on("message", (data) => handleGameMessage(data.toString()));

  socket.on("close", () => {
    log("GAME", "Game disconnected");
    gameSocket = null;
  });

  // Request typedefs + flush pending syncs after connection settles
  setTimeout(async () => {
    try {
      const defs = await rpc("getDefinitionFile") as string;
      fs.writeFileSync("NetscriptDefinitions.d.ts", defs);
      log("SYNC", "NetscriptDefinitions.d.ts updated");
    } catch { /* retry on next connect */ }

    if (pendingSync.size > 0) {
      log("SYNC", `Flushing ${pendingSync.size} pending files…`);
      for (const p of pendingSync) {
        await pushFile(p);
        await sleep(10);
      }
      pendingSync.clear();
    }
  }, 500);
});

wss.on("error", (err: NodeJS.ErrnoException) => {
  log("ERR", `Server error: ${err.message}`);
  if (err.code === "EADDRINUSE") {
    console.error("Port 12525 is already in use. Kill the other process and retry.");
    process.exit(1);
  }
});

startFileWatcher();

if (oneshot) {
  log("MODE", "One-shot — pushing all files then exiting");
  setTimeout(async () => {
    if (gameSocket) await pushAllFiles();
    process.exit(0);
  }, 3000);
} else if (process.stdin.isTTY) {
  startRepl();
} else {
  log("MODE", "Daemon mode — file sync only. Run `pnpm bridge` for REPL.");
  process.stdin.resume();
}
