export interface AppConfig {
  host: string;
  port: number;
  databaseUrl: string | undefined;
  nodeEnv: string;
  masterKeyBase64: string | undefined;
  adminEmail: string;
  adminPassword: string | undefined;
  cookieSecure: boolean;
  publicOrigin: string;
}

function parsePublicOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("ARENA_PUBLIC_ORIGIN must be a valid HTTP(S) origin");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("ARENA_PUBLIC_ORIGIN must use http:// or https://");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError("ARENA_PUBLIC_ORIGIN must contain only scheme, host, and optional port");
  }
  return url.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.PORT ?? 4100);
  return {
    host: env.HOST ?? "127.0.0.1",
    port,
    databaseUrl: env.DATABASE_URL,
    nodeEnv: env.NODE_ENV ?? "development",
    masterKeyBase64: env.ARENA_MASTER_KEY || undefined,
    adminEmail: env.ARENA_ADMIN_EMAIL ?? "admin@localhost",
    adminPassword: env.ARENA_ADMIN_PASSWORD || undefined,
    cookieSecure: env.ARENA_COOKIE_SECURE === "true",
    // Never derive public links from Host/X-Forwarded-Host. Those headers are
    // caller-controlled unless every proxy hop is configured and trusted.
    publicOrigin: parsePublicOrigin(env.ARENA_PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`),
  };
}
