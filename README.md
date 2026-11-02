# mcp-twake-mail

[![npm version](https://img.shields.io/npm/v/mcp-twake-mail)](https://www.npmjs.com/package/mcp-twake-mail)
[![CI](https://github.com/linagora/mcp-twake-mail/actions/workflows/ci.yml/badge.svg)](https://github.com/linagora/mcp-twake-mail/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)

**Give your AI assistant secure access to Twake Mail, the email service of the [Twake.ai](https://twake.ai) Digital Workplace.**

![Twake Mail](assets/twake-mail-screenshot.png)

## What is it?

`mcp-twake-mail` is a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server. MCP is the open standard that lets AI assistants (Claude Desktop, Claude Code, Hermes Agent, Cursor, VS Code and many others) use external tools. This server exposes your mailbox to the assistant as **30 tools**: read, search, write drafts, reply, organise, handle attachments.

It speaks **JMAP** ([RFC 8620](https://www.rfc-editor.org/rfc/rfc8620) / [RFC 8621](https://www.rfc-editor.org/rfc/rfc8621)), the modern email standard used by Twake Mail and Apache James, so it also works with any JMAP server (Stalwart, Cyrus IMAP, Fastmail…).

## Part of Twake.ai

[Twake.ai](https://twake.ai) is the truly open source and sovereign Digital Workplace developed by [LINAGORA](https://linagora.com): Twake Mail, Twake Calendar, Twake Drive, Twake Chat, Twake Space and Twake Visio with a single account, hosted in France or on your own infrastructure.

Five open source MCP servers connect AI assistants to the whole workplace:

| MCP server | Twake.ai service | Protocol |
|---|---|---|
| **mcp-twake-mail** (this project) | Twake Mail | JMAP |
| [mcp-twake-dav](https://github.com/linagora/mcp-twake-dav) | Twake Calendar and contacts | CalDAV / CardDAV |
| [mcp-twake-drive](https://github.com/linagora/mcp-twake-drive) | Twake Drive | cozy-stack API |
| [mcp-twake-chat](https://github.com/linagora/mcp-twake-chat) | Twake Chat | Matrix |
| [mcp-twake-space](https://github.com/linagora/mcp-twake-space) | Twake Space (team spaces) | Twake Space API |
| [mcp-twake-project](https://github.com/linagora/mcp-twake-project) | Twake Project (projects, boards, tasks) | Twake Project API |

Used together, they let one assistant prepare a meeting from the invitation, the related email thread, the chat discussion and the documents in the drive, without your data leaving your servers.

## What it brings

- **Triage and catch-up**: "What are my unread emails from this morning? Summarise the important ones."
- **Search across years of mail**: "Find the last exchange with the auditors about the 2026 accounts."
- **Writing help, you stay in control**: the assistant writes a reply as a **draft** (HTML + plain text, with your signature, correctly threaded); you review it and send it from Twake Mail.
- **Organisation**: move, label, mark as read, create folders, in batches of up to 50 emails.
- **Attachments**: list and download attachments so the assistant can read a PDF or a spreadsheet.
- **Sovereignty**: the server runs next to your assistant and talks directly to your mail server. Pair it with a self-hosted or European AI model to keep the whole chain under your control.

## Features

### 30 MCP tools

| Category | Tools |
|---|---|
| Read | `get_email`, `get_email_labels`, `search_emails`, `get_thread`, `get_thread_emails` |
| Drafts | `create_draft`, `update_draft` |
| Send ⚠️ | `send_email`, `reply_email`, `forward_email`, `send_draft` |
| Organise | `mark_as_read`, `mark_as_unread`, `move_email`, `add_label`, `remove_label` |
| Batch (up to 50 emails) | `batch_mark_read`, `batch_mark_unread`, `batch_move`, `batch_add_label`, `batch_remove_label`, `batch_delete` ⚠️ |
| Mailboxes | `list_mailboxes`, `get_mailbox`, `create_mailbox`, `rename_mailbox`, `delete_mailbox` ⚠️ |
| Delete ⚠️ | `delete_email` |
| Attachments | `get_attachments`, `download_attachment` |

⚠️ = sends mail on your behalf or deletes data. Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`).

**Every write is approved by you first.** Before a tool sends, drafts, marks, moves, labels, deletes or saves anything, the server itself shows you the exact action through MCP elicitation (see [Prior approval](#prior-approval)) and acts only on your explicit OK. Reading e-mails, threads and attachments needs no approval.

### Highlights

- **Four authentication methods**: Basic, Bearer token, OIDC with PKCE (enterprise SSO, automatic token refresh) and **token command** (short-lived tokens from an external broker).
- **Auto-discovery**: configure with just your email address (DNS SRV, `.well-known/jmap`, OAuth metadata).
- **Rich drafts**: `create_draft` builds a `multipart/alternative` message (plain text + HTML) from `body` (plain text, HTML generated) or `htmlBody` (rich formatting), and threads replies with `inReplyTo` (`In-Reply-To` and `References` headers).
- **Signatures**: a Markdown signature file is converted to HTML and plain text and appended to drafts and sent emails.
- **System folder protection**: Inbox, Sent, Drafts and Trash cannot be renamed or deleted.
- **Large attachments** (> 750 KB) are saved to disk instead of being returned inline.
- HTTPS only; logs on stderr, never on the MCP channel.

## Requirements

- **Node.js** >= 20
- A **JMAP server**: Twake Mail, Apache James, Stalwart, Cyrus IMAP, Fastmail…
- An **MCP client**: Claude Desktop, Claude Code, Hermes Agent, Cursor, VS Code, or any MCP-compatible assistant

## Installation

**Interactive setup (recommended):**

```bash
npx mcp-twake-mail setup
```

The wizard discovers your JMAP server from your email address, asks for the authentication method and credentials, configures the default sender and signature, tests the connection, and can write the Claude Desktop configuration for you.

**Global install:**

```bash
npm install -g mcp-twake-mail
mcp-twake-mail check   # verify the configuration
```

**From source:**

```bash
git clone https://github.com/linagora/mcp-twake-mail.git
cd mcp-twake-mail
npm install
npm run build          # then run: node build/index.js
```

### CLI commands

| Command | Description |
|---|---|
| `mcp-twake-mail` | Start the MCP server (stdio) |
| `mcp-twake-mail setup` | Interactive configuration wizard |
| `mcp-twake-mail auth` | Re-run the OIDC authentication flow |
| `mcp-twake-mail check` | Verify the configuration and test the connection |

## Configuration

The server is configured through environment variables, usually set in your MCP client configuration.

### Authentication

| Method | Variables |
|---|---|
| **Basic** (default) | `JMAP_SESSION_URL`, `JMAP_USERNAME`, `JMAP_PASSWORD` |
| **Bearer** | `JMAP_SESSION_URL`, `JMAP_AUTH_METHOD=bearer`, `JMAP_TOKEN` |
| **OIDC** (PKCE S256) | `JMAP_SESSION_URL`, `JMAP_AUTH_METHOD=oidc`, `JMAP_OIDC_ISSUER`, `JMAP_OIDC_CLIENT_ID`, optional `JMAP_OIDC_SCOPE` (default `openid profile email offline_access`), `JMAP_OIDC_REDIRECT_URI` (loopback with a port, default `http://localhost:3000/callback`) |
| **Token command** | `JMAP_SESSION_URL`, `JMAP_AUTH_METHOD=command`, `JMAP_TOKEN_COMMAND` |

With **token command**, the server runs `JMAP_TOKEN_COMMAND` to get an access token, either raw on stdout or as JSON `{"access_token": "...", "expires_at": <epoch seconds>}`, and runs it again shortly before expiry. A single broker you control can then own the OIDC grant (and its refresh-token rotation) for several tools, and long-lived secrets stay out of the MCP client configuration.

See [docs/oidc-configuration.md](docs/oidc-configuration.md) and [docs/auto-discovery.md](docs/auto-discovery.md).

### Identity, signature and other options

| Variable | Description | Default |
|---|---|---|
| `JMAP_DEFAULT_FROM` | Default sender address | account identity |
| `JMAP_SIGNATURE_PATH` | Markdown signature file (inline HTML allowed) | none |
| `JMAP_REQUEST_TIMEOUT` | Request timeout (ms) | `30000` |
| `LOG_LEVEL` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` | `info` |
| `JMAP_APPROVAL` | `elicit`: the server asks you before every write; `client`: your MCP client confirms | `elicit` |
| `JMAP_APPROVAL_TIMEOUT_MS` | How long an approval prompt waits for your answer | `600000` |
| `JMAP_APPROVAL_EXEMPT` | Comma-separated tools you choose to run without a prompt (e.g. `create_draft` for a scheduled job that prepares drafts) | none |
| `USER_LANGUAGE` | Language of the approval prompts, `en` or `fr` | `en` |
| `USER_TIMEZONE` | IANA time zone of the dates shown in the prompts | system |

Example signature file:

```markdown
**Jane Doe**
Head of Operations, Example Corp
[jane.doe@example.com](mailto:jane.doe@example.com)
```

The signature is read at startup: restart the server after editing it.

### Prior approval

With `JMAP_APPROVAL=elicit` (the default), every write tool sends the MCP client an [elicitation](https://modelcontextprotocol.io/specification/draft/client/elicitation) request before it acts, for instance:

```
Twake Mail: Send a reply
As: jane.doe@example.com (your account)
In reply to: Bob DURAND <bob.durand@example.com> · Budget 2027
From: Jane DOE <jane.doe@example.com>
To: Bob DURAND <bob.durand@example.com>
Cc: chloe.petit@example.com
Subject: Re: Budget 2027
Text:
Approved, thanks Bob.
[signature included]

Ref. 3f9a1c · Accept to do it now, refuse to cancel.
```

- Sending tools show the e-mail as it will leave: sender, the recipients the server computed (reply-all included), subject, text and attachments. `send_draft` reads the draft back first.
- Other tools list the e-mails they touch (sender, date, subject; at most 10 shown) and the folders by name.
- The server acts only on *accept*. A refusal, a dismissal, a timeout or an error sends and changes nothing, and the tool tells the assistant not to retry.
- A client without elicitation support gets an error and nothing is done. Set `JMAP_APPROVAL=client` only if your MCP client asks you to confirm every write tool itself.
- `JMAP_APPROVAL_EXEMPT` lets you lift the prompt for chosen tools only (empty by default).

## Use it with your assistant

### Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Linux: `~/.config/Claude/`, Windows: `%APPDATA%\Claude\`), then restart Claude Desktop:

```json
{
  "mcpServers": {
    "twake-mail": {
      "command": "npx",
      "args": ["-y", "mcp-twake-mail"],
      "env": {
        "JMAP_SESSION_URL": "https://jmap.example.com/jmap/session",
        "JMAP_AUTH_METHOD": "oidc",
        "JMAP_OIDC_ISSUER": "https://sso.example.com",
        "JMAP_OIDC_CLIENT_ID": "my-client-id",
        "JMAP_DEFAULT_FROM": "jane.doe@example.com",
        "JMAP_SIGNATURE_PATH": "~/.mcp-twake-mail/signature.md"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add twake-mail --scope user \
  -e JMAP_SESSION_URL=https://jmap.example.com/jmap/session \
  -e JMAP_AUTH_METHOD=oidc \
  -e JMAP_OIDC_ISSUER=https://sso.example.com \
  -e JMAP_OIDC_CLIENT_ID=my-client-id \
  -- npx -y mcp-twake-mail
```

### Hermes Agent

```yaml
mcp_servers:
  twake_mail:
    command: npx
    args: ["-y", "mcp-twake-mail"]
    env:
      JMAP_SESSION_URL: https://jmap.example.com/jmap/session
      JMAP_AUTH_METHOD: command
      JMAP_TOKEN_COMMAND: /usr/local/bin/my-token-broker token
      JMAP_SIGNATURE_PATH: ~/.mcp-twake-mail/signature.md
      JMAP_APPROVAL_TIMEOUT_MS: "330000"
      USER_LANGUAGE: fr
    timeout: 420            # longer than the approval wait
    elicitation:
      enabled: true
      timeout: 300
```

Hermes shows the approval prompts in the desktop app, the terminal or on your messaging platform, and declines them where nobody can answer (cron jobs, one-shot queries).

### Other MCP clients

Any client that can launch a stdio MCP server works: command `npx`, arguments `-y mcp-twake-mail`, and the environment variables above.

## Recommended safe configuration

Keep `JMAP_APPROVAL=elicit` (the default): every e-mail sent in your name, and every other write, waits for your OK on the exact content. If you prefer that the assistant never sends at all (**drafts only**: you send from Twake Mail), filter out the sending and deleting tools in your MCP client, for example with Hermes Agent:

```yaml
    tools:
      exclude: [send_email, reply_email, forward_email, send_draft,
                delete_email, batch_delete, create_mailbox, rename_mailbox, delete_mailbox]
```

Email content is written by third parties: a message can contain instructions aimed at your assistant (prompt injection). Keep a human in the loop for every write action. See [SECURITY.md](SECURITY.md).

## Usage examples

- "What are my unread emails? Which ones need an answer today?"
- "Show me the whole thread about the budget meeting."
- "Prepare a draft reply to Pierre thanking him and proposing Tuesday at 10."
- "Move all newsletters from last week to the Archive folder."
- "Download the PDF attached to the last email from the accountant."
- "Create a folder called Projects / 2027."

## Architecture

```
MCP client ⇄ stdio (JSON-RPC) ⇄ mcp-twake-mail ⇄ HTTPS (JMAP) ⇄ Twake Mail / any JMAP server
```

Layers: Zod configuration with fail-fast validation, Pino logger on stderr, authentication (Basic, Bearer, OIDC with PKCE and refresh, token command), auto-discovery, JMAP client (session, batching, blob download), signature conversion, AI-friendly transformers, and the MCP tools.

## Development

```bash
npm install
npm run build    # compile TypeScript
npm test         # 700+ tests (Vitest), no real server needed
npm run dev      # watch mode
npm run lint
```

## Contributing

Contributions are welcome: read [CONTRIBUTING.md](CONTRIBUTING.md) and our [Code of Conduct](CODE_OF_CONDUCT.md). Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Release notes are in [CHANGELOG.md](CHANGELOG.md).

## License

Licensed under the **GNU Affero General Public License v3.0** ([AGPL-3.0](LICENSE)).

Copyright © 2026 [LINAGORA](https://linagora.com)

## About

`mcp-twake-mail` is developed by [LINAGORA](https://linagora.com), French open source software publisher, as part of [Twake.ai](https://twake.ai). For support, hosting or integration of Twake.ai and its AI connectors, contact LINAGORA at <https://linagora.com>.
