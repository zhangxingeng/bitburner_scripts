#!/usr/bin/env node
/**
 * Bitburner Game Bridge MCP Server
 *
 * Connects to the bridge admin port (ws://localhost:12526), proxies JSON-RPC
 * requests to the game, and exposes game state as MCP tools for Claude.
 *
 * Control tools (terminal, get_screen, get_notifications, write_port, read_port)
 * prefer the real-time control channel (admin control.* methods, ~1–5 ms) and
 * fall back to the legacy file-relay path when the control agent is not connected.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocket } from "ws";
import { z } from "zod";

// ── Constants ──

const BRIDGE_ADMIN_URL = "ws://localhost:12526";
const RPC_TIMEOUT_MS = 15000;

// ── WebSocket RPC client ──

let ws: WebSocket | null = null;
const pending = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
>();
let nextId = 1;

function connect(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws?.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }

    ws = new WebSocket(BRIDGE_ADMIN_URL);

    ws.on("open", () => {
      console.error(`[mcp] Connected to bridge admin port`);
      resolve();
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id !== undefined && pending.has(msg.id)) {
          const { resolve, reject, timer } = pending.get(msg.id)!;
          clearTimeout(timer);
          pending.delete(msg.id);
          if (msg.error) reject(new Error(typeof msg.error === "string" ? msg.error : JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      } catch { /* ignore */ }
    });

    ws.on("error", (err) => {
      console.error(`[mcp] WebSocket error: ${err.message}`);
      reject(err);
    });

    ws.on("close", () => {
      console.error(`[mcp] Disconnected from bridge`);
      ws = null;
    });

    // Timeout connection attempt
    setTimeout(() => {
      if (ws?.readyState !== WebSocket.OPEN) {
        reject(new Error("Connection timeout"));
      }
    }, 5000);
  });
}

function rpc(method: string, params?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error("Not connected to game bridge. Is the bridge running?"));
      return;
    }
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`RPC timeout: ${method}`));
    }, RPC_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ jsonrpc: "2.0", method, params, id }));
  });
}

// Lazy connect on first use
let connectPromise: Promise<void> | null = null;
function ensureConnected(): Promise<void> {
  if (ws?.readyState === WebSocket.OPEN) return Promise.resolve();
  if (!connectPromise) {
    connectPromise = connect().then(() => {
      connectPromise = null;
    }).catch((err) => {
      connectPromise = null;
      throw err;
    });
  }
  return connectPromise;
}

// ── Control channel helpers ──

/** Thrown by controlCmd when the control agent is not connected or disconnected mid-call. */
class ControlUnavailable extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ControlUnavailable";
  }
}

const CONTROL_UNAVAILABLE_MSGS = new Set([
  "control agent not connected",
  "control agent disconnected",
]);

/**
 * Forward a command to the in-game control agent via the bridge control.cmd admin method.
 * Throws ControlUnavailable if the control agent is not connected; re-throws other errors.
 */
async function controlCmd(method: string, params?: unknown): Promise<unknown> {
  try {
    return await rpc("control.cmd", { method, params });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (CONTROL_UNAVAILABLE_MSGS.has(msg)) throw new ControlUnavailable(msg);
    throw err;
  }
}

/** Read a buffered state channel from the bridge (no game round-trip). */
function controlState(channel: string): Promise<unknown> {
  return rpc("control.state", { channel });
}

/** Query whether the control agent is currently connected to the bridge. */
function controlStatus(): Promise<unknown> {
  return rpc("control.status");
}

/**
 * Slow-path file relay: push a command to status/.cmd.json and poll status/.result.json.
 * Used as fallback for write_port, read_port, and terminal when the control agent is down.
 * Latency: ~400–600 ms across four async hops.
 */
async function fileRelay(cmd: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  await rpc("pushFile", { server: "home", filename: "status/.cmd.json", content: JSON.stringify(cmd) });
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const raw = (await rpc("getFile", { server: "home", filename: "status/.result.json" })) as string;
      if (raw && typeof raw === "string") {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed.id === cmd.id) return parsed;
      }
    } catch { /* keep polling */ }
  }
  return null;
}

