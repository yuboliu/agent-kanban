import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { MachineRuntime } from "@agent-kanban/shared";
import type { Command } from "commander";
import lockfile from "proper-lockfile";
import { MachineClient } from "../client/machine.js";
import { getCredentials, saveCredentials, setCurrent } from "../config.js";
import { withoutControlPlaneSecrets } from "../controlPlaneEnv.js";
import { assertDaemonDependencies } from "../daemon/preflight.js";
import { DAEMON_STATE_FILE, LOGS_DIR, PID_FILE, SESSIONS_DIR, STATE_DIR } from "../paths.js";
import { getAvailableProviders } from "../providers/registry.js";
import { isPidAlive } from "../session/store.js";
import { getVersion } from "../version.js";

const MAX_LOG_ARCHIVES = 5;
const DEFAULT_MAX_CONCURRENT = 5;
const DEFAULT_POLL_INTERVAL = 10_000;
const DEFAULT_TASK_TIMEOUT = 7_200_000;
const MAX_CONCURRENT_LIMIT = 64;
const MIN_POLL_INTERVAL = 5_000;
const MAX_POLL_INTERVAL = 300_000;
const MIN_TASK_TIMEOUT = 1_000;
const MAX_TASK_TIMEOUT = 604_800_000;
const LOCAL_READY_TIMEOUT_MS = 30_000;

interface DaemonState {
  providers: string[];
  maxConcurrent: number;
  apiUrl: string;
  startedAt: string;
  pollInterval?: number;
  taskTimeout?: number;
  machineId?: string;
}

function boundedInteger(name: string, value: unknown, min: number, max: number, allowZero = false): number {
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || (allowZero && parsed === 0 ? false : parsed < min) || parsed > max) {
    const range = allowZero ? `0 or ${min}-${max}` : `${min}-${max}`;
    throw new Error(`${name} must be ${range}`);
  }
  return parsed;
}

export function parseLocalDaemonOptions(opts: Record<string, unknown>): {
  maxConcurrent: number;
  pollInterval: number;
  taskTimeout: number;
} {
  return {
    maxConcurrent: boundedInteger("--max-concurrent", opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT, 1, MAX_CONCURRENT_LIMIT),
    pollInterval: boundedInteger("--poll-interval", opts.pollInterval ?? DEFAULT_POLL_INTERVAL, MIN_POLL_INTERVAL, MAX_POLL_INTERVAL),
    taskTimeout: boundedInteger("--task-timeout", opts.taskTimeout ?? DEFAULT_TASK_TIMEOUT, MIN_TASK_TIMEOUT, MAX_TASK_TIMEOUT, true),
  };
}

function useEnvironmentCredentials(opts: Record<string, unknown>): void {
  if (!opts.apiUrl && process.env.AK_API_URL) opts.apiUrl = process.env.AK_API_URL;
  if (!opts.apiKey && process.env.AK_API_KEY) opts.apiKey = process.env.AK_API_KEY;
}

function rotateLogs(): void {
  mkdirSync(LOGS_DIR, { recursive: true });
  const logFile = join(LOGS_DIR, "daemon.log");
  if (!existsSync(logFile)) return;

  const now = new Date();
  const timestamp = now
    .toISOString()
    .replace(/:/g, "-")
    .replace(/\.\d+Z$/, "");
  renameSync(logFile, join(LOGS_DIR, `daemon-${timestamp}.log`));

  const archives = readdirSync(LOGS_DIR)
    .filter((f) => f.startsWith("daemon-") && f.endsWith(".log"))
    .sort();

  while (archives.length > MAX_LOG_ARCHIVES) {
    unlinkSync(join(LOGS_DIR, archives.shift()!));
  }
}

function readDaemonPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const raw = readFileSync(PID_FILE, "utf-8").trim();
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const pid = Number(raw);
  return isPidAlive(pid) ? pid : null;
}

interface DaemonStartReservation {
  commit(pid: number): void;
  release(committedPid?: number): void;
}

function pidOwner(raw: string): number | null {
  const value = raw.startsWith("starting:") ? raw.slice("starting:".length) : raw;
  if (!/^[1-9]\d*$/.test(value)) return null;
  const pid = Number(value);
  return Number.isSafeInteger(pid) ? pid : null;
}

