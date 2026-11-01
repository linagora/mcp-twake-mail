# Changelog

All notable changes to mcp-twake-mail are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
