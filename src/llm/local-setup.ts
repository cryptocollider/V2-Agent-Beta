import { spawn } from "node:child_process";
import { arch, cpus, platform, totalmem } from "node:os";
import { autoDetectLocalManagerProvider, type ManagerLlmDetectedProvider } from "./autodetect.js";

export type ManagerLocalSetupOption = {
  planId: string;
  label: string;
  providerId: "ollama" | "local";
  model: string;
  endpointUrl: string;
  defaultPort: number;
  description: string;
  autoSetupSupported: boolean;
  installHint: string;
};

export type ManagerLocalSetupPlan = {
  machine: {
    platform: NodeJS.Platform;
    arch: string;
    cpuCount: number;
    totalMemoryGb: number;
  };
  recommendedPlanId: string;
  options: ManagerLocalSetupOption[];
  note: string;
};

export type LocalSetupBuildOptions = {
  platform?: NodeJS.Platform;
  arch?: string;
  cpuCount?: number;
  totalMemoryBytes?: number;
};

export type ManagerLocalSetupExecution = {
  ok: boolean;
  message: string;
  steps: string[];
  detected: ManagerLlmDetectedProvider | null;
  option: ManagerLocalSetupOption;
  error: string | null;
};

type CommandResult = {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
};

export function recommendOllamaModelForMemory(totalMemoryBytes = totalmem()): string {
  const gb = totalMemoryBytes / (1024 ** 3);
  if (gb >= 28) return "qwen3:8b";
  if (gb >= 16) return "qwen3:4b";
  return "qwen3:1.7b";
}

export function buildLocalManagerSetupPlan(options: LocalSetupBuildOptions = {}): ManagerLocalSetupPlan {
  const currentPlatform = options.platform ?? platform();
  const currentArch = options.arch ?? arch();
  const currentCpuCount = options.cpuCount ?? cpus().length;
  const currentMemoryBytes = options.totalMemoryBytes ?? totalmem();
  const ollamaModel = recommendOllamaModelForMemory(currentMemoryBytes);
  const autoSetupSupported = currentPlatform === "win32" || currentPlatform === "darwin";
  return {
    machine: {
      platform: currentPlatform,
      arch: currentArch,
      cpuCount: currentCpuCount,
      totalMemoryGb: Math.round((currentMemoryBytes / (1024 ** 3)) * 10) / 10,
    },
    recommendedPlanId: "ollama",
    options: [
      {
        planId: "ollama",
        label: "Ollama",
        providerId: "ollama",
        model: ollamaModel,
        endpointUrl: "http://127.0.0.1:11434/api/chat",
        defaultPort: 11434,
        description: "Standalone local manager runtime. Agent 1 checks this port first and can auto-setup this route on supported desktop machines.",
        autoSetupSupported,
        installHint: currentPlatform === "win32"
          ? "Uses winget to install Ollama, then pulls a recommended Qwen model."
          : currentPlatform === "darwin"
            ? "Uses Homebrew to install Ollama, then pulls a recommended Qwen model."
            : "Linux currently gets a guided manual path rather than an automatic installer.",
      },
      {
        planId: "local-1234",
        label: "LM Studio / Local OpenAI API",
        providerId: "local",
        model: "local-model",
        endpointUrl: "http://127.0.0.1:1234/v1/chat/completions",
        defaultPort: 1234,
        description: "OpenAI-compatible local gateway for LM Studio, llama.cpp, and similar desktop runtimes.",
        autoSetupSupported: false,
        installHint: "Start your local gateway on port 1234, then use Auto Connect Local AI again.",
      },
      {
        planId: "local-8000",
        label: "vLLM / TGI / self-hosted OpenAI API",
        providerId: "local",
        model: "local-model",
        endpointUrl: "http://127.0.0.1:8000/v1/chat/completions",
        defaultPort: 8000,
        description: "OpenAI-compatible endpoint for heavier local or LAN runtimes.",
        autoSetupSupported: false,
        installHint: "Run the local gateway on port 8000, then let Agent 1 auto-connect it.",
      },
    ],
    note: "Auto Connect checks the default local manager ports first. If none respond, Agent 1 can offer the Ollama setup path on supported desktops. Qwen is the default pull today because it is the safest lightweight standalone manager path; DeepSeek-compatible local gateways still work through the generic Local provider.",
  };
}

function trimCommandLogs(result: CommandResult): string {
  const text = String(result.stderr || result.stdout || result.error || "").trim();
  return text ? text.split(/\r?\n/).slice(-4).join(" | ") : "No extra process logs were captured.";
}

