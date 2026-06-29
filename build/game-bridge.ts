/**
 * Game Bridge — WebSocket server (port 12525) that replaces bitburner-filesync.
 *
 * Daemon mode (`pnpm run watch:all`):     file sync only
 * Interactive mode (`pnpm run bridge`):   REPL for querying live game state
 */

import { WebSocketServer, type WebSocket } from "ws";
import chokidar from "chokidar";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { dist, allowedFiletypes } from "./config.js";

// ── State ──

let gameSocket: WebSocket | null = null;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
let nextId = 1;
const pendingSync = new Set<string>();

// Admin state (port 12526)
const adminSockets = new Set<WebSocket>();
const adminPending = new Map<number, { adminSocket: WebSocket; adminId: number }>();

// Control agent state (port 12527)
let controlSocket: WebSocket | null = null;
const controlPending = new Map<number, { adminSocket: WebSocket; adminId: number }>();
let nextControlId = 1;
const latestState: Record<string, { ts: number; data: unknown }> = {};

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

// ── Sync engine ──

/** Fetch all files + their content from a game server via the remote API. */
async function getAllFiles(server: string = "home"): Promise<Array<{ filename: string; content: string }>> {
  return (await rpc("getAllFiles", { server })) as Array<{ filename: string; content: string }>;
}

/** Compute an MD5 hash of file content for comparison. */
function hashContent(content: string): string {
  return crypto.createHash("md5").update(content, "utf-8").digest("hex");
}

/** Read a local dist/ file and return its content + hash, or null if it doesn't exist. */
function readLocalFile(relativePath: string): { content: string; hash: string } | null {
  const fullPath = path.join(dist, relativePath);
  try {
    const content = fs.readFileSync(fullPath, "utf-8");
    return { content, hash: hashContent(content) };
  } catch {
    return null;
  }
}

/**
 * On game connect: compare local dist/ files against remote files and push
 * any that are missing or have different content.  Uses hash comparison so
 * only genuinely changed files are transferred.
 */
async function syncFilesOnConnect() {
  try {
    log("SYNC", "Running initial file sync…");

    // 1. Fetch remote files + content from the game
    const remoteFiles = await getAllFiles("home");
    const remoteHashes = new Map<string, string>();
    for (const f of remoteFiles) {
      remoteHashes.set(f.filename, hashContent(f.content));
    }

    // 2. Walk local dist/ and compare
    const localFiles = walkDist();
    let pushed = 0;
    let skipped = 0;
    let errors = 0;

    for (const localPath of localFiles) {
      const relative = path.relative(dist, localPath).replace(/\\/g, "/");
      const remotePath = `/${relative}`;

      const localInfo = readLocalFile(relative);
      if (!localInfo) {
        errors++;
        continue;
      }

      const remoteHash = remoteHashes.get(remotePath);
      if (remoteHash === localInfo.hash) {
        skipped++;
        continue; // Already in sync
      }

      // Content differs or file is missing remotely — push it
      await pushFile(localPath);
      pushed++;
      await sleep(10);
    }

    // 3. Optionally delete remote files that no longer exist locally
    // (skipped — too aggressive for a general sync; the watcher handles deletes)

    log("SYNC", `Sync complete — ${pushed} pushed, ${skipped} up-to-date${errors > 0 ? `, ${errors} errors` : ""}`);

    // 4. Update typedefs while we're here
    try {
      const defs = (await rpc("getDefinitionFile")) as string;
      fs.writeFileSync("NetscriptDefinitions.d.ts", defs);
      log("SYNC", "NetscriptDefinitions.d.ts updated");
    } catch { /* retry on next connect */ }

    // 5. Clear any pending syncs that accumulated during the sync
    if (pendingSync.size > 0) {
      log("SYNC", `Clearing ${pendingSync.size} stale pending sync entries (covered by comparison sync)`);
      pendingSync.clear();
    }

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log("ERR", `Initial sync failed: ${msg}`);
  }
}

