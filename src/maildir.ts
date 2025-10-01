import { promises as fs } from "node:fs";
import { dirname, resolve } from "node:path";
import os from "node:os";

export type MailMessage = {
  headers: Record<string, string | string[]>;
  body: string;
  messageId?: string;
};

export async function ensureMaildir(root: string): Promise<void> {
  const p = resolve(root);
  await fs.mkdir(p, { recursive: true });
  for (const d of ["tmp", "new", "cur"]) {
    await fs.mkdir(resolve(p, d), { recursive: true });
  }
}

function sanitizeFilename(name: string): string {
  // Keep alnum and a few safe symbols; percent-encode others
  return Array.from(name)
    .map((ch) => /[A-Za-z0-9@._+-]/.test(ch) ? ch : `%${ch.charCodeAt(0).toString(16)}`)
    .join("");
}

function uniqueBase(): string {
  const ts = Date.now();
  const pid = process.pid;
  const host = os.hostname().split(".")[0] || "host";
  const rnd = Math.random().toString(36).slice(2);
  return `${ts}.${pid}.${host}.${rnd}`;
}

export function serializeRfc822(msg: MailMessage): string {
  const lines: string[] = [];
  // Preserve lowercase keys; this is valid for Maildir consumers
  for (const [k, v] of Object.entries(msg.headers || {})) {
    if (Array.isArray(v)) {
      for (const vv of v) lines.push(`${k}: ${vv}`);
    } else if (typeof v === "string") {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push("");
  lines.push(msg.body || "");
  return lines.join("\n");
}

export async function writeToMaildir(maildir: string, msg: MailMessage): Promise<string> {
  const base = msg.messageId ? sanitizeFilename(msg.messageId.replace(/[<>]/g, "")) : uniqueBase();
  const uniq = `${uniqueBase()}.${base}`;
  const tmpPath = resolve(maildir, "tmp", uniq);
  const curPath = resolve(maildir, "cur", `${uniq}:2,`);
  const raw = serializeRfc822(msg);
  await fs.mkdir(dirname(tmpPath), { recursive: true });
  await fs.writeFile(tmpPath, raw, "utf8");
  await fs.rename(tmpPath, curPath);
  return curPath;
}

