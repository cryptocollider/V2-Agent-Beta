import { execFile } from "node:child_process";
import { chmod, mkdir, open, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Wallet } from "ethers";

import { AgentWallet } from "../collider/wallet.js";

const execFileAsync = promisify(execFile);

function wslPath(value: string): { distro: string; linuxPath: string } | null {
  const match = value.match(/^\\\\wsl(?:\.localhost)?\\([^\\]+)\\(.+)$/i);
  if (!match) return null;
  return {
    distro: match[1],
    linuxPath: "/" + match[2].replace(/\\/g, "/"),
  };
}

async function enforceOwnerOnlyWindows(output: string): Promise<void> {
  const domain = String(process.env.USERDOMAIN ?? "").trim();
  const user = String(process.env.USERNAME ?? os.userInfo().username).trim();
  const identity = domain && user ? `${domain}\\${user}` : user;
  if (!identity) throw new Error("could not determine the Windows user for test-key ACLs");
  await execFileAsync("icacls.exe", [output, "/inheritance:r", "/grant:r", `${identity}:(F)`], {
    windowsHide: true,
  });
  const result = await execFileAsync("icacls.exe", [output], { windowsHide: true });
  const acl = result.stdout.toLowerCase();
  for (const broadPrincipal of ["everyone", "authenticated users", "builtin\\users"]) {
    if (acl.includes(broadPrincipal)) throw new Error(`test key ACL still grants ${broadPrincipal}`);
  }
}

export async function enforceOwnerOnly(output: string): Promise<void> {
  const wsl = wslPath(output);
  if (wsl) {
    await execFileAsync("wsl.exe", ["-d", wsl.distro, "--", "chmod", "600", wsl.linuxPath], {
      windowsHide: true,
    });
    const result = await execFileAsync("wsl.exe", ["-d", wsl.distro, "--", "stat", "-c", "%a", wsl.linuxPath], {
      windowsHide: true,
    });
    if (result.stdout.trim() !== "600") throw new Error("WSL test key permissions are not owner-only");
    return;
  }
  if (process.platform === "win32") {
    await enforceOwnerOnlyWindows(output);
    return;
  }
  await chmod(output, 0o600);
  const info = await stat(output);
  if ((info.mode & 0o077) !== 0) throw new Error("test key permissions are not owner-only");
}

export type FujiTestWalletInfo = {
  profile: "fuji_rc1_test_wallet";
  address: string;
  signingKeyFile: string;
  created: boolean;
};

export async function loadOrCreateFujiTestWallet(
  requestedOutput: string,
  workspaceDir = process.cwd(),
): Promise<FujiTestWalletInfo> {
  const output = path.resolve(requestedOutput);
  if (path.extname(output).toLowerCase() !== ".hex") throw new Error("test key output must end in .hex");
  const relativeToWorkspace = path.relative(path.resolve(workspaceDir), output);
  if (relativeToWorkspace === "" || (!relativeToWorkspace.startsWith("..") && !path.isAbsolute(relativeToWorkspace))) {
    throw new Error("test key must be stored outside the Agent1 workspace");
  }

  try {
    const existing = await AgentWallet.load({ signingKeyFile: output });
    if (!existing) throw new Error("existing test key could not be loaded");
    await enforceOwnerOnly(output);
    return {
      profile: "fuji_rc1_test_wallet",
      address: existing.address,
      signingKeyFile: output,
      created: false,
    };
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }

  await mkdir(path.dirname(output), { recursive: true });
  const wallet = Wallet.createRandom();
  let handle;
  let created = false;
  try {
    handle = await open(output, "wx", 0o600);
    created = true;
    await handle.writeFile(wallet.privateKey + "\n", "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await enforceOwnerOnly(output);
    const loaded = await AgentWallet.load({
      signingKeyFile: output,
      expectedEvmAddress: wallet.address,
    });
    if (!loaded || loaded.address.toLowerCase() !== wallet.address.toLowerCase()) {
      throw new Error("Agent1 could not reload the generated test key");
    }
    return {
      profile: "fuji_rc1_test_wallet",
      address: wallet.address,
      signingKeyFile: output,
      created: true,
    };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (created) await rm(output, { force: true }).catch(() => undefined);
    throw error;
  }
}
