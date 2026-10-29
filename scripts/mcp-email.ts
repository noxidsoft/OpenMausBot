#!/usr/bin/env node
// MCP server over JSON-RPC 2.0 stdio that reads a Hostinger mailbox over IMAP
// and saves drafts to its Drafts folder. It has no SMTP transport and no send tool.
import readline from "node:readline";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import MailComposer from "nodemailer/lib/mail-composer";
import { z } from "zod";

const MAX_SEARCH = 50;
const MAX_BODY_CHARS = 20_000;

export interface ImapSession {
  list(): Promise<Array<{ path: string; specialUse?: string }>>;
  search(folder: string, query: Record<string, unknown>, limit: number): Promise<Array<{
    uid: number; from: string; subject: string; date: string; flags: string[];
  }>>;
  fetchSource(folder: string, uid: number): Promise<Buffer | null>;
  append(folder: string, raw: Buffer): Promise<void>;
  close(): Promise<void>;
}

export interface EmailConfig { host: string; port: number; user: string; password: string }

export function readConfig(env: NodeJS.ProcessEnv): EmailConfig {
  const user = env.EMAIL_USER?.trim();
  const password = env.EMAIL_PASSWORD;
  if (!user || !password) throw new Error("EMAIL_USER and EMAIL_PASSWORD are required");
  const port = Number(env.EMAIL_IMAP_PORT || 993);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("EMAIL_IMAP_PORT is invalid");
  // Hostinger email hosting runs on Titan, so its IMAP server is imap.titan.email.
  return { host: env.EMAIL_IMAP_HOST?.trim() || "imap.titan.email", port, user, password };
}

export function scrub(message: string, password: string): string {
  return password ? message.split(password).join("***") : message;
}

export function connectImap(config: EmailConfig): ImapSession {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.port === 993,
    auth: { user: config.user, pass: config.password },
    logger: false,
  });
  let ready: Promise<unknown> | undefined;
  const connected = () => (ready ??= client.connect());
  return {
    async list() {
      await connected();
      return (await client.list()).map((box) => ({ path: box.path, specialUse: box.specialUse }));
    },
    async search(folder, query, limit) {
      await connected();
      const lock = await client.getMailboxLock(folder, { readOnly: true });
      try {
        const found = (await client.search(query as never, { uid: true })) || [];
        const uids = found.slice(-limit).reverse();
        const rows: Array<{ uid: number; from: string; subject: string; date: string; flags: string[] }> = [];
        if (uids.length === 0) return rows;
        for await (const msg of client.fetch(uids, { uid: true, envelope: true, flags: true }, { uid: true })) {
          const from = msg.envelope?.from?.[0];
          rows.push({
            uid: msg.uid,
            from: from ? `${from.name ? `${from.name} ` : ""}<${from.address ?? ""}>` : "",
            subject: msg.envelope?.subject ?? "",
            date: msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : "",
            flags: [...(msg.flags ?? [])],
          });
        }
        return rows.sort((a, b) => b.uid - a.uid);
      } finally {
        lock.release();
      }
    },
    async fetchSource(folder, uid) {
      await connected();
      const lock = await client.getMailboxLock(folder, { readOnly: true });
      try {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        return msg && msg.source ? msg.source : null;
      } finally {
        lock.release();
      }
    },
    async append(folder, raw) {
      await connected();
      await client.append(folder, raw, ["\\Draft"]);
    },
    async close() {
      if (ready) await client.logout().catch(() => undefined);
    },
  };
}

const address = z.string().email();
const addresses = z.array(address).max(50);

const schemas = {
  list_folders: z.object({}).strict(),
  search_messages: z.object({
    folder: z.string().min(1).default("INBOX"),
    from: z.string().optional(),
    subject: z.string().optional(),
    text: z.string().optional(),
    since: z.string().date().optional(),
    unseen: z.boolean().optional(),
    limit: z.number().int().min(1).max(MAX_SEARCH).default(20),
  }).strict(),
  read_message: z.object({
    folder: z.string().min(1).default("INBOX"),
    uid: z.number().int().positive(),
  }).strict(),
  create_draft: z.object({
    to: addresses.min(1),
    cc: addresses.optional(),
    bcc: addresses.optional(),
    subject: z.string().max(998),
    text: z.string().max(200_000),
    inReplyTo: z.object({ folder: z.string().min(1).default("INBOX"), uid: z.number().int().positive() }).optional(),
  }).strict(),
} as const;

export const TOOLS = [
  { name: "list_folders", description: "List mailbox folders with their special-use flags.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  {
    name: "search_messages",
    description: `Search a folder, newest first. Returns uid, sender, subject, date and flags. Max ${MAX_SEARCH} results.`,
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Defaults to INBOX." },
        from: { type: "string" }, subject: { type: "string" }, text: { type: "string" },
        since: { type: "string", description: "YYYY-MM-DD" },
        unseen: { type: "boolean" },
        limit: { type: "integer", minimum: 1, maximum: MAX_SEARCH },
      },
      additionalProperties: false,
    },
  },
  {
    name: "read_message",
    description: "Read one message by uid without marking it read: headers, plain-text body and attachment names.",
    inputSchema: {
      type: "object",
      properties: { folder: { type: "string" }, uid: { type: "integer", minimum: 1 } },
      required: ["uid"],
      additionalProperties: false,
    },
  },
  {
    name: "create_draft",
    description: "Save a draft to the Drafts folder for the owner to review and send from their mail client. Nothing is sent.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "array", items: { type: "string" }, minItems: 1 },
        cc: { type: "array", items: { type: "string" } },
        bcc: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
        text: { type: "string" },
        inReplyTo: {
          type: "object",
          properties: { folder: { type: "string" }, uid: { type: "integer", minimum: 1 } },
          required: ["uid"],
          additionalProperties: false,
        },
      },
      required: ["to", "subject", "text"],
      additionalProperties: false,
    },
  },
] as const;

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function draftsFolder(session: ImapSession): Promise<string> {
  const folders = await session.list();
  const found = folders.find((f) => f.specialUse === "\\Drafts") ?? folders.find((f) => f.path.toLowerCase() === "drafts");
  if (!found) throw new Error("No Drafts folder exists on this mailbox");
  return found.path;
}

