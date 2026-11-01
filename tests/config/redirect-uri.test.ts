import { describe, expect, it } from 'vitest';
import { envSchema } from '../../src/config/schema.js';
import { loopbackRedirectProblem } from '../../src/auth/redirect-uri.js';

describe('loopbackRedirectProblem', () => {
  it('accepts http loopback URIs with an explicit port', () => {
    expect(loopbackRedirectProblem('http://localhost:3000/callback')).toBeNull();
    expect(loopbackRedirectProblem('http://127.0.0.1:5678/cb')).toBeNull();
    expect(loopbackRedirectProblem('http://[::1]:3000/callback')).toBeNull();
  });

  it('refuses remote, https, portless and invalid URIs', () => {
    expect(loopbackRedirectProblem('https://abc123.ngrok.io/callback')).toMatch(/loopback/);
    expect(loopbackRedirectProblem('https://localhost:3000/callback')).toMatch(/http:/);
    expect(loopbackRedirectProblem('http://localhost/callback')).toMatch(/port/);
    expect(loopbackRedirectProblem('not a url')).toMatch(/valid URL/);
  });
});

describe('envSchema OIDC redirect', () => {
  const base = { JMAP_SESSION_URL: 'https://jmap.example.com/jmap/session', JMAP_AUTH_METHOD: 'bearer', JMAP_TOKEN: 't' };

  it('defaults to http://localhost:3000/callback', () => {
    expect(envSchema.parse(base).JMAP_OIDC_REDIRECT_URI).toBe('http://localhost:3000/callback');
  });

  it('rejects a remote redirect URI and the removed JMAP_OIDC_LOCAL_PORT', () => {
    expect(envSchema.safeParse({ ...base, JMAP_OIDC_REDIRECT_URI: 'https://abc123.ngrok.io/callback' }).success).toBe(false);
    const r = envSchema.safeParse({ ...base, JMAP_OIDC_LOCAL_PORT: '3000' });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/no longer supported/);
  });
});