// ── MCP Server ──

const server = new McpServer({
  name: "bitburner-mcp-server",
  version: "1.0.0",
});

// Tool: list_servers
server.registerTool(
  "list_servers",
  {
    title: "List Game Servers",
    description: `List all servers in the Bitburner game world with their admin/root status.

Returns an array of servers with hostname, whether you have admin rights, and whether you purchased it.

Use this to:
- See which servers you've rooted (hasAdminRights: true)
- Identify potential hacking targets (hasAdminRights: false)
- Check purchased server status`,
    inputSchema: z.object({}).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async () => {
    await ensureConnected();
    const servers = (await rpc("getAllServers")) as Array<{
      hostname: string;
      hasAdminRights: boolean;
      purchasedByPlayer: boolean;
    }>;
    const output = {
      total: servers.length,
      rooted: servers.filter((s) => s.hasAdminRights).length,
      servers: servers.map((s) => ({
        hostname: s.hostname,
        admin: s.hasAdminRights,
        purchased: s.purchasedByPlayer,
      })),
    };
    return {
      content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      structuredContent: output,
    };
  }
);

// Tool: list_files
const ListFilesSchema = z.object({
  server: z.string().default("home").describe("Server hostname (default: home)"),
}).strict();

server.registerTool(
  "list_files",
  {
    title: "List Files on Server",
    description: `List all script files on a given game server.

Args:
  - server (string): Server hostname. Default: "home"

Returns the list of filenames on that server.`,
    inputSchema: ListFilesSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ server: host }) => {
    await ensureConnected();
    const files = (await rpc("getFileNames", { server: host })) as string[];
    return {
      content: [{ type: "text", text: files.length ? files.join("\n") : "(empty)" }],
      structuredContent: { server: host, count: files.length, files },
    };
  }
);

// Tool: read_file
const ReadFileSchema = z.object({
  filename: z.string().min(1).describe("Filename to read (e.g., 'engine/hack.js')"),
  server: z.string().default("home").describe("Server hostname (default: home)"),
  offset: z.number().int().min(0).default(0).describe("Line number to start reading from (0-based, default: 0)"),
  limit: z.number().int().min(1).default(100).describe("Maximum number of lines to return (default: 100)"),
}).strict();

server.registerTool(
  "read_file",
  {
    title: "Read File from Game",
    description: `Read the contents of a script file from a game server.

Args:
  - filename (string): The file to read, e.g. "engine/hack.js"
  - server (string): Server hostname. Default: "home"
  - offset (number): Line to start reading from, 0-based. Default: 0
  - limit (number): Max lines to return. Default: 100

Returns lines with line numbers (format: "N\\t<content>").
sourceMappingURL lines are stripped automatically.
If the file is truncated, a trailing note shows total line count.`,
    inputSchema: ReadFileSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ filename, server: host, offset, limit }) => {
    await ensureConnected();
    const raw = (await rpc("getFile", { filename, server: host })) as string;

    const allLines = raw
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//# sourceMappingURL="));

    const totalLines = allLines.length;
    const slice = allLines.slice(offset, offset + limit);
    const numbered = slice
      .map((l, i) => `${offset + i + 1}\t${l}`)
      .join("\n");

    const truncated = offset + limit < totalLines;
    const text = truncated
      ? `${numbered}\n[truncated — showing lines ${offset + 1}–${offset + slice.length} of ${totalLines}; use offset/limit to read more]`
      : numbered;

    return {
      content: [{ type: "text", text }],
      structuredContent: { filename, server: host, totalLines, offset, limit, truncated, text },
    };
  }
);

// Tool: calculate_ram
const RamSchema = z.object({
  filename: z.string().min(1).describe("Script filename to check RAM for"),
  server: z.string().default("home").describe("Server hostname (default: home)"),
}).strict();

server.registerTool(
  "calculate_ram",
  {
    title: "Calculate Script RAM",
    description: `Calculate how much RAM a script uses on a given server.

Args:
  - filename (string): Script to analyze
  - server (string): Server hostname. Default: "home"

Returns the RAM usage in GB.`,
    inputSchema: RamSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ filename, server: host }) => {
    await ensureConnected();
    const ram = (await rpc("calculateRam", { filename, server: host })) as number;
    return {
      content: [{ type: "text", text: `${ram} GB` }],
      structuredContent: { filename, server: host, ramGB: ram },
    };
  }
);

