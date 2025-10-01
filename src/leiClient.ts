import { spawn } from "node:child_process";

export type LeiSearchResult = {
  subject: string;
  from?: string;
  date?: string;
  url?: string;
  messageId?: string;
  list?: string;
};

export class LeiClient {
  private available: boolean | null = null;

  async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available;
    try {
      await this.exec(["--version"], 5000);
      this.available = true;
    } catch {
      this.available = false;
    }
    return this.available;
  }

  async search(query: string, limit = 20): Promise<LeiSearchResult[]> {
    // Use JSON output if available. Fallback to parsed text otherwise.
    try {
      const out = await this.exec(["q", "-f", "json", "-n", String(limit), query]);
      const json = JSON.parse(out);
      // public-inbox JSON format: array of entries with fields (subject, from, ds, mid, href)
      return (json as any[]).map((e) => ({
        subject: e.subject,
        from: e.from,
        date: e.ds || e.date,
        url: e.href,
        messageId: e.mid || e.message_id,
        list: e.list
      }));
    } catch (e) {
      // Try plain text as last resort (very limited)
      const out = await this.exec(["q", "-n", String(limit), query]);
      return out.split(/\n+/).filter(Boolean).map((line) => ({ subject: line.trim() }));
    }
  }

  private exec(args: string[], timeoutMs = 15000): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn("lei", args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const to = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`lei ${args.join(" ")} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d) => (stdout += String(d)));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d) => (stderr += String(d)));
      child.on("error", (err) => {
        clearTimeout(to);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(to);
        if (code === 0) resolve(stdout);
        else reject(new Error(`lei exited with code ${code}: ${stderr}`));
      });
    });
  }
}

