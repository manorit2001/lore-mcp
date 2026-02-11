export type Args = { [k: string]: string | boolean | number };

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);

export function parseArgv(argv: string[]): { cmd: string; args: Args } {
  const [, , cmd = "help", ...rest] = argv;
  const args: Args = {};
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t.startsWith("--")) {
      const key = t.slice(2);
      const nxt = rest[i + 1];
      if (!nxt || nxt.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = nxt;
        i++;
      }
    } else if (!args["_"]) {
      args["_"] = t;
    }
  }
  return { cmd, args };
}

export function parseBooleanArg(value: unknown, defaultValue = false): boolean {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (TRUE_VALUES.has(normalized)) return true;
    if (FALSE_VALUES.has(normalized)) return false;
    return normalized.length > 0;
  }
  return Boolean(value);
}