export async function callTool(session: ImapSession, name: string, rawArgs: unknown): Promise<unknown> {
  if (!(name in schemas)) throw new Error(`Unknown tool: ${name}`);
  const args = schemas[name as keyof typeof schemas].parse(rawArgs ?? {}) as Record<string, any>;
  switch (name) {
    case "list_folders":
      return { folders: await session.list() };
    case "search_messages": {
      const query: Record<string, unknown> = {};
      if (args.from) query.from = args.from;
      if (args.subject) query.subject = args.subject;
      if (args.text) query.body = args.text;
      if (args.since) query.since = new Date(args.since);
      if (args.unseen) query.seen = false;
      return { messages: await session.search(args.folder, query, args.limit) };
    }
    case "read_message": {
      const source = await session.fetchSource(args.folder, args.uid);
      if (!source) throw new Error(`No message with uid ${args.uid} in ${args.folder}`);
      const parsed = await simpleParser(source);
      const body = parsed.text ?? (typeof parsed.html === "string" ? htmlToText(parsed.html) : "");
      return {
        uid: args.uid,
        messageId: parsed.messageId ?? null,
        from: parsed.from?.text ?? "",
        to: parsed.to ? [parsed.to].flat().map((a) => a.text).join(", ") : "",
        cc: parsed.cc ? [parsed.cc].flat().map((a) => a.text).join(", ") : "",
        subject: parsed.subject ?? "",
        date: parsed.date?.toISOString() ?? "",
        body: body.slice(0, MAX_BODY_CHARS),
        truncated: body.length > MAX_BODY_CHARS,
        attachments: parsed.attachments.map((a) => ({ filename: a.filename ?? "", contentType: a.contentType, size: a.size })),
      };
    }
    case "create_draft": {
      let headers: Record<string, string> = {};
      if (args.inReplyTo) {
        const source = await session.fetchSource(args.inReplyTo.folder, args.inReplyTo.uid);
        const original = source ? await simpleParser(source) : null;
        if (original?.messageId) {
          const refs = [original.references ?? []].flat();
          headers = { "In-Reply-To": original.messageId, References: [...refs, original.messageId].join(" ") };
        }
      }
      const raw = await new MailComposer({
        to: args.to, cc: args.cc, bcc: args.bcc, subject: args.subject, text: args.text, headers,
      }).compile().build();
      const folder = await draftsFolder(session);
      await session.append(folder, raw);
      return { saved: true, folder, sent: false };
    }
  }
  throw new Error(`Unknown tool: ${name}`);
}

function respond(id: unknown, result?: unknown, error?: { code: number; message: string }): string {
  return JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) });
}

export async function handleMessage(
  line: string,
  getSession: () => ImapSession,
  password = "",
): Promise<string | null> {
  let message: any;
  try {
    message = JSON.parse(line);
  } catch {
    return respond(null, undefined, { code: -32700, message: "Parse error" });
  }
  const isNotification = message?.id === undefined;
  const id = message?.id ?? null;
  switch (message?.method) {
    case "initialize":
      return respond(id, {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "openmausbot-email", version: "1.0.0" },
        instructions: "Reads mail and saves drafts only. Drafts are reviewed and sent by the owner in their mail client.",
      });
    case "ping":
      return isNotification ? null : respond(id, {});
    case "tools/list":
      return respond(id, { tools: TOOLS });
    case "tools/call":
      try {
        const result = await callTool(getSession(), message.params?.name, message.params?.arguments);
        return respond(id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        });
      } catch (error) {
        const text = error instanceof z.ZodError
          ? `Invalid arguments: ${error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
          : error instanceof Error ? error.message : String(error);
        return respond(id, { content: [{ type: "text", text: `Error: ${scrub(text, password)}` }], isError: true });
      }
    default:
      if (isNotification) return null;
      return respond(id, undefined, { code: -32601, message: `Method not found: ${message?.method}` });
  }
}

export function runStdio(): Promise<void> {
  let session: ImapSession | undefined;
  let password = "";
  const getSession = () => {
    if (!session) {
      const config = readConfig(process.env);
      password = config.password;
      session = connectImap(config);
    }
    return session;
  };
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const inFlight = new Set<Promise<void>>();
  rl.on("line", (line) => {
    const task = handleMessage(line, getSession, process.env.EMAIL_PASSWORD ?? password).then((out) => {
      if (out) process.stdout.write(out + "\n");
    });
    inFlight.add(task);
    void task.finally(() => inFlight.delete(task));
  });
  return new Promise((closed) => rl.on("close", async () => {
    await Promise.allSettled([...inFlight]);
    await session?.close();
    closed();
  }));
}

if (process.argv[1]?.endsWith("mcp-email.ts") || process.argv[1]?.endsWith("mcp-email.js")) void runStdio();
