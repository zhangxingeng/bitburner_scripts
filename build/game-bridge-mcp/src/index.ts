#!/usr/bin/env node
/**
 * Bitburner Game Bridge MCP Server
 *
 * Connects to the bridge admin port (ws://localhost:12526), proxies JSON-RPC
 * requests to the game, and exposes game state as MCP tools for Claude.
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

// Tool: get_status
server.registerTool(
  "get_status",
  {
    title: "Game Bridge Status",
    description: `Check whether the game is connected to the bridge and the admin connection status.`,
    inputSchema: z.object({}).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async () => {
    const connected = ws?.readyState === WebSocket.OPEN;
    let gameConnected = false;
    if (connected) {
      try {
        // Quick ping: try to list home server files
        await rpc("getFileNames", { server: "home" });
        gameConnected = true;
      } catch {
        gameConnected = false;
      }
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            bridgeAdmin: connected ? "connected" : "disconnected",
            game: gameConnected ? "connected" : "disconnected",
          }),
        },
      ],
      structuredContent: { bridgeAdmin: connected, game: gameConnected },
    };
  }
);

// ── Main ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp] Bitburner MCP server running via stdio");
}

main().catch((err) => {
  console.error("[mcp] Fatal:", err);
  process.exit(1);
});
