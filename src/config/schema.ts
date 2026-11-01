import { z } from 'zod';
import { loopbackRedirectProblem } from '../auth/redirect-uri.js';

export const envSchema = z
  .object({
    JMAP_SESSION_URL: z
      .string()
      .url('JMAP_SESSION_URL must be a valid URL')
      .refine(
        (url) => {
          const parsed = new URL(url);
          return (
            parsed.protocol === 'https:' ||
            parsed.hostname === 'localhost' ||
            parsed.hostname === '127.0.0.1'
          );
        },
        { message: 'URL must use HTTPS. Only localhost allowed over HTTP for development.' }
      ),
    JMAP_AUTH_METHOD: z.enum(['basic', 'bearer', 'oidc', 'command']).default('basic'),
    JMAP_USERNAME: z.string().optional(),
    JMAP_PASSWORD: z.string().optional(),
    JMAP_TOKEN: z.string().optional(),
    // command auth: shell command printing an access token (raw or JSON {access_token, expires_at})
    JMAP_TOKEN_COMMAND: z.string().optional(),
    // OIDC configuration fields
    JMAP_OIDC_ISSUER: z
      .string()
      .url('JMAP_OIDC_ISSUER must be a valid URL')
      .optional(),
    JMAP_OIDC_CLIENT_ID: z.string().optional(),
    JMAP_OIDC_SCOPE: z.string().default('openid email offline_access'),
    // Redirect URI for OIDC - must be registered with the provider
    // Loopback only (RFC 8252): the callback is received on this machine
    JMAP_OIDC_REDIRECT_URI: z
      .string()
      .default('http://localhost:3000/callback')
      .superRefine((uri, ctx) => {
        const problem = loopbackRedirectProblem(uri);
        if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
      }),
    // Removed in 3.0.0 (it served remote redirect URIs); kept only to report it clearly
    JMAP_OIDC_LOCAL_PORT: z.string().optional(),
    JMAP_REQUEST_TIMEOUT: z.coerce.number().default(30000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    // Email identity and signature configuration
    JMAP_DEFAULT_FROM: z.string().email('JMAP_DEFAULT_FROM must be a valid email address').optional(),
    JMAP_SIGNATURE_PATH: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.JMAP_OIDC_LOCAL_PORT !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JMAP_OIDC_LOCAL_PORT'],
        message: 'JMAP_OIDC_LOCAL_PORT is no longer supported: put the port in JMAP_OIDC_REDIRECT_URI (http://localhost:<port>/callback)',
      });
    }
    // Conditional validation: basic auth requires username+password
    if (data.JMAP_AUTH_METHOD === 'basic') {
      if (!data.JMAP_USERNAME) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['JMAP_USERNAME'],
          message: 'JMAP_USERNAME is required when using basic auth',
        });
      }
      if (!data.JMAP_PASSWORD) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['JMAP_PASSWORD'],
          message: 'JMAP_PASSWORD is required when using basic auth',
        });
      }
    } else if (data.JMAP_AUTH_METHOD === 'bearer') {
      // Bearer auth requires a token
      if (!data.JMAP_TOKEN) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['JMAP_TOKEN'],
          message: 'JMAP_TOKEN is required when using bearer auth',
        });
      }
    } else if (data.JMAP_AUTH_METHOD === 'oidc') {
      // OIDC requires issuer and client ID
      if (!data.JMAP_OIDC_ISSUER) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['JMAP_OIDC_ISSUER'],
          message: 'JMAP_OIDC_ISSUER is required when using oidc auth',
        });
      }
      if (!data.JMAP_OIDC_CLIENT_ID) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['JMAP_OIDC_CLIENT_ID'],
          message: 'JMAP_OIDC_CLIENT_ID is required when using oidc auth',
        });
      }
      // Note: JMAP_TOKEN is NOT required for OIDC - tokens come from the OAuth flow
    } else if (data.JMAP_AUTH_METHOD === 'command') {
      if (!data.JMAP_TOKEN_COMMAND) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['JMAP_TOKEN_COMMAND'],
          message: 'JMAP_TOKEN_COMMAND is required when using command auth',
        });
      }
    }
  });

export type Config = z.infer<typeof envSchema>;

export function loadConfig(): Config {
  return envSchema.parse(process.env);
}