function reclaimStalePidFile(expected: string): void {
  const quarantine = `${PID_FILE}.reclaim-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    renameSync(PID_FILE, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  let moved: string;
  try {
    moved = readFileSync(quarantine, "utf-8").trim();
  } catch (error) {
    try {
      unlinkSync(quarantine);
    } catch {
      /* preserve the original read error */
    }
    throw error;
  }
  if (moved !== expected) {
    // Another starter replaced the stale file between our observation and the
    // rename. Restore its marker only if the canonical path is still empty.
    // If somebody else already owns the path, the displaced starter will see
    // that it lost its marker and stop its child before it can persist.
    try {
      linkSync(quarantine, PID_FILE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  unlinkSync(quarantine);
}

/**
 * Reserve daemon startup before spawning. The old read-then-write PID flow
 * allowed concurrent starts, and an older daemon could later unlink a newer
 * daemon's PID file during shutdown. A parent-owned startup marker closes that
 * window; commit/release only mutate the marker they created.
 */
function reserveDaemonStart(): DaemonStartReservation {
  mkdirSync(STATE_DIR, { recursive: true });
  const marker = `starting:${process.pid}`;

  for (;;) {
    try {
      writeFileSync(PID_FILE, marker, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let existing: string;
      try {
        existing = readFileSync(PID_FILE, "utf-8").trim();
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw readError;
      }
      const owner = pidOwner(existing);
      if (owner !== null && isPidAlive(owner)) {
        throw new Error(`Runtime already running or starting (PID ${owner})`);
      }
      reclaimStalePidFile(existing);
    }
  }

  const ownsMarker = () => {
    try {
      return readFileSync(PID_FILE, "utf-8").trim() === marker;
    } catch {
      return false;
    }
  };

  return {
    commit(pid: number) {
      if (!ownsMarker()) throw new Error("Lost Machine runner startup reservation");
      writeFileSync(PID_FILE, String(pid), { mode: 0o600 });
    },
    release(committedPid?: number) {
      try {
        const current = readFileSync(PID_FILE, "utf-8").trim();
        if (current === marker || (committedPid !== undefined && current === String(committedPid))) unlinkSync(PID_FILE);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
  };
}

function readDaemonState(): DaemonState | null {
  try {
    return JSON.parse(readFileSync(DAEMON_STATE_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function formatUptime(startMs: number): string {
  const seconds = Math.floor((Date.now() - startMs) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);
  return parts.join(" ");
}

function formatProviders(all: string[]): string {
  if (all.length === 0) return "none";
  return all.join(", ");
}

function maskApiUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.host;
  } catch {
    return url;
  }
}

function machineRuntimes(): MachineRuntime[] {
  const providers = getAvailableProviders();
  if (providers.length === 0) throw new Error("No local runtime provider is available");
  const checkedAt = new Date().toISOString();
  return providers.map((provider) => ({ name: provider.name, status: "ready", checked_at: checkedAt }));
}

async function _waitForSpawn(child: ReturnType<typeof spawn>, runnerBin: string): Promise<number> {
  return await new Promise((resolve, reject) => {
    if (typeof child.once !== "function") {
      if (typeof child.pid === "number") resolve(child.pid);
      else reject(new Error(`Machine runner did not report a process id: ${runnerBin}`));
      return;
    }
    let settled = false;
    child.once("spawn", () => {
      settled = true;
      if (typeof child.pid === "number") {
        resolve(child.pid);
        return;
      }
      reject(new Error(`Machine runner did not report a process id: ${runnerBin}`));
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (error.code === "ENOENT") {
        reject(new Error(`Machine runner executable not found: ${runnerBin}`));
        return;
      }
      reject(error);
    });
  });
}

async function waitForLocalReady(child: ReturnType<typeof spawn>): Promise<{ machineId: string; pid: number }> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    let terminating = false;
    const cleanup = () => {
      clearTimeout(timeout);
      child.removeListener("message", onMessage);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
    };
    const finish = (error: Error | null, machineId?: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        reject(error);
        return;
      }
      if (typeof child.pid !== "number" || !machineId) {
        reject(new Error("Local machine runner reported readiness without a process or machine id"));
        return;
      }
      if (child.connected) child.disconnect();
      resolve({ machineId, pid: child.pid });
    };
    const onMessage = (message: unknown) => {
      const ready = message as { type?: unknown; machineId?: unknown };
      if (ready?.type === "ready" && typeof ready.machineId === "string" && ready.machineId) finish(null, ready.machineId);
    };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (terminating) return;
      finish(new Error(`Local machine runner exited before readiness (code ${code ?? "none"}, signal ${signal ?? "none"})`));
    };
    const timeout = setTimeout(() => {
      void (async () => {
        terminating = true;
        try {
          if (typeof child.pid === "number") await stopRunner(child.pid);
          if (child.connected) child.disconnect();
          finish(new Error(`Local machine runner did not become ready within ${LOCAL_READY_TIMEOUT_MS / 1000}s; inspect ak logs`));
        } catch (error) {
          finish(new Error(`Failed to terminate unready local machine runner: ${error instanceof Error ? error.message : String(error)}`));
        }
      })();
    }, LOCAL_READY_TIMEOUT_MS);
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function withStartupLock<T>(operation: () => Promise<T>): Promise<T> {
  mkdirSync(STATE_DIR, { recursive: true });
  const release = await lockfile.lock(PID_FILE, {
    realpath: false,
    stale: 30_000,
    update: 10_000,
    retries: { retries: 20, minTimeout: 50, maxTimeout: 250 },
  });
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function startLocalDaemon(opts: Record<string, unknown>) {
  assertDaemonDependencies();
  const parsed = parseLocalDaemonOptions(opts);
  await withStartupLock(() => startPreparedLocalDaemon(opts, parsed));
}

async function startPreparedLocalDaemon(opts: Record<string, unknown>, parsed: { maxConcurrent: number; pollInterval: number; taskTimeout: number }) {
  const existingPid = readDaemonPid();
  if (existingPid) {
    console.error(`Runtime already running (PID ${existingPid}). Stop it first or remove ${PID_FILE}`);
    process.exit(1);
  }
  rotateLogs();

  const { maxConcurrent, pollInterval, taskTimeout } = parsed;
  const logFile = join(LOGS_DIR, "daemon.log");
  const logFd = openSync(logFile, "a");
  let reservation: DaemonStartReservation | null = null;
  let child: ReturnType<typeof spawn> | null = null;
  let ready: { machineId: string; pid: number } | null = null;
  let state: DaemonState | null = null;
  try {
    reservation = reserveDaemonStart();
    child = spawn(
      process.execPath,
      [
        process.argv[1],
        "__daemon",
        "--max-concurrent",
        String(maxConcurrent),
        "--poll-interval",
        String(pollInterval),
        "--task-timeout",
        String(taskTimeout),
      ],
      {
        detached: true,
        stdio: ["ignore", logFd, logFd, "ipc"],
        windowsHide: true,
        env: withoutControlPlaneSecrets(process.env),
      },
    );
    ready = await waitForLocalReady(child);
    reservation.commit(ready.pid);
    state = {
      providers: Array.isArray(opts.providers) ? (opts.providers as string[]) : machineRuntimes().map((runtime) => runtime.name),
      maxConcurrent,
      pollInterval,
      taskTimeout,
      apiUrl: opts.apiUrl as string,
      startedAt: new Date().toISOString(),
      machineId: ready.machineId,
    };
    writeFileSync(DAEMON_STATE_FILE, JSON.stringify(state, null, 2));
    child.unref();
  } catch (error) {
    const childPid = ready?.pid ?? child?.pid;
    if (typeof childPid === "number" && isPidAlive(childPid)) await stopRunner(childPid);
    reservation?.release(childPid);
    throw error;
  } finally {
    closeSync(logFd);
  }
  if (ready === null || state === null) throw new Error("Local machine runner startup completed without state");

  const timeoutLabel = taskTimeout === 0 ? "none" : `${taskTimeout / 1000}s`;
  console.log(`● Local machine runner started (PID ${ready.pid}, v${getVersion()})`);
  console.log(`  Machine:     ${ready.machineId}`);
  console.log(`  Providers:   ${formatProviders(state.providers)}`);
  console.log(`  Concurrency: ${maxConcurrent}`);
  console.log(`  Poll:        ${pollInterval / 1000}s`);
  console.log(`  Timeout:     ${timeoutLabel}`);
  console.log(`  API:         ${maskApiUrl(state.apiUrl)}`);
  console.log(`  Logs:        ${logFile}`);
}

async function startRunner(opts: Record<string, unknown>): Promise<void> {
  await startLocalDaemon(opts);
}

export function registerStartCommand(program: Command) {
  program
    .command("start")
    .description("Start the local Machine runner")
    .option("--api-url <url>", "API server URL")
    .option("--api-key <key>", "AK API key")
    .option("--max-concurrent <n>", `Max concurrent agents (1-${MAX_CONCURRENT_LIMIT})`, String(DEFAULT_MAX_CONCURRENT))
    .option("--poll-interval <ms>", `Local task poll interval (${MIN_POLL_INTERVAL}-${MAX_POLL_INTERVAL} ms)`, String(DEFAULT_POLL_INTERVAL))
    .option("--task-timeout <ms>", `Local task timeout (0 or ${MIN_TASK_TIMEOUT}-${MAX_TASK_TIMEOUT} ms)`, String(DEFAULT_TASK_TIMEOUT))
    .action(async (opts) => {
      useEnvironmentCredentials(opts);
      // Save or resolve credentials
      if (opts.apiUrl && opts.apiKey) {
        saveCredentials(opts.apiUrl, opts.apiKey);
      } else if (opts.apiUrl) {
        // Switch to existing credentials for this host
        try {
          setCurrent(opts.apiUrl);
        } catch {
          console.error(`No saved credentials for ${opts.apiUrl}. Pass --api-key as well.`);
          process.exit(1);
        }
      }

      let creds: { apiUrl: string; apiKey: string };
      try {
        creds = getCredentials();
      } catch {
        console.error("API URL and key required. Pass --api-url and --api-key.");
        process.exit(1);
      }

      // Clear session cache if API URL changed. Sessions are backend-specific
      // and must not survive environment switches. Identities are now scoped
      // by api-url + machine + runtime, so they remain valid side by side.
      const prevState = readDaemonState();
      if (prevState && prevState.apiUrl !== creds.apiUrl) {
        rmSync(SESSIONS_DIR, { recursive: true, force: true });
      }
      await startRunner({ ...opts, apiUrl: creds.apiUrl, apiKey: creds.apiKey });
    });
}

export function registerLocalStartCommand(program: Command) {
  program
    .command("local_start")
    .description(
      "Start the local Machine runner for service managers (idempotent, non-interactive). " +
        "Skips when already running. Uses saved credentials; never prompts. " +
        "Intended for service_runner.sh / systemd, not day-to-day use.",
    )
    .option("--api-url <url>", "API server URL (defaults to AK_API_URL or the saved current credential)")
    .option("--max-concurrent <n>", `Max concurrent agents (1-${MAX_CONCURRENT_LIMIT})`, String(DEFAULT_MAX_CONCURRENT))
    .option("--poll-interval <ms>", `Local task poll interval (${MIN_POLL_INTERVAL}-${MAX_POLL_INTERVAL} ms)`, String(DEFAULT_POLL_INTERVAL))
    .option("--task-timeout <ms>", `Local task timeout (0 or ${MIN_TASK_TIMEOUT}-${MAX_TASK_TIMEOUT} ms)`, String(DEFAULT_TASK_TIMEOUT))
    .action(async (opts) => {
      if (readDaemonPid()) {
        console.log("○ Machine runner already running — nothing to do.");
        return;
      }

      const apiUrl =
        (typeof opts.apiUrl === "string" && opts.apiUrl) ||
        process.env.AK_API_URL ||
        (() => {
          try {
            return getCredentials().apiUrl;
          } catch {
            return null;
          }
        })();

      if (apiUrl) {
        try {
          setCurrent(apiUrl);
        } catch {
          console.error(
            `No saved credentials for ${apiUrl}. Pass AK_API_KEY and run \`ak start\` once, or use \`ak start --api-url ${apiUrl} --api-key <key>\`.`,
          );
          process.exit(1);
        }
      }

      let creds: { apiUrl: string; apiKey: string };
      try {
        creds = getCredentials();
      } catch {
        console.error("No saved API credentials. Run `ak start --api-url <url> --api-key <key>` once to store them, then re-run `ak local_start`.");
        process.exit(1);
      }

      await startRunner({ ...opts, apiUrl: creds.apiUrl, apiKey: creds.apiKey });
    });
}

