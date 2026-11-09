import { isIP } from "node:net";
import { resolve } from "node:path";

export type LoggingConfig = {
  level: "error" | "warn" | "info" | "debug";
  directory: string;
  retentionDays: number;
  maxFileBytes: number;
  maxTotalBytes?: number;
  trustedProxies: string[];
};

export function loadLoggingConfig(env: NodeJS.ProcessEnv): LoggingConfig {
  function positive(name: string, fallback?: number): number | undefined {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`Invalid ${name}`);
    }
    return value;
  }
  const level = env.LOG_LEVEL ?? "info";
  if (!["error", "warn", "info", "debug"].includes(level))
    throw new Error("Invalid LOG_LEVEL");
  const directory = env.LOG_DIR ?? "./logs";
  if (!directory.trim() || directory.includes("\0"))
    throw new Error("Invalid LOG_DIR");
  const trustedProxies =
    env.TRUSTED_PROXY_CIDRS === undefined
      ? ["127.0.0.1", "::1"]
      : env.TRUSTED_PROXY_CIDRS.split(",").map((value) => value.trim());
  for (const proxy of trustedProxies) {
    const parts = proxy.split("/");
    const family = isIP(parts[0]);
    if (
      !family ||
      parts.length > 2 ||
      (parts.length === 2 &&
        (!/^\d+$/.test(parts[1]) ||
          Number(parts[1]) > (family === 4 ? 32 : 128)))
    ) {
      throw new Error("Invalid TRUSTED_PROXY_CIDRS");
    }
  }
  const maxFileBytes = positive("LOG_MAX_FILE_BYTES", 20 * 1024 * 1024)!;
  const maxTotalBytes = positive("LOG_MAX_TOTAL_BYTES");
  if (maxTotalBytes !== undefined && maxTotalBytes < maxFileBytes)
    throw new Error("LOG_MAX_TOTAL_BYTES must cover one log file");
  return {
    level: level as LoggingConfig["level"],
    directory: resolve(directory),
    retentionDays: positive("LOG_RETENTION_DAYS", 180)!,
    maxFileBytes,
    maxTotalBytes,
    trustedProxies,
  };
}
