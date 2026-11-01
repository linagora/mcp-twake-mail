# Security Policy

mcp-twake-mail gives an AI assistant access to personal and professional data in [Twake.ai](https://twake.ai). We take its security seriously and thank everyone who reports issues responsibly.

## Supported versions

Security fixes are released for the latest minor version.

| Version | Supported |
|---|---|
| 4.x | ✅ |
| 3.x | ❌ |
| 2.1.x | ❌ |
| older | ❌ |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions or pull requests.**

Report them privately, by one of these channels:

1. GitHub private vulnerability reporting: [Report a vulnerability](https://github.com/linagora/mcp-twake-mail/security/advisories/new);
2. email to **dpo@linagora.com**.

Please include:

- the affected version or commit;
- a description of the issue and its impact;
- steps to reproduce or a proof of concept;
- any suggested fix or mitigation.

We will acknowledge your report within **5 business days**, keep you informed of the progress, and agree with you on a disclosure date once a fix is available. With your permission, we will credit you in the release notes.

## Security model and hardening

An MCP server acts **with the full rights of the account it is configured with**. Keep these points in mind:

- **Credentials**: `JMAP_PASSWORD`, `JMAP_TOKEN` and OIDC tokens are secrets. OIDC tokens are stored in `~/.mcp-twake-mail/` with `0600` permissions; prefer OIDC or `JMAP_AUTH_METHOD=command` (short-lived tokens from a broker you control) over static passwords.
- **Prior approval**: with `JMAP_APPROVAL=elicit` (the default), the server asks the user, through MCP elicitation, to approve every write before doing it: sending tools show the e-mail as it will leave (sender, computed recipients, subject, text, attachments), the others the e-mails and folders they touch, with a unique reference. It fails closed: refusal, timeout, error or a client without elicitation means nothing is sent or changed. `JMAP_APPROVAL=client` hands this to the MCP client; `JMAP_APPROVAL_EXEMPT` lifts it for the tools the user lists.
- **Sending on the user's behalf**: `send_email`, `reply_email`, `forward_email` and `send_draft` send real mail. For a drafts-only workflow, filter them out in your MCP client (see *Recommended safe configuration* in the README).
- **Destructive tools**: `delete_email`, `batch_delete` and `delete_mailbox` carry `destructiveHint`; MCP clients should ask for confirmation.
- **Prompt injection**: email bodies are untrusted content written by third parties. An incoming message can try to instruct the assistant; never let an assistant act on mail content without human review of write actions.
- **Transport**: HTTPS is required for the JMAP session URL.

General recommendations:

- Give the assistant only the tools it needs (most MCP clients support an allow-list or a deny-list of tools).
- Keep human confirmation for every action that writes, sends, shares or deletes.
- Run the server locally (stdio transport) next to your MCP client; never expose it on a network.
- To keep the whole chain sovereign, pair it with a self-hosted or European AI model.