export function registerStopCommand(program: Command) {
  program
    .command("stop")
    .description("Stop the Machine runner")
    .action(async () => {
      const pid = readDaemonPid();
      if (!pid) {
        console.log("○ Machine runner is not running");
        return;
      }

      let uptimeStr = "";
      const state = readDaemonState();
      if (state?.startedAt) {
        uptimeStr = formatUptime(new Date(state.startedAt).getTime());
      }

      const forceKilled = await stopRunner(pid);
      if (forceKilled) {
        console.log(`● Machine runner force-killed (PID ${pid}, SIGTERM timed out)`);
      } else {
        console.log(`● Machine runner stopped (PID ${pid})`);
      }
      if (uptimeStr) console.log(`  Uptime: ${uptimeStr}`);
    });
}

export function registerStatusCommand(program: Command) {
  program
    .command("status")
    .description("Show Machine runner status")
    .action(async () => {
      const pid = readDaemonPid();
      if (!pid) {
        console.log("○ Machine runner is not running");
        return;
      }

      const state = readDaemonState();

      let uptimeStr = "";
      if (state?.startedAt) {
        uptimeStr = formatUptime(new Date(state.startedAt).getTime());
      } else {
        try {
          uptimeStr = formatUptime(statSync(PID_FILE).mtimeMs);
        } catch {
          /* skip */
        }
      }

      console.log(`● Machine runner running (PID ${pid}, v${getVersion()})`);
      if (uptimeStr) console.log(`  Uptime:      ${uptimeStr}`);
      if (state) {
        const providersLabel = formatProviders(state.providers ?? []);
        console.log(`  Providers:   ${providersLabel}`);
        console.log(`  Concurrency: ${state.maxConcurrent}`);
        console.log(`  API:         ${maskApiUrl(state.apiUrl)}`);
      }

      // The runner reports to the server, not local stdout — surface its real
      // health (a live local process does not imply it is heartbeating).
      if (state?.machineId) {
        try {
          const machine = await new MachineClient().getMachine(state.machineId);
          const online = machine.status === "online";
          const heartbeat = machine.last_heartbeat_at ? ` (heartbeat ${formatUptime(new Date(machine.last_heartbeat_at).getTime())} ago)` : "";
          console.log(`  Runner:      ${online ? "●" : "○"} ${machine.status ?? "unknown"}${heartbeat}`);
          const ready = (machine.runtimes ?? []).filter((runtime) => runtime.status === "ready").map((runtime) => runtime.name);
          if (ready.length > 0) console.log(`  Runtimes:    ${ready.join(", ")}`);
        } catch (error) {
          console.log(`  Runner:      (could not reach AK API: ${error instanceof Error ? error.message : String(error)})`);
        }
      }
    });
}

