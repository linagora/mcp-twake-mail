# Changelog

All notable changes to mcp-twake-mail are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [4.2.0] - 2026-11-11

### Added
- `download_attachment` takes `save: true` to keep any attachment on disk, whatever its size, and return its path instead of its content: an agent can then upload it to Twake Drive without passing it through the model. Saving still asks for the prior approval, which now names the folder.
- `JMAP_DOWNLOAD_DIR` sets the folder where attachments are saved (`~` is the home folder); `~/Downloads` by default.

## [4.1.1] - 2026-11-11

### Fixed
- `JMAP_TOKEN_COMMAND` runs through the system shell: `cmd.exe` on Windows, where `/bin/sh` does not exist and the server got no token, and `/bin/sh` on macOS and Linux as before.

## [4.1.0] - 2026-11-02

### Changed
- `download_attachment` no longer takes `saveToPath`: large files always go to `~/Downloads`, under the last segment of their name, in mode 600, and an existing file is kept. The tool is annotated as writing, and saving a file asks for the prior approval (`JMAP_APPROVAL`); small files returned inline do not.

## [4.0.0] - 2026-11-01

### Added
- Prior approval of every write by the user, asked by the server itself through MCP elicitation (`JMAP_APPROVAL=elicit`, the default). The 23 tools that send, draft, mark, move, label or delete show the exact action, with a unique reference, and act only on accept: sending tools show the e-mail as it will leave (sender, computed recipients, subject, text, attachments; the long signature is named, not repeated), the others the e-mails (sender, date, subject) and folders by name. Prompts in English or French (`USER_LANGUAGE`, `USER_TIMEZONE`), `JMAP_APPROVAL_TIMEOUT_MS`, `JMAP_APPROVAL_EXEMPT` (tools the user chooses to run without a prompt, empty by default).
- `scripts/live-approval.mjs`: live test of the approvals on a real account; it sends nothing and deletes its test draft.

### Changed
- **Breaking**: with an MCP client that does not support elicitation, write tools now return an error and do nothing. Set `JMAP_APPROVAL=client` to keep the 3.x behaviour when your client confirms writes itself.
- **Breaking**: `update_draft` replaces the draft with a new one (JMAP e-mails are immutable except keywords and mailboxes, RFC 8621) and returns its new `draftId` (and `previousDraftId`). A new `body` is plain text and gets the configured signature, like `create_draft`. Threading headers, attachments, folders and keywords are kept.

### Fixed
- `update_draft` failed on a real server (`invalidPatch`: it patched `bodyValues`, which JMAP forbids) and could not change the text of a draft.

## [3.0.0] - 2026-11-01

### Breaking
- OIDC redirect URIs must be loopback addresses with an explicit port (`http://localhost:<port>/callback`, `127.0.0.1` or `[::1]`, RFC 8252). Remote redirect URIs (ngrok tunnels) and `JMAP_OIDC_LOCAL_PORT` are no longer supported; the configuration reports them explicitly.

### Changed
- oauth-callback 3: the callback listener binds the redirect URI of the authorization request and checks its `state`; the code is exchanged on that exact redirect URI.
- Dependencies: openid-client 6.8.8, commander 15, @inquirer/prompts 8.7.5, open 11.0.4, eslint 10, vitest 5, @types/node 26; CI actions v7.

### Fixed
- The server and the CLI reported a stale hard-coded version (0.1.0): they now read package.json.

## [2.1.0] - 2026-10-31

### Added
- `JMAP_AUTH_METHOD=command`: the access token comes from an external broker (`JMAP_TOKEN_COMMAND`, raw token or JSON `{access_token, expires_at}`), refreshed before expiry.
- `create_draft` builds `multipart/alternative` drafts (plain text + HTML) from `body` or `htmlBody`, with the configured signature appended to both parts.
- Reply threading: `inReplyTo` sets both `In-Reply-To` and `References`.

### Changed
- Repository moved to the [LINAGORA organisation](https://github.com/linagora/mcp-twake-mail); README rewritten (Twake.ai positioning, installation for Claude Desktop, Claude Code and Hermes Agent, recommended drafts-only configuration).
- Community files: Code of Conduct, Security Policy, Contributing guide with DCO, issue and pull request templates, CI (Node 20 and 22) and Dependabot.

## [2.0.0] - 2026-01-31

### Added
- Draft management (`update_draft`, `send_draft`) and mailbox management (`create_mailbox`, `rename_mailbox`, `delete_mailbox`): 29 tools.

## [1.1.0] - 2026-01-31

### Added
- `forward_email` and batch operations (6 tools).

## [1.0.0] - 2026-01-30

### Added
- Initial release: 17 tools, Basic / Bearer / OIDC authentication, auto-discovery, Markdown signatures.
