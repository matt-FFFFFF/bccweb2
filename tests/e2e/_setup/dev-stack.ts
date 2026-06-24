import { spawn, type ChildProcess } from "node:child_process";

interface DevStackHandle {
  stop(): Promise<void>;
}

const API_HEALTH_URL = "http://localhost:7071/api/health";
const WEB_URL = process.env.E2E_BASE_URL ?? "http://localhost:5173";

export async function startDevStack(): Promise<DevStackHandle> {
  const processes: ChildProcess[] = [];
  await run("docker", ["compose", "up", "-d", "azurite", "azurite-init"]);
  processes.push(spawnManaged("npm", ["run", "start", "--workspace", "@bccweb/api"], {
    MOCK_ACS: "1",
    MOCK_PURETRACK: "1",
    JWT_SECRET: "e2e-dev-secret-at-least-32-characters",
    APP_URL: WEB_URL,
  }));
  processes.push(spawnManaged("npm", ["run", "dev", "--workspace", "@bccweb/web"]));
  await waitForUrl(API_HEALTH_URL, 60_000);
  await waitForUrl(WEB_URL, 60_000);
  return {
    async stop() {
      await Promise.all(processes.map(stopProcess));
      await run("docker", ["compose", "down"]);
    },
  };
}

function spawnManaged(command: string, args: string[], env: Record<string, string> = {}) {
  return spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: "inherit",
    shell: false,
  });
}

async function waitForUrl(url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      await delay(1_000);
    }
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function run(command: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", shell: false });
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited ${code}`)));
    child.on("error", reject);
  });
}

async function stopProcess(child: ChildProcess) {
  if (child.exitCode !== null || child.killed) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(5_000).then(() => {
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    }),
  ]);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
