import { spawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import type { Message } from "./messageTypes.js";
import { parseMbox } from "./mboxParser.js";
import { LoreClient } from "./loreClient.js";

export type B4FetchOptions = {
  messageId?: string;
  url?: string;
};

export type B4ApplyOptions = B4FetchOptions & {
  cwd?: string;
  additionalArgs?: string[];
  noApply?: boolean;
};

export type B4ApplyResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export class B4Client {
  private available: boolean | null = null;

  async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available;
    try {
      await this.exec(["--version"], { timeoutMs: 3000 });
      this.available = true;
    } catch {
      this.available = false;
    }

    return this.available;
  }

  async fetchSeries(opts: B4FetchOptions): Promise<Message[]> {
    const target = this.resolveTarget(opts);
    const { stdout } = await this.exec(["am", "--stdout", "--no-apply", target], { timeoutMs: 60000 });
    if (!stdout.trim()) return [];
    const parsed = parseMbox(stdout);
    return parsed.map((msg) => ({
      ...msg,
      messageId: (msg.headers["message-id"] as string | undefined) || msg.messageId,
    }));
  }

  async apply(opts: B4ApplyOptions): Promise<B4ApplyResult> {
    const target = this.resolveTarget(opts);
    const args = ["am", target];
    if (opts.noApply) args.splice(1, 0, "--no-apply");
    if (Array.isArray(opts.additionalArgs) && opts.additionalArgs.length) {
      args.splice(1, 0, ...opts.additionalArgs);
    }
    try {
      const { stdout, stderr } = await this.exec(args, { cwd: opts.cwd });
      return { stdout, stderr, exitCode: 0 };
    } catch (err: any) {
      if (err && typeof err === "object" && "stdout" in err && "stderr" in err && "code" in err) {
        return { stdout: err.stdout as string, stderr: err.stderr as string, exitCode: err.code as number };
      }
      throw err;
    }
  }

  private resolveTarget(opts: B4FetchOptions): string {
    const { messageId, url } = opts;
    if (messageId) return messageId;
    if (url) {
      const mid = LoreClient.extractMessageId(url);
      if (mid) return mid;
      return url;
    }
    throw new Error("b4 requires a messageId or url");
  }

  private exec(args: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string }> {
    const spawnOpts: SpawnOptions = { stdio: ["ignore", "pipe", "pipe"], cwd: options.cwd };
    return new Promise((resolve, reject) => {
      const child = spawn("b4", args, spawnOpts);
      let stdout = "";
      let stderr = "";
      const timeout = options.timeoutMs ? setTimeout(() => {
         child.kill("SIGKILL");
         reject(new Error(`b4 ${args.join(" ")} timed out after ${options.timeoutMs}ms`));
       }, options.timeoutMs) : null;
      const outStream = child.stdout;
      if (outStream) {
        outStream.setEncoding("utf8");
        outStream.on("data", (chunk) => { stdout += String(chunk); });
      }
      const errStream = child.stderr;
      if (errStream) {
        errStream.setEncoding("utf8");
        errStream.on("data", (chunk) => { stderr += String(chunk); });
      }
      child.on("error", (err) => {
        if (timeout) clearTimeout(timeout);
        reject(err);
      });
      child.on("close", (code) => {
        if (timeout) clearTimeout(timeout);
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          const error: any = new Error(`b4 exited with code ${code}`);
          error.code = code;
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
        }
      });
    });
  }
}
