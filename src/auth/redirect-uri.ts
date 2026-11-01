/**
 * OAuth redirect URIs for native apps (RFC 8252 §7.3): the callback is received on a
 * loopback interface of this machine. oauth-callback 3 only binds such URIs, so remote
 * redirect URIs (ngrok tunnels…) are not supported.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Why `uri` cannot be used as the OIDC redirect URI, or null when it can. */
export function loopbackRedirectProblem(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return `JMAP_OIDC_REDIRECT_URI must be a valid URL (got "${uri}")`;
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    return `JMAP_OIDC_REDIRECT_URI must be a loopback address (http://localhost:<port>/callback, 127.0.0.1 or [::1]); remote redirect URIs such as ngrok tunnels are no longer supported`;
  }
  if (url.protocol !== 'http:') return 'JMAP_OIDC_REDIRECT_URI must use http: on the loopback interface (RFC 8252)';
  if (!url.port) return 'JMAP_OIDC_REDIRECT_URI needs an explicit port, e.g. http://localhost:3000/callback';
  return null;
}
