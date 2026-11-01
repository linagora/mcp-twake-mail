# OIDC Configuration Guide

This guide explains how to configure mcp-twake-mail for OpenID Connect (OIDC) authentication with your JMAP email server.

## Overview

OIDC authentication uses the OAuth 2.0 Authorization Code flow with PKCE (Proof Key for Code Exchange) to securely authenticate users. This is the recommended method for enterprise environments with Single Sign-On (SSO).

**Key benefits:**
- No passwords stored in configuration files
- Automatic token refresh
- Enterprise SSO integration
- Secure PKCE S256 code challenge

## Prerequisites

Before configuring OIDC, you need:

1. **OIDC Provider** — An identity provider that supports OpenID Connect:
   - Keycloak
   - Auth0
   - Okta
   - Azure AD
   - Google Workspace
   - Any OIDC-compliant provider

2. **Client Registration** — A registered OAuth client with:
   - Client ID
   - Redirect URI: `http://localhost:3000/callback`
   - Authorization Code flow enabled
   - PKCE support (S256)

3. **JMAP Server** — Must accept tokens from your OIDC provider

## Quick Setup

The easiest way to configure OIDC is with the setup wizard:

```bash
npx mcp-twake-mail setup
```

Choose **OIDC** when prompted for authentication method. The wizard will:
1. Ask for OIDC issuer URL
2. Ask for client ID
3. Open your browser for authentication
4. Store tokens securely
5. Generate configuration

## Configuration Variables

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `JMAP_SESSION_URL` | Yes | JMAP server session URL | `https://jmap.example.com/jmap/session` |
| `JMAP_AUTH_METHOD` | Yes | Must be `oidc` | `oidc` |
| `JMAP_OIDC_ISSUER` | Yes | OIDC provider base URL | `https://sso.example.com` |
| `JMAP_OIDC_CLIENT_ID` | Yes | OAuth client identifier | `mcp-twake-mail` |
| `JMAP_OIDC_SCOPE` | No | OAuth scopes to request | `openid profile email offline_access` |
| `JMAP_OIDC_REDIRECT_URI` | No | OAuth callback URL | `http://localhost:3000/callback` |

### Scopes

The default scopes are: `openid profile email offline_access`

| Scope | Required | Purpose |
|-------|----------|---------|
| `openid` | Yes | OpenID Connect authentication |
| `profile` | Recommended | User profile information |
| `email` | Recommended | User email address |
| `offline_access` | Recommended | Refresh token for automatic renewal |

**Important:** Include `offline_access` to enable automatic token refresh. Without it, users must re-authenticate when the access token expires.

### Redirect URI

The default redirect URI is `http://localhost:3000/callback`.

You can customize this with `JMAP_OIDC_REDIRECT_URI`, but it must:
- Match exactly what's registered in your OIDC provider
- Be a loopback address with an explicit port: `http://localhost:<port>/…`, `http://127.0.0.1:<port>/…` or `http://[::1]:<port>/…` (RFC 8252 §7.3)
- Use plain HTTP (the callback never leaves your machine)

Remote redirect URIs (ngrok tunnels and the like) and `JMAP_OIDC_LOCAL_PORT` are no longer supported since 3.0.0. On a remote machine without a browser, run the authentication on your own computer, or use `JMAP_AUTH_METHOD=command` with a token broker.

## Claude Desktop Configuration

```json
{
  "mcpServers": {
    "mcp-twake-mail": {
      "command": "npx",
      "args": ["-y", "mcp-twake-mail"],
      "env": {
        "JMAP_SESSION_URL": "https://jmap.example.com/jmap/session",
        "JMAP_AUTH_METHOD": "oidc",
        "JMAP_OIDC_ISSUER": "https://sso.example.com",
        "JMAP_OIDC_CLIENT_ID": "mcp-twake-mail",
        "JMAP_OIDC_SCOPE": "openid profile email offline_access"
      }
    }
  }
}
```

## Authentication Flow

### Initial Authentication

1. **Start mcp-twake-mail** — The MCP server starts
2. **Check for tokens** — Looks in `~/.mcp-twake-mail/tokens.json`
3. **If no valid token** — Opens browser for OIDC login
4. **User authenticates** — In browser with OIDC provider
5. **Callback received** — Server receives authorization code
6. **Token exchange** — Code exchanged for access + refresh tokens
7. **Tokens stored** — Saved securely with 0600 permissions
8. **JMAP session** — Access token used to authenticate with JMAP

### Token Refresh

Tokens are automatically refreshed:

1. **Before each request** — Token expiry is checked
2. **60-second buffer** — Refresh happens before expiry
3. **Refresh grant** — Refresh token exchanged for new access token
4. **New tokens stored** — Updated in `~/.mcp-twake-mail/tokens.json`
5. **Transparent to user** — No re-authentication needed

### Re-Authentication

If refresh fails (e.g., refresh token expired), you can re-authenticate:

```bash
npx mcp-twake-mail auth
```

This triggers a new browser-based authentication flow.

## Token Storage

Tokens are stored in `~/.mcp-twake-mail/tokens.json`:

```json
{
  "accessToken": "eyJhbGciOiJSUzI1NiIs...",
  "refreshToken": "dGhpcyBpcyBhIHJlZnJlc2ggdG9rZW4...",
  "expiresAt": 1706623200000,
  "tokenType": "Bearer"
}
```

**Security:**
- File permissions: `0600` (owner read/write only)
- Directory permissions: `0700`
- Never commit to version control

## PKCE Flow Details

mcp-twake-mail uses PKCE with S256 for security:

1. **Code Verifier** — Random 43-128 character string generated
2. **Code Challenge** — SHA-256 hash of verifier, base64url encoded
3. **Authorization Request** — Challenge sent to OIDC provider
4. **Token Request** — Verifier sent to prove possession

This prevents authorization code interception attacks.

## Provider-Specific Setup

### Keycloak

1. Create a new client in your realm
2. Set **Client type** to "OpenID Connect"
3. Enable **Standard flow** (Authorization Code)
4. Set **Valid redirect URIs** to `http://localhost:3000/callback`
5. Under **Capability config**, enable **Client authentication: Off** (public client)
6. Under **Login settings**, enable **Consent required: Off** (optional)

**Issuer URL:** `https://keycloak.example.com/realms/your-realm`

### Auth0

1. Create a new Application (Regular Web Application)
2. Set **Allowed Callback URLs** to `http://localhost:3000/callback`
3. Under **Advanced Settings > Grant Types**, enable "Authorization Code" and "Refresh Token"
4. Under **Advanced Settings > OAuth**, enable PKCE

**Issuer URL:** `https://your-tenant.auth0.com`

### Azure AD

1. Register a new application
2. Add **Redirect URI**: `http://localhost:3000/callback` (Web platform)
3. Under **API permissions**, add `openid`, `profile`, `email`, `offline_access`
4. Under **Authentication**, enable "Allow public client flows"

**Issuer URL:** `https://login.microsoftonline.com/{tenant-id}/v2.0`

### Okta

1. Create a new App Integration (OIDC - OpenID Connect)
2. Choose "Native Application" for PKCE support
3. Set **Sign-in redirect URIs** to `http://localhost:3000/callback`
4. Under **Assignments**, assign users or groups

**Issuer URL:** `https://your-org.okta.com`

## Troubleshooting

### "Invalid redirect_uri"

The redirect URI in your configuration must exactly match what's registered in your OIDC provider. Check for:
- Trailing slashes
- HTTP vs HTTPS
- Port numbers
- Path case sensitivity

### "Token refresh failed"

Possible causes:
1. Refresh token expired (re-authenticate with `npx mcp-twake-mail auth`)
2. `offline_access` scope not granted
3. OIDC provider configuration changed

### "PKCE validation failed"

Your OIDC provider may not support S256 PKCE. Check provider documentation and ensure:
- PKCE is enabled for the client
- S256 code challenge method is supported

### Browser Doesn't Open

If running in a headless environment:
1. Copy the authorization URL from the console
2. Open it in a browser on another machine
3. After authentication, copy the callback URL
4. The server will detect the callback automatically

### Token File Permissions

If you see permission errors:
```bash
chmod 600 ~/.mcp-twake-mail/tokens.json
chmod 700 ~/.mcp-twake-mail
```

## Security Considerations

1. **Never share tokens** — Access and refresh tokens grant full email access
2. **Secure token storage** — Use encrypted disk if possible
3. **Minimal scopes** — Only request scopes you need
4. **Token rotation** — Some providers rotate refresh tokens; mcp-twake-mail handles this
5. **Revoke on compromise** — If tokens are exposed, revoke them at your OIDC provider

## References

- [RFC 6749](https://datatracker.ietf.org/doc/html/rfc6749) — OAuth 2.0 Authorization Framework
- [RFC 7636](https://datatracker.ietf.org/doc/html/rfc7636) — PKCE for OAuth 2.0
- [OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html) — OIDC Specification