async function runCommand(command: string, args: string[], timeoutMs = 60_000): Promise<CommandResult> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: string[] = [];
    const stderr: string[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ ok: false, code: null, stdout: stdout.join(""), stderr: stderr.join(""), error: `Timed out after ${timeoutMs}ms.` });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout: stdout.join(""), stderr: stderr.join(""), error: String(err) });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout: stdout.join(""), stderr: stderr.join(""), error: code === 0 ? null : `Exit code ${code}.` });
    });
  });
}

async function commandExists(command: string): Promise<boolean> {
  const probe = process.platform === "win32"
    ? await runCommand("where", [command], 10_000)
    : await runCommand("which", [command], 10_000);
  return probe.ok;
}

function spawnDetached(command: string, args: string[]): boolean {
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function waitForOllama(timeoutMs = 20_000): Promise<ManagerLlmDetectedProvider | null> {
  const started = Date.now();
  while ((Date.now() - started) < timeoutMs) {
    const detection = await autoDetectLocalManagerProvider("ollama");
    if (detection.selected?.providerId === "ollama") return detection.selected;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return null;
}

export async function autoSetupLocalManagerRuntime(planId = "ollama"): Promise<ManagerLocalSetupExecution> {
  const plan = buildLocalManagerSetupPlan();
  const option = plan.options.find((entry) => entry.planId === planId) ?? plan.options[0]!;
  const fail = (message: string, steps: string[]): ManagerLocalSetupExecution => ({ ok: false, message, steps, detected: null, option, error: message });
  if (option.planId !== "ollama") return fail(`${option.label} is a guided manual local path right now. Start it on port ${option.defaultPort} and then use Auto Connect Local AI.`, [`Preferred runtime: ${option.label}.`]);
  const steps: string[] = [`Selected ${option.label} with ${option.model}.`];
  let hasOllama = await commandExists("ollama");
  if (!hasOllama) {
    steps.push("Ollama is not installed yet. Agent 1 is trying the standard desktop installer path.");
    if (process.platform === "win32") {
      if (!(await commandExists("winget"))) return fail("winget is not available, so Agent 1 cannot auto-install Ollama on this Windows machine. Install Ollama once, then retry Auto Connect Local AI.", steps);
      const install = await runCommand("winget", ["install", "-e", "--id", "Ollama.Ollama", "--accept-package-agreements", "--accept-source-agreements", "--silent"], 25 * 60_000);
      if (!install.ok) return fail(`Ollama installation failed. ${trimCommandLogs(install)}`, [...steps, "winget install did not complete cleanly."]);
    } else if (process.platform === "darwin") {
      if (!(await commandExists("brew"))) return fail("Homebrew is not available, so Agent 1 cannot auto-install Ollama on this Mac yet. Install Ollama once, then retry Auto Connect Local AI.", steps);
      const install = await runCommand("brew", ["install", "ollama"], 25 * 60_000);
      if (!install.ok) return fail(`Ollama installation failed. ${trimCommandLogs(install)}`, [...steps, "brew install did not complete cleanly."]);
    } else {
      return fail("Automatic local-model setup is currently implemented for Windows and macOS only. Start Ollama or another local OpenAI-compatible runtime manually, then retry Auto Connect Local AI.", steps);
    }
    hasOllama = await commandExists("ollama");
    if (!hasOllama) return fail("Ollama install finished without exposing the ollama command in PATH yet. Start Ollama once, then retry Auto Connect Local AI.", steps);
  }
  let detected = await waitForOllama(6_000);
  if (!detected) {
    steps.push("Trying to start the Ollama background service on port 11434.");
    spawnDetached("ollama", ["serve"]);
    detected = await waitForOllama(25_000);
  }
  if (!detected) return fail("Ollama is installed, but Agent 1 still cannot reach port 11434. Start Ollama once, then retry Auto Connect Local AI.", steps);
  steps.push(`Pulling recommended model ${option.model}. This can take a while on first run.`);
  const pull = await runCommand("ollama", ["pull", option.model], 45 * 60_000);
  if (!pull.ok) return fail(`Ollama is running, but the model pull failed. ${trimCommandLogs(pull)}`, steps);
  const refreshed = await waitForOllama(6_000);
  return {
    ok: true,
    message: `Ollama is ready with ${option.model}. Agent 1 can now save the local manager connection automatically.`,
    steps,
    detected: refreshed ?? detected,
    option,
    error: null,
  };
}