export function registerRestartCommand(program: Command) {
  program
    .command("restart")
    .description("Restart the Machine runner")
    .option("--api-url <url>", "API server URL")
    .option("--api-key <key>", "AK API key")
    .option("--max-concurrent <n>", `Max concurrent agents (1-${MAX_CONCURRENT_LIMIT})`)
    .option("--poll-interval <ms>", `Local task poll interval (${MIN_POLL_INTERVAL}-${MAX_POLL_INTERVAL} ms)`)
    .option("--task-timeout <ms>", `Local task timeout (0 or ${MIN_TASK_TIMEOUT}-${MAX_TASK_TIMEOUT} ms)`)
    .action(async (opts) => {
      useEnvironmentCredentials(opts);
      const prevState = readDaemonState();
      const localOptions = parseLocalDaemonOptions({
        maxConcurrent: opts.maxConcurrent ?? prevState?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
        pollInterval: opts.pollInterval ?? prevState?.pollInterval ?? DEFAULT_POLL_INTERVAL,
        taskTimeout: opts.taskTimeout ?? prevState?.taskTimeout ?? DEFAULT_TASK_TIMEOUT,
      });

      if (opts.apiUrl && opts.apiKey) {
        saveCredentials(opts.apiUrl, opts.apiKey);
      } else if (opts.apiUrl) {
        try {
          setCurrent(opts.apiUrl);
        } catch {
          console.error(`No saved credentials for ${opts.apiUrl}. Pass --api-key as well.`);
          process.exit(1);
        }
      }

      let creds: { apiUrl: string; apiKey: string };
      try {
        creds = getCredentials();
      } catch {
        console.error("API URL and key required. Pass --api-url and --api-key, or run `ak start` first.");
        process.exit(1);
      }

      // Only stop a healthy runner after all replacement settings and
      // credentials have been validated. A typo must not cause an outage.
      const pid = readDaemonPid();
      if (pid) {
        const forceKilled = await stopRunner(pid);
        if (forceKilled) {
          console.log(`● Machine runner force-killed (PID ${pid})`);
        } else {
          console.log(`● Machine runner stopped (PID ${pid})`);
        }
      } else {
        console.log("○ Machine runner was not running");
      }

      // Clear session cache if API URL changed
      if (prevState && prevState.apiUrl !== creds.apiUrl) {
        rmSync(SESSIONS_DIR, { recursive: true, force: true });
      }
      await startRunner({
        ...opts,
        apiUrl: creds.apiUrl,
        apiKey: creds.apiKey,
        ...localOptions,
      });
    });
}