/** Handle an incoming message from the game (JSON-RPC response). */
function handleGameMessage(raw: string) {
  try {
    const msg = JSON.parse(raw);
    if (msg.id === undefined) return;

    // Route to admin client if this was proxied from one
    if (adminPending.has(msg.id)) {
      const { adminSocket, adminId } = adminPending.get(msg.id)!;
      adminPending.delete(msg.id);
      if (adminSocket.readyState === 1) {
        adminSocket.send(JSON.stringify({
          jsonrpc: "2.0",
          id: adminId,
          result: msg.result,
          ...(msg.error ? { error: msg.error } : {}),
        }));
      }
      return;
    }

    // Route to internal pending (bridge REPL / file sync)
    if (pending.has(msg.id)) {
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
        case "sync": {
          await syncFilesOnConnect();
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
  sync                 — run comparison-based file sync
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

  // Sync files and update typedefs after connection settles
  setTimeout(async () => {
    await syncFilesOnConnect();
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

// ── Admin WebSocket server (port 12526) ──
// Accepts external tooling (MCP, scripts) and proxies JSON-RPC to the game.

const adminWss = new WebSocketServer({ port: 12526 });

adminWss.on("connection", (socket: WebSocket) => {
  log("ADMIN", "Admin client connected");
  adminSockets.add(socket);

  socket.on("message", (data) => {
    try {
      const req = JSON.parse(data.toString());
      if (req.method === undefined) return;

      // control.* methods handled locally — game socket not required
      if (typeof req.method === "string" && req.method.startsWith("control.")) {
        const reply = (result?: unknown, error?: string) =>
          socket.send(JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            ...(error !== undefined ? { error } : { result }),
          }));

        switch (req.method) {
          case "control.status":
            reply({ controlConnected: controlSocket?.readyState === 1 });
            break;
          case "control.state":
            reply(latestState[req.params?.channel] ?? null);
            break;
          case "control.cmd":
            if (!controlSocket || controlSocket.readyState !== 1) {
              reply(undefined, "control agent not connected");
            } else {
              const cid = nextControlId++;
              controlPending.set(cid, { adminSocket: socket, adminId: req.id });
              controlSocket.send(JSON.stringify({
                t: "cmd",
                id: cid,
                method: req.params?.method,
                params: req.params?.params,
              }));
            }
            break;
          default:
            reply(undefined, "unknown control method");
        }
        return;
      }

      // Non-control: forward to the RFA game socket
      if (!gameSocket || gameSocket.readyState !== 1) {
        socket.send(JSON.stringify({
          jsonrpc: "2.0",
          id: req.id ?? null,
          error: "Game not connected",
        }));
        return;
      }

      const internalId = nextId++;
      adminPending.set(internalId, { adminSocket: socket, adminId: req.id });
      gameSocket.send(JSON.stringify({
        jsonrpc: "2.0",
        method: req.method,
        params: req.params,
        id: internalId,
      }));
    } catch { /* ignore malformed */ }
  });

  socket.on("close", () => {
    log("ADMIN", "Admin client disconnected");
    adminSockets.delete(socket);
    // Clean up any pending requests from this socket
    for (const [id, entry] of adminPending) {
      if (entry.adminSocket === socket) adminPending.delete(id);
    }
  });

  socket.on("error", (err) => {
    log("ADMIN", `Error: ${err.message}`);
  });
});

adminWss.on("error", (err: NodeJS.ErrnoException) => {
  log("ERR", `Admin server error: ${err.message}`);
  if (err.code === "EADDRINUSE") {
    console.error("Admin port 12526 is already in use.");
  }
});

log("ADMIN", "Admin server listening on port 12526");

// ── Control agent WebSocket server (port 12527) ──
// The in-game control_agent connects here; bridge forwards control.* admin requests over this socket.

const controlWss = new WebSocketServer({ port: 12527 });

controlWss.on("connection", (socket: WebSocket) => {
  log("CONTROL", "Control agent connected");
  controlSocket = socket;

  socket.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.t === "res") {
        const entry = controlPending.get(msg.id);
        if (entry) {
          controlPending.delete(msg.id);
          if (entry.adminSocket.readyState === 1) {
            entry.adminSocket.send(JSON.stringify({
              jsonrpc: "2.0",
              id: entry.adminId,
              ...(msg.ok ? { result: msg.data } : { error: msg.error }),
            }));
          }
        }
      } else if (msg.t === "state") {
        latestState[msg.channel] = { ts: msg.ts, data: msg.data };
      }
    } catch { /* ignore malformed */ }
  });

  socket.on("close", () => {
    log("CONTROL", "Control agent disconnected");
    controlSocket = null;
    // Flush any admin clients still waiting on a control response
    for (const [id, entry] of controlPending) {
      if (entry.adminSocket.readyState === 1) {
        entry.adminSocket.send(JSON.stringify({
          jsonrpc: "2.0",
          id: entry.adminId,
          error: "control agent disconnected",
        }));
      }
      controlPending.delete(id);
    }
  });

  socket.on("error", (err) => {
    log("CONTROL", `Error: ${err.message}`);
  });
});

controlWss.on("error", (err: NodeJS.ErrnoException) => {
  log("ERR", `Control server error: ${err.message}`);
  if (err.code === "EADDRINUSE") {
    console.error("Control port 12527 is already in use.");
  }
});

log("CONTROL", "Control server listening on port 12527");

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
