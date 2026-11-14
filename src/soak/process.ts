import { appendFile } from "node:fs/promises";
import { spawn } from "node:child_process";

export type ProcessResult = { code: number; stdout: string; stderr: string; timedOut: boolean;
  hardKillIssued: boolean; closeObserved: boolean; pid: number | null };

export async function runBoundedProcess(command: string, args: string[], options: {
  cwd: string; timeoutMs: number; outputFile?: string; interruptGraceMs?: number; hardKillGraceMs?: number;
  softInterrupt?: () => void; mirrorOutput?: boolean; maxCaptureChars?: number;
}): Promise<ProcessResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, shell: false, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let hardKillIssued = false;
    let settled = false;
    let escalationTimer: NodeJS.Timeout | null = null;
    let hardStopTimer: NodeJS.Timeout | null = null;
    let writes = Promise.resolve();
    const captureLimit = options.maxCaptureChars == null ? Number.MAX_SAFE_INTEGER : Math.max(1, options.maxCaptureChars);
    const capture = (current: string, text: string) => {
      const combined = current + text;
      return combined.length <= captureLimit ? combined : combined.slice(-captureLimit);
    };
    const write = (chunk: Buffer, isError: boolean) => {
      const text = chunk.toString("utf8");
      if (isError) stderr = capture(stderr, text); else stdout = capture(stdout, text);
      if (options.outputFile) writes = writes.then(() => appendFile(options.outputFile!, text, "utf8"));
      if (options.mirrorOutput !== false) (isError ? process.stderr : process.stdout).write(text);
    };
    child.stdout.on("data", (chunk: Buffer) => write(chunk, false));
    child.stderr.on("data", (chunk: Buffer) => write(chunk, true));
    const finish = (code: number, closeObserved: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (escalationTimer) clearTimeout(escalationTimer);
      if (hardStopTimer) clearTimeout(hardStopTimer);
      void writes.then(() => resolve({ code, stdout, stderr, timedOut, hardKillIssued,
        closeObserved, pid: child.pid ?? null }), reject);
    };
    child.on("error", (error) => { if (!settled) reject(error); });
    const timer = setTimeout(() => {
      timedOut = true;
      if (options.softInterrupt) options.softInterrupt(); else child.kill("SIGINT");
      escalationTimer = setTimeout(() => {
        hardKillIssued = true;
        child.kill("SIGKILL");
        hardStopTimer = setTimeout(() => finish(-1, false), options.hardKillGraceMs ?? 5_000);
      }, options.interruptGraceMs ?? 30_000);
    }, options.timeoutMs);
    child.on("close", (code) => {
      finish(code ?? -1, true);
    });
  });
}
