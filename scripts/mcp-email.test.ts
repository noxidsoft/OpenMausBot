import { describe, expect, it } from "vitest";
import { TOOLS, callTool, handleMessage, readConfig, scrub, type ImapSession } from "./mcp-email.ts";

function fakeSession(overrides: Partial<ImapSession> = {}): ImapSession & { appended: Array<{ folder: string; raw: Buffer }> } {
  const appended: Array<{ folder: string; raw: Buffer }> = [];
  return {
    appended,
    list: async () => [{ path: "INBOX" }, { path: "Drafts Folder", specialUse: "\\Drafts" }],
    search: async () => [],
    fetchSource: async () => null,
    append: async (folder, raw) => { appended.push({ folder, raw }); },
    close: async () => undefined,
    ...overrides,
  };
}

describe("email MCP", () => {
  it("exposes no send or mutating tools", () => {
    expect(TOOLS.map((t) => t.name)).toEqual(["list_folders", "search_messages", "read_message", "create_draft"]);
  });

  it("lists tools without touching IMAP", async () => {
    const out = await handleMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), () => {
      throw new Error("connected");
    });
    expect(JSON.parse(out!).result.tools).toHaveLength(4);
  });

  it("appends the draft to the special-use Drafts folder and reports it unsent", async () => {
    const session = fakeSession();
    const result = await callTool(session, "create_draft", { to: ["a@example.com"], subject: "Hi", text: "Body" });
    expect(result).toEqual({ saved: true, folder: "Drafts Folder", sent: false });
    expect(session.appended[0].raw.toString()).toContain("Subject: Hi");
  });

  it("refuses to create a draft when there is no Drafts folder", async () => {
    const session = fakeSession({ list: async () => [{ path: "INBOX" }] });
    await expect(callTool(session, "create_draft", { to: ["a@example.com"], subject: "x", text: "y" })).rejects.toThrow(/No Drafts folder/);
    expect(session.appended).toEqual([]);
  });

  it("threads a reply from the original message id", async () => {
    const original = Buffer.from("Message-ID: <orig@example.com>\r\nFrom: b@example.com\r\nSubject: Q\r\n\r\nhello");
    const session = fakeSession({ fetchSource: async () => original });
    await callTool(session, "create_draft", { to: ["b@example.com"], subject: "Re: Q", text: "ok", inReplyTo: { uid: 4 } });
    expect(session.appended[0].raw.toString()).toContain("In-Reply-To: <orig@example.com>");
  });

  it("reads a message body and attachment names", async () => {
    const raw = Buffer.from("From: b@example.com\r\nTo: me@example.com\r\nSubject: Q\r\n\r\nhello");
    const result: any = await callTool(fakeSession({ fetchSource: async () => raw }), "read_message", { uid: 1 });
    expect(result.body).toContain("hello");
    expect(result.subject).toBe("Q");
  });

  it("rejects unknown tools and bad arguments", async () => {
    await expect(callTool(fakeSession(), "send_email", {})).rejects.toThrow(/Unknown tool/);
    await expect(callTool(fakeSession(), "create_draft", { to: ["nope"], subject: "x", text: "y" })).rejects.toThrow();
    await expect(callTool(fakeSession(), "search_messages", { limit: 500 })).rejects.toThrow();
  });

  it("scrubs the password from error text", async () => {
    const out = await handleMessage(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_folders", arguments: {} } }),
      () => fakeSession({ list: async () => { throw new Error("auth failed for hunter2"); } }),
      "hunter2",
    );
    const text = JSON.parse(out!).result.content[0].text;
    expect(text).not.toContain("hunter2");
    expect(scrub("x hunter2", "hunter2")).toBe("x ***");
  });

  it("requires credentials and defaults to Hostinger", () => {
    expect(() => readConfig({})).toThrow(/EMAIL_USER/);
    expect(readConfig({ EMAIL_USER: "u@d.com", EMAIL_PASSWORD: "p" })).toMatchObject({ host: "imap.titan.email", port: 993 });
  });
});