const LOG_DIVIDER = "\n──────────────────────── daemon restarted ────────────────────────\n\n";
const FOLLOW_POLL_MS = 500;

async function stopRunner(pid: number): Promise<boolean> {
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") throw new Error(`Cannot stop Machine runner PID ${pid}: permission denied`);
    throw error;
  }

  const deadline = Date.now() + 10_000;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  while (Date.now() < deadline && isPidAlive(pid)) await sleep(200);
  if (!isPidAlive(pid)) return false;

  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      throw new Error(`Cannot force-stop Machine runner PID ${pid}: permission denied`);
    }
    throw error;
  }
  const killDeadline = Date.now() + 2_000;
  while (Date.now() < killDeadline && isPidAlive(pid)) await sleep(50);
  if (isPidAlive(pid)) throw new Error(`Machine runner PID ${pid} remained alive after SIGKILL`);
  return true;
}

export function readLastLogLines(logFile: string, lineCount: number): string {
  if (!Number.isInteger(lineCount) || lineCount < 0) throw new Error("--lines must be a non-negative integer");
  if (lineCount === 0) return "";
  const fd = openSync(logFile, "r");
  try {
    const size = fstatSync(fd).size;
    let position = size;
    let newlineCount = 0;
    const chunks: Buffer[] = [];
    while (position > 0 && newlineCount <= lineCount) {
      const length = Math.min(64 * 1024, position);
      position -= length;
      const chunk = Buffer.allocUnsafe(length);
      let bytesRead = 0;
      while (bytesRead < length) {
        const count = readSync(fd, chunk, bytesRead, length - bytesRead, position + bytesRead);
        if (count === 0) break;
        bytesRead += count;
      }
      if (bytesRead < length) throw new Error(`Could not read ${logFile}`);
      chunks.unshift(chunk);
      for (const byte of chunk) if (byte === 10) newlineCount++;
    }
    const content = Buffer.concat(chunks).toString("utf-8");
    const trailingNewline = content.endsWith("\n");
    const lines = content.split("\n");
    if (trailingNewline) lines.pop();
    const selected = lines.slice(-lineCount).join("\n");
    return selected ? `${selected}${trailingNewline ? "\n" : ""}` : "";
  } finally {
    closeSync(fd);
  }
}

