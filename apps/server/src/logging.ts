export type LogField = string | number | boolean | undefined;
export type LogFields = Readonly<Record<string, LogField>>;

/** Minimal structured logger used for operational failures without notebook payloads. */
export interface StructuredLogger {
  readonly warn: (event: string, fields?: LogFields) => void;
  readonly error: (event: string, fields?: LogFields) => void;
}

/** Writes one JSON object per operational event for easy collection by host processes. */
export const consoleLogger: StructuredLogger = {
  warn: (event, fields) => writeLog("warn", event, fields),
  error: (event, fields) => writeLog("error", event, fields),
};

function writeLog(level: "warn" | "error", event: string, fields: LogFields = {}): void {
  const safeFields = Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      typeof value === "string" ? scrub(value) : value,
    ]),
  );
  const line = JSON.stringify({ level, event, time: new Date().toISOString(), ...safeFields });
  if (level === "error") console.error(line);
  else console.warn(line);
}

function scrub(value: string): string {
  return value.replace(/[\r\n]/g, " ").slice(0, 512);
}
