import { execFile } from "node:child_process";
import { mkdir, open, readFile, readdir, rename, rm, lstat } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import type { Job } from "./service.js";
const exec = promisify(execFile);
export class ConfirmationStore {
  private lock: Awaited<ReturnType<typeof open>> | null = null;
  constructor(readonly root: string, readonly maxStoredJobs = 1024) {}
  async init(): Promise<void> {
    if (!path.isAbsolute(this.root) || this.root.startsWith("\\\\")
        || (process.platform === "win32" && !/^[c-d]:\\/i.test(this.root))) throw new Error("private confirmation store must be local");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if ((await lstat(this.root)).isSymbolicLink()) throw new Error("private store cannot be a symlink");
    if (process.platform === "win32") {
      const identity = (process.env.USERDOMAIN ? process.env.USERDOMAIN + "\\" : "") + (process.env.USERNAME || os.userInfo().username);
      await exec("icacls.exe", [this.root, "/inheritance:r", "/grant:r", identity + ":(OI)(CI)(F)"], { windowsHide: true });
      const pwsh = path.join(process.env.USERPROFILE ?? "", ".cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe");
      const script = "$a=Get-Acl -LiteralPath '" + this.root.replaceAll("'", "''") + "'; $r=@($a.Access|Where-Object {$_.AccessControlType -eq 'Allow'}); if($r.Count -ne 1 -or $r[0].IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value){throw 'Private confirmation ACL invalid'}";
      await exec(pwsh, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true });
    } else if (((await lstat(this.root)).mode & 0o077) !== 0) throw new Error("private store is not owner-only");
    const lockFile = path.join(this.root, ".writer");
    try { this.lock = await open(lockFile, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Serialize stale-lock recovery too: two recoverers must not remove a new writer's lock.
      const recoveryFile = path.join(this.root, ".lock-recovery");
      const recovery = await open(recoveryFile, "wx", 0o600);
      try {
        const oldPid = Number(await readFile(lockFile, "utf8"));
        if (!Number.isSafeInteger(oldPid) || oldPid <= 0) throw new Error("private journal lock needs reconciliation");
        let alive = true;
        try { process.kill(oldPid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
        if (alive) throw new Error("confirmation journal already has a writer");
        await rm(lockFile); this.lock = await open(lockFile, "wx", 0o600);
        await this.lock.writeFile(String(process.pid)); await this.lock.sync();
      } finally { await recovery.close(); await rm(recoveryFile); }
      return;
    }
    await this.lock.writeFile(String(process.pid)); await this.lock.sync();
  }
  async close(): Promise<void> {
    if (!this.lock) return;
    await this.lock.close(); this.lock = null; await rm(path.join(this.root, ".writer"));
  }
  async jobs(): Promise<Job[]> {
    if (!this.lock) throw new Error("private journal is not locked");
    const files = (await readdir(this.root)).filter(f => /^[0-9a-f]{64}\.json$/.test(f));
    if (files.length > this.maxStoredJobs) throw new Error("confirmation journal retention bound reached");
    return Promise.all(files.map(async file => {
      const target = path.join(this.root, file);
      const info = await lstat(target);
      if (info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error("invalid private job file");
      const job = JSON.parse(await readFile(target, "utf8")) as Job;
      if (job.schema !== "agent1.bonded-confirmation.v1" || job.round.round_id.slice(2) + ".json" !== file) throw new Error("invalid private job identity");
      return job;
    }));
  }
  async save(job: Job): Promise<void> {
    if (!this.lock || !/^0x[0-9a-f]{64}$/.test(job.round.round_id)) throw new Error("invalid private confirmation write");
    const file = path.join(this.root, job.round.round_id.slice(2) + ".json");
    const temporary = file + ".pending";
    const data = JSON.stringify(job);
    if (Buffer.byteLength(data) > 4 * 1024 * 1024) throw new Error("private job exceeds byte bound");
    const fd = await open(temporary, "w", 0o600);
    try { await fd.writeFile(data); await fd.sync(); } finally { await fd.close(); }
    await rename(temporary, file);
    if (process.platform !== "win32") { const dir = await open(this.root, "r"); try { await dir.sync(); } finally { await dir.close(); } }
  }
}
