# Email (Hostinger) MCP

A bundled stdio MCP server that lets a bot read a Hostinger mailbox over IMAP and save drafts. It has no SMTP transport and no send tool: drafts land in the Drafts folder and you send them from your mail client.

## Add it

Plugins, MCP servers, Add:

- Command: `node`
- Args: `--experimental-strip-types scripts/mcp-email.ts` (run from the OpenMausBot checkout, or use the absolute path)
- Env (values are write-only):
  - `EMAIL_USER`: the full mailbox address
  - `EMAIL_PASSWORD`: the mailbox password
  - `EMAIL_IMAP_HOST`: optional, defaults to `imap.titan.email` (Hostinger email hosting runs on Titan)
  - `EMAIL_IMAP_PORT`: optional, defaults to `993` (implicit TLS)

## Tools

| Tool | Does |
| --- | --- |
| `list_folders` | Folders and special-use flags |
| `search_messages` | Newest first by sender, subject, text, date or unread; up to 50 |
| `read_message` | Headers, plain-text body (truncated at 20,000 characters) and attachment names; does not mark the message read |
| `create_draft` | Appends a draft to the `\Drafts` folder, optionally threaded to an existing message |

## Thunderbird

Add the mailbox to Thunderbird as an IMAP account. Drafts the bot saves appear in that account's Drafts folder after a sync.