// Tool: get_save
const SaveSchema = z.object({
  outputPath: z.string().default("save.json").describe("Local path to write save file"),
}).strict();

server.registerTool(
  "get_save",
  {
    title: "Download Game Save",
    description: `Download the current game save file for analysis.

Args:
  - outputPath (string): Where to write the save locally. Default: "save.json"

Writes the save to disk and returns metadata about it.`,
    inputSchema: SaveSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ outputPath }) => {
    await ensureConnected();
    const result = (await rpc("getSaveFile")) as { save: string; binary: boolean };
    const fs = await import("node:fs");
    fs.writeFileSync(outputPath, result.save);
    return {
      content: [
        {
          type: "text",
          text: `Save written to ${outputPath} (${result.save.length} bytes, binary: ${result.binary})`,
        },
      ],
      structuredContent: {
        path: outputPath,
        size: result.save.length,
        binary: result.binary,
      },
    };
  }
);

// Tool: push_file
const PushFileSchema = z.object({
  filename: z.string().min(1).describe("Filename on the game server (e.g., '/engine/hack.js')"),
  content: z.string().describe("File contents to push"),
  server: z.string().default("home").describe("Target server (default: home)"),
}).strict();

server.registerTool(
  "push_file",
  {
    title: "Push File to Game",
    description: `Push a single script file to a game server.

Args:
  - filename (string): Target filename on the game server, e.g. "/engine/hack.js"
  - content (string): Full file contents
  - server (string): Target server. Default: "home"`,
    inputSchema: PushFileSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ filename, content, server: host }) => {
    await ensureConnected();
    await rpc("pushFile", { filename, content, server: host });
    return {
      content: [{ type: "text", text: `Pushed ${filename} → ${host}` }],
      structuredContent: { filename, server: host, pushed: true },
    };
  }
);

// Tool: delete_file
const DeleteFileSchema = z.object({
  filename: z.string().min(1).describe("Filename to delete (e.g., '/old/script.js')"),
  server: z.string().default("home").describe("Server hostname (default: home)"),
}).strict();

server.registerTool(
  "delete_file",
  {
    title: "Delete File from Game",
    description: `Delete a file from a game server.

Args:
  - filename (string): File to delete
  - server (string): Server hostname. Default: "home"`,
    inputSchema: DeleteFileSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ filename, server: host }) => {
    await ensureConnected();
    await rpc("deleteFile", { filename, server: host });
    return {
      content: [{ type: "text", text: `Deleted ${filename} from ${host}` }],
      structuredContent: { filename, server: host, deleted: true },
    };
  }
);

// Tool: terminal
const TerminalSchema = z.object({
  command: z.string().min(1).describe("Terminal command to inject (e.g., 'ls', 'run /cross/game_agent.js')"),
}).strict();

server.registerTool(
  "terminal",
  {
    title: "Inject Terminal Command",
    description: `Inject a command into the Bitburner in-game terminal.

Args:
  - command (string): The terminal command to run

Fast path: ~1–5 ms when the control agent is connected (ws://localhost:12527).
Slow fallback: ~400–600 ms file-relay path when the control agent is down.

Returns { injected: true } on the fast path. Notes when the slow fallback was used.
This replaces the legacy write_port(12, cmd) injection idiom.`,
    inputSchema: TerminalSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ command }) => {
    await ensureConnected();
    try {
      const result = (await controlCmd("terminal", { command })) as { injected: boolean };
      return {
        content: [{ type: "text", text: JSON.stringify({ injected: result.injected }) }],
        structuredContent: { injected: result.injected, path: "control" },
      };
    } catch (err) {
      if (!(err instanceof ControlUnavailable)) throw err;
      // Fallback: write command to port 12 via file relay; the PORT_LAUNCHER drains it and injects
      const cmd = { id: `terminal_${Date.now()}`, method: "writePort", port: 12, data: command };
      const result = await fileRelay(cmd);
      if (!result) {
        return { content: [{ type: "text", text: "[fallback] Timeout waiting for game_agent response" }] };
      }
      return {
        content: [
          {
            type: "text",
            text: `[fallback: slow file-relay path used — control agent not connected] ${JSON.stringify(result)}`,
          },
        ],
        structuredContent: { ...result, path: "file-relay" },
      };
    }
  }
);

