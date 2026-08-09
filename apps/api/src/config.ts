export interface AppConfig {
  host: string;
  port: number;
  databaseUrl: string | undefined;
  nodeEnv: string;
  masterKeyBase64: string | undefined;
  adminEmail: string;
  adminPassword: string | undefined;
  cookieSecure: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 4100),
    databaseUrl: env.DATABASE_URL,
    nodeEnv: env.NODE_ENV ?? "development",
    masterKeyBase64: env.ARENA_MASTER_KEY || undefined,
    adminEmail: env.ARENA_ADMIN_EMAIL ?? "admin@localhost",
    adminPassword: env.ARENA_ADMIN_PASSWORD || undefined,
    cookieSecure: env.ARENA_COOKIE_SECURE === "true",
  };
}
