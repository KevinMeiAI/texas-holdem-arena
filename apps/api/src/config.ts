export interface AppConfig {
  host: string;
  port: number;
  databaseUrl: string | undefined;
  nodeEnv: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    host: env.HOST ?? "127.0.0.1",
    port: Number(env.PORT ?? 4100),
    databaseUrl: env.DATABASE_URL,
    nodeEnv: env.NODE_ENV ?? "development",
  };
}