// Tool: get_status
server.registerTool(
  "get_status",
  {
    title: "Game Bridge Status",
    description: `Check whether the game is connected to the bridge, and report control agent status.`,
    inputSchema: z.object({}).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async () => {
    // Try to connect if not already connected
    let connected = ws?.readyState === WebSocket.OPEN;
    if (!connected) {
      try {
        await ensureConnected();
        connected = true;
      } catch {
        connected = false;
      }
    }
    let gameConnected = false;
    let controlConnected = false;
    if (connected) {
      try {
        await rpc("getFileNames", { server: "home" });
        gameConnected = true;
      } catch {
        gameConnected = false;
      }
      try {
        const statusResult = (await controlStatus()) as { controlConnected: boolean };
        controlConnected = statusResult.controlConnected ?? false;
      } catch {
        controlConnected = false;
      }
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            bridgeAdmin: connected ? "connected" : "disconnected",
            game: gameConnected ? "connected" : "disconnected",
            controlAgent: controlConnected ? "connected" : "disconnected",
          }),
        },
      ],
      structuredContent: { bridgeAdmin: connected, game: gameConnected, controlConnected },
    };
  }
);

// Tool: get_monitoring
server.registerTool(
  "get_monitoring",
  {
    title: "Get Game Monitoring Snapshot",
    description: `Read all monitoring data (player, RAM, processes, decisions, heartbeat) in one call.

Returns a unified snapshot of the game state including:
- Player stats (hacking, money, income, skills)
- RAM usage across all servers (totals + per-server)
- Running processes (all scripts on all rooted servers)
- Strategy decisions log (history of phase transitions and actions)
- Heartbeat status (whether strategy agent is alive)

This is the primary monitoring tool — use it to observe game state during testing.`,
    inputSchema: z.object({}).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async () => {
    await ensureConnected();

    const result: Record<string, unknown> = {};

    // Helper to safely read and parse a JSON file from home
    const readStatusFile = async (path: string) => {
      try {
        const data = (await rpc("getFile", { server: "home", filename: path })) as string;
        if (data && typeof data === "string" && data.trim()) {
          return JSON.parse(data);
        }
      } catch { /* file missing is OK */ }
      return null;
    };

    // Read all status files in parallel
    const [player, ram, processes, decisions, heartbeat] = await Promise.all([
      readStatusFile("status/player.txt"),
      readStatusFile("status/ram.txt"),
      readStatusFile("status/processes.txt"),
      readStatusFile("status/decisions.json"),
      readStatusFile("status/heartbeat.txt"),
    ]);

    result.player = player;
    result.ram = ram;
    result.processes = processes;
    result.decisions = decisions;
    result.heartbeat = heartbeat;
    result.snapshot_ts = Date.now();

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  }
);

// Tool: read_port
const ReadPortSchema = z.object({
  port: z.number().int().min(1).max(20).describe("Port number to read from (1-20)"),
  peek: z.boolean().optional().default(false).describe("If true, peek (don't consume). Default: false (consuming read)"),
}).strict();

server.registerTool(
  "read_port",
  {
    title: "Read Bitburner Game Port",
    description: `Read data from a game port.

Ports are used for in-game IPC:
- Port 1: Boot agent commands
- Port 2: Boot agent results
- Port 3: Strategy agent heartbeat
- Port 4: Strategy agent decision log

Fast path via control agent: ~1–5 ms.
Slow fallback via file relay: ~400–600 ms when the control agent is down.`,
    inputSchema: ReadPortSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ port, peek }) => {
    await ensureConnected();
    try {
      const value = await controlCmd(peek ? "peekPort" : "readPort", { port });
      return {
        content: [{ type: "text", text: JSON.stringify(value) }],
        structuredContent: { port, peek, value },
      };
    } catch (err) {
      if (!(err instanceof ControlUnavailable)) throw err;
      // Fallback: file relay
      const cmd = { id: `readPort_${Date.now()}`, method: peek ? "peekPort" : "readPort", port };
      const result = await fileRelay(cmd);
      if (!result) return { content: [{ type: "text", text: "Timeout waiting for game_agent response" }] };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    }
  }
);