function followLogFile(logFile: string): void {
  let currentIdentity: string | null = null;
  let currentOffset = 0;

  // Initialise inode/offset from current file end
  try {
    const stat = statSync(logFile);
    currentIdentity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    currentOffset = stat.size;
  } catch {
    // File may not exist yet; will pick it up on first poll
  }

  const poll = (): void => {
    try {
      const stat = statSync(logFile);
      const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;

      if (currentIdentity !== null && (identity !== currentIdentity || stat.size < currentOffset)) {
        // File was rotated — new daemon.log created
        process.stdout.write(LOG_DIVIDER);
        currentOffset = 0;
      }

      currentIdentity = identity;

      if (stat.size > currentOffset) {
        const fd = openSync(logFile, "r");
        try {
          const size = fstatSync(fd).size;
          if (size < currentOffset) {
            currentOffset = 0;
          }
          const buf = Buffer.alloc(size - currentOffset);
          let bytesRead = 0;
          while (bytesRead < buf.length) {
            const count = readSync(fd, buf, bytesRead, buf.length - bytesRead, currentOffset + bytesRead);
            if (count === 0) break;
            bytesRead += count;
          }
          if (bytesRead > 0) process.stdout.write(buf.subarray(0, bytesRead));
          currentOffset += bytesRead;
        } finally {
          closeSync(fd);
        }
      }
    } catch {
      // File temporarily absent during rotation — retry next tick
    }
  };

  const timer = setInterval(poll, FOLLOW_POLL_MS);
  process.on("SIGINT", () => {
    clearInterval(timer);
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    clearInterval(timer);
    process.exit(0);
  });
}

export function registerLogsCommand(program: Command) {
  program
    .command("logs")
    .description("Show local runtime logs")
    .option("--lines <n>", "Number of lines to show", "50")
    .option("-f, --follow", "Stream new log lines as they appear")
    .action((opts) => {
      const logFile = join(LOGS_DIR, "daemon.log");
      if (!existsSync(logFile)) {
        console.log("No daemon logs found");
        return;
      }

      if (opts.follow) {
        const lines = Number(opts.lines);
        process.stdout.write(readLastLogLines(logFile, lines));
        followLogFile(logFile);
      } else {
        process.stdout.write(readLastLogLines(logFile, Number(opts.lines)));
      }
    });
}