// Tool: write_port
const WritePortSchema = z.object({
  port: z.number().int().min(1).max(20).describe("Port number to write to (1-20)"),
  data: z.string().describe("Data to write to the port (string or JSON string)"),
}).strict();

server.registerTool(
  "write_port",
  {
    title: "Write to Bitburner Game Port",
    description: `Write data to a game port.

Use this to send commands to the boot agent on port 1, or write data to any port for in-game scripts to consume.

Fast path via control agent: ~1–5 ms. Returns { success: true, evicted } where evicted is the
value displaced from a full port, or null on a clean write.
Slow fallback via file relay: ~400–600 ms when the control agent is down.`,
    inputSchema: WritePortSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ port, data }) => {
    await ensureConnected();
    try {
      const res = (await controlCmd("writePort", { port, data })) as { evicted: unknown };
      const out = { success: true, evicted: res.evicted ?? null };
      return {
        content: [{ type: "text", text: JSON.stringify(out) }],
        structuredContent: out,
      };
    } catch (err) {
      if (!(err instanceof ControlUnavailable)) throw err;
      // Fallback: file relay (corrected semantics: write always succeeds; data = evicted or null)
      const cmd = { id: `writePort_${Date.now()}`, method: "writePort", port, data };
      const result = await fileRelay(cmd);
      if (!result) return { content: [{ type: "text", text: "Timeout waiting for game_agent response" }] };
      // Normalize to corrected semantics: success is always true; data holds the evicted value (or null)
      const out = { success: true, evicted: result.data ?? null };
      return {
        content: [{ type: "text", text: JSON.stringify(out) }],
        structuredContent: out,
      };
    }
  }
);

// Tool: get_screen
server.registerTool(
  "get_screen",
  {
    title: "Get Game Screen",
    description: `Read the current rendered terminal screen from the game.

Returns { ts, text } where ts is the Unix timestamp of the last screen capture and text is the
rendered terminal content pushed by the control agent (~every 1 s).

Returns a note when no screen state has been received yet (control agent not yet connected or
hasn't pushed a screen frame). For an RFA fallback, use read_file on status/screen.txt.`,
    inputSchema: z.object({}).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async () => {
    await ensureConnected();
    const state = (await controlState("screen")) as { ts: number; data: string } | null;
    if (!state) {
      return {
        content: [{ type: "text", text: "No screen state yet — control agent has not pushed a screen capture." }],
        structuredContent: { ts: null, text: null },
      };
    }
    return {
      content: [{ type: "text", text: state.data }],
      structuredContent: { ts: state.ts, text: state.data },
    };
  }
);

// Tool: get_notifications
server.registerTool(
  "get_notifications",
  {
    title: "Get Game Notifications",
    description: `Read the latest buffered notifications from the game.

Returns the array of notifications from the most recent state push by the control agent.
Returns an empty array if no notifications have been received yet.`,
    inputSchema: z.object({}).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async () => {
    await ensureConnected();
    const state = (await controlState("notifications")) as { ts: number; data: unknown[] } | null;
    const notifications = state?.data ?? [];
    return {
      content: [{ type: "text", text: JSON.stringify(notifications, null, 2) }],
      structuredContent: { ts: state?.ts ?? null, notifications },
    };
  }
);

// ── Main ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp] Bitburner MCP server running via stdio");

  // Eagerly connect to the bridge so tools work immediately
  try {
    await connect();
    console.error("[mcp] Bridge connection established on startup");
  } catch (err) {
    console.error("[mcp] Bridge not available at startup — will retry on first tool use");
  }
}

main().catch((err) => {
  console.error("[mcp] Fatal:", err);
  process.exit(1);
});
