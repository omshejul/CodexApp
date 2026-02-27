import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { ChildProcess, execFileSync, spawn } from "node:child_process";

const TAILSCALE_SERVICE_NAME = "codexgateway";
const SYSTEMD_UNIT_NAME = "com.codex.gateway.service";
const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";

interface LinuxAppConfig {
  port: number;
  environment: Record<string, string>;
  pairURL: string;
  codexBinaryPath: string | null;
  tailscaleBinaryPath: string | null;
  autoStart: boolean;
}

interface PairedDevice {
  id: string;
  deviceId: string;
  deviceName: string;
  createdAt: number;
  expiresAt: number;
}

interface DevicesResponse {
  devices: PairedDevice[];
}

interface PairCreateResponse {
  pairId: string;
  code: string;
  expiresAt: string;
  pairingUrl: string;
}

interface PortListener {
  pid: number;
  command: string;
  isManagedGateway: boolean;
}

interface SetupDiagnostics {
  gatewayBuildReady: boolean;
  codexReady: boolean;
  tailscaleAvailable: boolean;
  tailscaleAuthenticated: boolean;
  serveConfigured: boolean;
  portListener: PortListener | null;
}

interface CommandResult {
  exitCode: number;
  output: string;
}

class LinuxGatewayManager {
  public config: LinuxAppConfig;
  public isRunning = false;
  public isStarting = false;
  public isStopping = false;
  public isFixingSetup = false;
  public isLoadingDevices = false;
  public conflictingPID: number | null = null;
  public statusMessage = "Idle";
  public outputLines: string[] = [];
  public pairedDevices: PairedDevice[] = [];
  public usingSystemd = false;

  private readonly gatewayRoot = path.resolve(__dirname, "..");
  private readonly gatewayEntryPath = path.resolve(this.gatewayRoot, "dist/server.js");
  private readonly configDir = path.join(os.homedir(), ".codex-gateway");
  private readonly configPath = path.join(this.configDir, "config.json");
  private readonly legacyConfigPath = path.join(os.homedir(), ".codex-gateway-menu/config.json");
  private readonly systemdUserDir = path.join(os.homedir(), ".config/systemd/user");
  private readonly systemdUnitPath = path.join(this.systemdUserDir, SYSTEMD_UNIT_NAME);
  private readonly appDataDir = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share"), "CodexGateway");
  private readonly logsDir = path.join(this.appDataDir, "logs");

  private didConfigureServeRouteThisSession = false;
  private didConfigureLegacyServeRouteThisSession = false;
  private directProcess: ChildProcess | null = null;

  constructor() {
    this.config = this.loadConfig();
    this.usingSystemd = this.isSystemdUserAvailable();
    this.refreshSetupStatus();
  }

  public refreshSetupStatus() {
    const diagnostics = this.diagnoseSetup(false);

    if (!diagnostics.gatewayBuildReady) {
      this.isRunning = false;
      this.conflictingPID = null;
      this.statusMessage = "Needs setup: gateway is not built (missing dist/server.js).";
      return;
    }

    if (!diagnostics.codexReady) {
      this.isRunning = false;
      this.conflictingPID = null;
      this.statusMessage = "Missing Codex CLI";
      return;
    }

    if (diagnostics.portListener) {
      if (diagnostics.portListener.isManagedGateway) {
        this.isRunning = true;
        this.conflictingPID = null;
        this.statusMessage = "Running";
        return;
      }
      this.isRunning = false;
      this.conflictingPID = diagnostics.portListener.pid;
      this.statusMessage = `Port ${this.configuredPort()} is already in use (PID ${diagnostics.portListener.pid}).`;
      return;
    }

    this.isRunning = false;
    this.conflictingPID = null;
    this.statusMessage = "Ready";
  }

  public async start() {
    if (this.isStarting || this.isRunning) {
      return;
    }

    this.isStarting = true;
    this.statusMessage = "Starting...";

    try {
      const diagnostics = this.diagnoseSetup(true);
      this.conflictingPID = null;

      if (!diagnostics.gatewayBuildReady) {
        this.statusMessage = "Missing build output.";
        this.appendOutput("gateway/dist/server.js not found. Run: bun run build:gateway");
        return;
      }

      if (!diagnostics.codexReady) {
        this.statusMessage = "Missing Codex CLI.";
        this.appendOutput("Codex CLI not found. Install Codex and retry Start.");
        return;
      }

      if (!diagnostics.tailscaleAvailable) {
        this.statusMessage = "Missing Tailscale.";
        this.appendOutput("Tailscale CLI not found. Install Tailscale and retry Start.");
        return;
      }

      if (!diagnostics.tailscaleAuthenticated) {
        this.statusMessage = "Tailscale not authenticated.";
        this.appendOutput("Run `tailscale up` (or sign in) and retry Start.");
        return;
      }

      if (diagnostics.portListener) {
        if (diagnostics.portListener.isManagedGateway) {
          this.isRunning = true;
          this.statusMessage = "Running";
          this.appendOutput(
            `Gateway is already running on 127.0.0.1:${this.configuredPort()} (PID ${diagnostics.portListener.pid}).`
          );
          await this.refreshPairedDevices();
          return;
        }

        this.conflictingPID = diagnostics.portListener.pid;
        this.statusMessage = `Port ${this.configuredPort()} is already in use.`;
        this.appendOutput(
          `Another process is already using 127.0.0.1:${this.configuredPort()} (PID ${diagnostics.portListener.pid}).`
        );
        this.appendOutput(`Command: ${diagnostics.portListener.command}`);
        this.appendOutput("Action: stop the other process, or change the gateway port.");
        return;
      }

      this.ensureAppDataDirectories();
      this.ensureTailscaleServeRoutesToGateway(this.configuredPort());

      if (this.usingSystemd) {
        const started = this.upsertAndStartSystemdUnit(this.configuredPort());
        if (!started) {
          this.statusMessage = "Start failed. Check details.";
          return;
        }
      } else {
        const started = this.startDirectProcess(this.configuredPort());
        if (!started) {
          this.statusMessage = "Start failed. Check details.";
          return;
        }
      }

      const reachable = await this.waitForGatewayReachable(this.configuredPort(), 8);
      if (!reachable) {
        this.isRunning = false;
        this.statusMessage = "Start timed out. Check logs.";
        this.appendOutput(`Gateway started but /health was not reachable on 127.0.0.1:${this.configuredPort()}.`);
        return;
      }

      this.isRunning = true;
      this.statusMessage = "Running";
      this.appendOutput(this.usingSystemd ? "Gateway service is running under systemd --user." : "Gateway process is running.");
      await this.refreshPairedDevices();
    } finally {
      this.isStarting = false;
    }
  }

  public stop() {
    if (this.isStopping) {
      return;
    }

    this.isStopping = true;
    this.statusMessage = "Stopping...";

    try {
      if (this.usingSystemd) {
        const stop = this.runCommand("systemctl", ["--user", "stop", SYSTEMD_UNIT_NAME]);
        if (stop.exitCode !== 0 && !stop.output.includes("not loaded")) {
          this.appendOutput(`Failed to stop ${SYSTEMD_UNIT_NAME}`);
          this.appendOutput(stop.output);
        }
      } else if (this.directProcess) {
        this.directProcess.kill("SIGTERM");
        this.directProcess = null;
      }

      this.disableTailscaleServeIfManagedByApp();
      this.isRunning = false;
      this.conflictingPID = null;
      this.refreshSetupStatus();
      this.appendOutput("Gateway stopped.");
    } finally {
      this.isStopping = false;
    }
  }

  public async fixSetup() {
    if (this.isFixingSetup) {
      return;
    }

    this.isFixingSetup = true;

    try {
      this.appendOutput("Running setup checks...");

      const nextConfig = this.cloneConfig();
      nextConfig.environment.PATH = this.buildRuntimePATH(nextConfig.environment.PATH);

      const trimmedPublicBase = (nextConfig.environment.PUBLIC_BASE_URL || "").trim();
      if (!trimmedPublicBase) {
        const detected = this.discoverTailscaleMagicBaseURL(nextConfig.environment);
        if (detected) {
          nextConfig.environment.PUBLIC_BASE_URL = detected;
          this.appendOutput(`Auto-filled Public Base URL from Tailscale: ${detected}`);
        } else {
          this.appendOutput("Could not auto-detect Tailscale Magic DNS URL.");
        }
      }

      if (!nextConfig.codexBinaryPath) {
        const codexPath = this.resolveExecutablePath("codex", nextConfig.environment);
        if (codexPath) {
          nextConfig.codexBinaryPath = codexPath;
          this.appendOutput(`Configured Codex CLI path: ${codexPath}`);
        }
      }

      if (!nextConfig.tailscaleBinaryPath) {
        const tailscalePath = this.resolveExecutablePath("tailscale", nextConfig.environment);
        if (tailscalePath) {
          nextConfig.tailscaleBinaryPath = tailscalePath;
          this.appendOutput(`Configured Tailscale CLI path: ${tailscalePath}`);
        }
      }

      this.config = this.normalizeConfig(nextConfig);
      this.saveConfigToDisk(this.config);

      if (this.ensureTailscaleServeRoutesToGateway(this.config.port)) {
        this.appendOutput(`Tailscale service route '${TAILSCALE_SERVICE_NAME}' is configured.`);
      }

      const diagnostics = this.diagnoseSetup(true);
      this.conflictingPID = diagnostics.portListener && !diagnostics.portListener.isManagedGateway ? diagnostics.portListener.pid : null;

      if (diagnostics.gatewayBuildReady && diagnostics.codexReady) {
        this.statusMessage = "Setup complete. Use `start`.";
        this.appendOutput("Setup complete.");
      } else {
        this.refreshSetupStatus();
        this.appendOutput("Setup finished with remaining checks. See status above.");
      }
    } finally {
      this.isFixingSetup = false;
    }
  }

  public saveConfig(nextConfig: LinuxAppConfig) {
    const wasRunning = this.isRunning;
    this.config = this.normalizeConfig(nextConfig);
    this.saveConfigToDisk(this.config);

    if (wasRunning) {
      if (this.usingSystemd) {
        this.upsertAndStartSystemdUnit(this.config.port);
      } else {
        if (this.directProcess) {
          this.directProcess.kill("SIGTERM");
          this.directProcess = null;
        }
        this.startDirectProcess(this.config.port);
      }
    }

    this.refreshSetupStatus();
    this.statusMessage = wasRunning ? "Running (settings saved)" : "Settings saved";
  }

  public printPairPageHint() {
    const url = this.localhostPairURL(this.configuredPort());
    this.appendOutput(`Pair page: ${url}`);
  }

  public async createPairingSession() {
    try {
      const response = await fetch(`http://127.0.0.1:${this.configuredPort()}/pair/create`, {
        method: "POST",
      });

      if (!response.ok) {
        this.appendOutput(`Failed to create pairing session: HTTP ${response.status}`);
        return;
      }

      const payload = (await response.json()) as PairCreateResponse;
      this.appendOutput(`Pairing URL: ${payload.pairingUrl}`);
      this.appendOutput(`Code: ${payload.code}`);
      this.appendOutput(`Expires: ${payload.expiresAt}`);
    } catch (error) {
      this.appendOutput(`Failed to create pairing session: ${this.describeUnknownError(error)}`);
    }
  }

  public async refreshPairedDevices() {
    this.isLoadingDevices = true;

    try {
      const response = await fetch(`http://127.0.0.1:${this.configuredPort()}/devices`);
      if (!response.ok) {
        this.pairedDevices = [];
        this.appendOutput(`Failed to load devices: HTTP ${response.status}`);
        return;
      }

      const payload = (await response.json()) as DevicesResponse;
      this.pairedDevices = payload.devices || [];
    } catch (error) {
      this.pairedDevices = [];
      this.appendOutput(`Failed to load devices: ${this.describeUnknownError(error)}`);
    } finally {
      this.isLoadingDevices = false;
    }
  }

  public async revokeDevice(input: string) {
    const trimmed = input.trim();
    if (!trimmed) {
      this.appendOutput("Usage: revoke <index-or-id>");
      return;
    }

    let target: PairedDevice | undefined;

    const maybeIndex = Number(trimmed);
    if (!Number.isNaN(maybeIndex) && Number.isInteger(maybeIndex) && maybeIndex > 0) {
      target = this.pairedDevices[maybeIndex - 1];
      if (!target) {
        this.appendOutput(`No device at index ${maybeIndex}.`);
        return;
      }
    } else {
      target = this.pairedDevices.find((device) => device.id === trimmed);
      if (!target) {
        this.appendOutput(`No device found with id '${trimmed}'.`);
        return;
      }
    }

    try {
      const response = await fetch(`http://127.0.0.1:${this.configuredPort()}/devices/${encodeURIComponent(target.id)}/revoke`, {
        method: "POST",
      });

      if (!response.ok) {
        this.appendOutput(`Failed to revoke device '${target.deviceName}': HTTP ${response.status}`);
        return;
      }

      this.appendOutput(`Revoked device access: ${target.deviceName} (${target.deviceId})`);
      await this.refreshPairedDevices();
    } catch (error) {
      this.appendOutput(`Failed to revoke device: ${this.describeUnknownError(error)}`);
    }
  }

  public stopConflictingProcess() {
    if (!this.conflictingPID) {
      this.appendOutput("No conflicting PID to stop.");
      return;
    }

    const kill = this.runCommand("kill", ["-TERM", String(this.conflictingPID)]);
    if (kill.exitCode === 0) {
      this.appendOutput(`Stopped conflicting process (PID ${this.conflictingPID}).`);
      this.conflictingPID = null;
      this.refreshSetupStatus();
      return;
    }

    this.appendOutput(`Could not stop conflicting process (PID ${this.conflictingPID}).`);
    this.appendOutput(kill.output);
  }

  public diagnosticsSummary(): string[] {
    const diagnostics = this.diagnoseSetup(false);
    const lines = [
      `Gateway build: ${diagnostics.gatewayBuildReady ? "ok" : "missing"}`,
      `Codex CLI: ${diagnostics.codexReady ? "ok" : "missing"}`,
      `Tailscale CLI: ${diagnostics.tailscaleAvailable ? "ok" : "missing"}`,
      `Tailscale auth: ${diagnostics.tailscaleAuthenticated ? "ok" : "not checked/not authenticated"}`,
      `Tailscale serve route: ${diagnostics.serveConfigured ? "configured" : "not checked/not configured"}`,
    ];

    if (diagnostics.portListener) {
      lines.push(`Port listener: PID ${diagnostics.portListener.pid} (${diagnostics.portListener.isManagedGateway ? "gateway" : "other"})`);
      lines.push(`Port command: ${diagnostics.portListener.command}`);
    } else {
      lines.push("Port listener: none");
    }

    lines.push(`Manager mode: ${this.usingSystemd ? "systemd --user" : "direct-process fallback"}`);
    return lines;
  }

  public recentLogsText(maxLines = 80): string {
    const managerLines = this.outputLines.slice(-maxLines).join("\n");
    const eventsTail = this.tailFile(path.join(this.logsDir, "events.log"), Math.floor(maxLines / 2));
    const errorsTail = this.tailFile(path.join(this.logsDir, "errors.log"), Math.floor(maxLines / 2));

    const sections: string[] = [];
    if (managerLines.trim()) {
      sections.push(`[manager]\n${managerLines}`);
    }
    if (eventsTail.trim()) {
      sections.push(`[events.log]\n${eventsTail}`);
    }
    if (errorsTail.trim()) {
      sections.push(`[errors.log]\n${errorsTail}`);
    }

    if (this.usingSystemd) {
      const journalTail = this.journalTail(Math.floor(maxLines / 2));
      if (journalTail.trim()) {
        sections.push(`[systemd journal]\n${journalTail}`);
      }
    }

    return sections.join("\n\n");
  }

  public describeConfig(): string[] {
    const lines = [
      `Port: ${this.config.port}`,
      `Pair URL: ${this.config.pairURL}`,
      `Auto-start: ${this.config.autoStart ? "on" : "off"}`,
      `Codex path: ${this.config.codexBinaryPath || "(auto)"}`,
      `Tailscale path: ${this.config.tailscaleBinaryPath || "(auto)"}`,
      `PUBLIC_BASE_URL: ${this.config.environment.PUBLIC_BASE_URL || "(unset)"}`,
      `Config file: ${this.configPath}`,
      `Gateway logs: ${this.logsDir}`,
      `Service mode: ${this.usingSystemd ? `systemd (${this.systemdUnitPath})` : "direct-process fallback"}`,
    ];
    return lines;
  }

  public log(message: string) {
    this.appendOutput(message);
  }

  public logsDirectoryPath(): string {
    return this.logsDir;
  }

  public shutdown() {
    if (!this.usingSystemd && this.directProcess) {
      this.directProcess.kill("SIGTERM");
      this.directProcess = null;
    }
  }

  private diagnoseSetup(includeNetworkChecks: boolean): SetupDiagnostics {
    const env = this.config.environment;
    const tailscalePath = this.resolvedTailscaleBinaryPath(env);

    return {
      gatewayBuildReady: fs.existsSync(this.gatewayEntryPath),
      codexReady: this.resolvedCodexBinaryPath(env) !== null,
      tailscaleAvailable: tailscalePath !== null,
      tailscaleAuthenticated: includeNetworkChecks && tailscalePath !== null ? this.isTailscaleAuthenticated(env) : false,
      serveConfigured: includeNetworkChecks && tailscalePath !== null ? this.isServeRouteConfigured(this.configuredPort(), env) : false,
      portListener: this.listenerInfo(this.configuredPort()),
    };
  }

  private configuredPort(): number {
    return this.config.port > 0 ? this.config.port : DEFAULT_PORT;
  }

  private cloneConfig(): LinuxAppConfig {
    return {
      port: this.config.port,
      environment: { ...this.config.environment },
      pairURL: this.config.pairURL,
      codexBinaryPath: this.config.codexBinaryPath,
      tailscaleBinaryPath: this.config.tailscaleBinaryPath,
      autoStart: this.config.autoStart,
    };
  }

  private normalizeConfig(raw: LinuxAppConfig): LinuxAppConfig {
    const port = raw.port > 0 ? raw.port : DEFAULT_PORT;
    const environment: Record<string, string> = {};

    for (const [key, value] of Object.entries(raw.environment || {})) {
      if (typeof value !== "string") {
        continue;
      }
      const trimmedKey = key.trim();
      if (!trimmedKey) {
        continue;
      }
      environment[trimmedKey] = value;
    }

    environment.HOST = DEFAULT_HOST;
    environment.PORT = String(port);

    const trimOptionalPath = (value: string | null | undefined): string | null => {
      if (!value) {
        return null;
      }
      const trimmed = value.trim();
      return trimmed ? trimmed : null;
    };

    return {
      port,
      environment,
      pairURL: this.localhostPairURL(port),
      codexBinaryPath: trimOptionalPath(raw.codexBinaryPath),
      tailscaleBinaryPath: trimOptionalPath(raw.tailscaleBinaryPath),
      autoStart: raw.autoStart !== false,
    };
  }

  private loadConfig(): LinuxAppConfig {
    const defaultConfig = this.normalizeConfig({
      port: DEFAULT_PORT,
      environment: { HOST: DEFAULT_HOST },
      pairURL: this.localhostPairURL(DEFAULT_PORT),
      codexBinaryPath: null,
      tailscaleBinaryPath: null,
      autoStart: true,
    });

    try {
      if (fs.existsSync(this.configPath)) {
        const parsed = this.parseConfigJson(fs.readFileSync(this.configPath, "utf8"));
        const normalized = this.normalizeConfig(parsed);
        this.saveConfigToDisk(normalized);
        return normalized;
      }

      if (fs.existsSync(this.legacyConfigPath)) {
        const parsed = this.parseConfigJson(fs.readFileSync(this.legacyConfigPath, "utf8"));
        const normalized = this.normalizeConfig(parsed);
        this.saveConfigToDisk(normalized);
        return normalized;
      }

      this.saveConfigToDisk(defaultConfig);
      return defaultConfig;
    } catch (error) {
      this.appendOutput(`Config load failed: ${this.describeUnknownError(error)}`);
      return defaultConfig;
    }
  }

  private parseConfigJson(rawText: string): LinuxAppConfig {
    const raw = JSON.parse(rawText) as Record<string, unknown>;

    const env: Record<string, string> = {};
    if (raw.environment && typeof raw.environment === "object") {
      for (const [key, value] of Object.entries(raw.environment as Record<string, unknown>)) {
        if (typeof value === "string") {
          env[key] = value;
        }
      }
    }

    const parsedPort =
      typeof raw.port === "number" && Number.isFinite(raw.port)
        ? Math.trunc(raw.port)
        : Number.parseInt(env.PORT || "", 10);

    return {
      port: Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : DEFAULT_PORT,
      environment: env,
      pairURL: typeof raw.pairURL === "string" ? raw.pairURL : this.localhostPairURL(DEFAULT_PORT),
      codexBinaryPath: typeof raw.codexBinaryPath === "string" ? raw.codexBinaryPath : null,
      tailscaleBinaryPath: typeof raw.tailscaleBinaryPath === "string" ? raw.tailscaleBinaryPath : null,
      autoStart: typeof raw.autoStart === "boolean" ? raw.autoStart : true,
    };
  }

  private saveConfigToDisk(config: LinuxAppConfig) {
    fs.mkdirSync(this.configDir, { recursive: true });
    fs.writeFileSync(this.configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  private localhostPairURL(port: number): string {
    return `http://127.0.0.1:${port}/pair`;
  }

  private resolveExecutablePath(command: string, environment: Record<string, string>): string | null {
    const trimmed = command.trim();
    if (!trimmed) {
      return null;
    }

    if (trimmed.includes("/")) {
      return this.isExecutable(trimmed) ? trimmed : null;
    }

    const pathEntries: string[] = [];

    if (environment.PATH) {
      pathEntries.push(...environment.PATH.split(":").filter(Boolean));
    }

    if (process.env.PATH) {
      pathEntries.push(...process.env.PATH.split(":").filter(Boolean));
    }

    pathEntries.push(
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/snap/bin",
      path.join(os.homedir(), ".bun/bin")
    );

    const unique = Array.from(new Set(pathEntries));
    for (const dir of unique) {
      const candidate = path.join(dir, trimmed);
      if (this.isExecutable(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  private isExecutable(targetPath: string): boolean {
    try {
      fs.accessSync(targetPath, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  private resolvedCodexBinaryPath(environment: Record<string, string>): string | null {
    if (this.config.codexBinaryPath) {
      return this.resolveExecutablePath(this.config.codexBinaryPath, environment);
    }

    if (environment.CODEX_APP_SERVER_BIN) {
      return this.resolveExecutablePath(environment.CODEX_APP_SERVER_BIN, environment);
    }

    return this.resolveExecutablePath("codex", environment);
  }

  private resolvedTailscaleBinaryPath(environment: Record<string, string>): string | null {
    if (this.config.tailscaleBinaryPath) {
      return this.resolveExecutablePath(this.config.tailscaleBinaryPath, environment);
    }

    if (environment.TAILSCALE_BIN) {
      return this.resolveExecutablePath(environment.TAILSCALE_BIN, environment);
    }

    const explicitCandidates = [
      "/usr/local/bin/tailscale",
      "/usr/bin/tailscale",
      "/bin/tailscale",
      "/snap/bin/tailscale",
    ];

    for (const candidate of explicitCandidates) {
      if (this.isExecutable(candidate)) {
        return candidate;
      }
    }

    return this.resolveExecutablePath("tailscale", environment);
  }

  private buildRuntimePATH(existing?: string): string {
    const entries: string[] = [];

    if (existing) {
      entries.push(...existing.split(":").filter(Boolean));
    }

    if (process.env.PATH) {
      entries.push(...process.env.PATH.split(":").filter(Boolean));
    }

    entries.push(
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/snap/bin",
      path.join(os.homedir(), ".bun/bin")
    );

    return Array.from(new Set(entries)).join(":");
  }

  private runtimeEnvironment(port: number): Record<string, string> {
    const env: Record<string, string> = { ...process.env } as Record<string, string>;

    for (const [key, value] of Object.entries(this.config.environment)) {
      env[key] = value;
    }

    env.HOST = DEFAULT_HOST;
    env.PORT = String(port);
    env.PATH = this.buildRuntimePATH(env.PATH);

    const codexPath = this.resolvedCodexBinaryPath(env);
    if (codexPath) {
      env.CODEX_APP_SERVER_BIN = codexPath;
    }

    const tailscalePath = this.resolvedTailscaleBinaryPath(env);
    if (tailscalePath) {
      env.TAILSCALE_BIN = tailscalePath;
    }

    env.DB_PATH = path.join(this.appDataDir, "gateway.sqlite");
    env.EVENTS_LOG_PATH = path.join(this.logsDir, "events.log");
    env.ERRORS_LOG_PATH = path.join(this.logsDir, "errors.log");

    return env;
  }

  private ensureAppDataDirectories() {
    fs.mkdirSync(this.logsDir, { recursive: true });
  }

  private runCommand(
    executable: string,
    args: string[],
    options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }
  ): CommandResult {
    try {
      const output = execFileSync(executable, args, {
        cwd: options?.cwd,
        env: options?.env ? { ...process.env, ...options.env } : process.env,
        encoding: "utf8",
        timeout: options?.timeoutMs ?? 12_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { exitCode: 0, output: output || "" };
    } catch (error) {
      const asError = error as NodeJS.ErrnoException & {
        status?: number;
        stdout?: string | Buffer;
        stderr?: string | Buffer;
        signal?: string;
      };

      const stdout = this.bufferToString(asError.stdout);
      const stderr = this.bufferToString(asError.stderr);

      if (asError.code === "ENOENT") {
        return {
          exitCode: 127,
          output: `Command not found: ${executable}`,
        };
      }

      if (asError.signal === "SIGTERM") {
        return {
          exitCode: 124,
          output: `Command timed out: ${executable} ${args.join(" ")}`,
        };
      }

      return {
        exitCode: typeof asError.status === "number" ? asError.status : 1,
        output: [stdout, stderr].filter(Boolean).join("\n") || asError.message || "Command failed",
      };
    }
  }

  private bufferToString(value: unknown): string {
    if (!value) {
      return "";
    }
    if (typeof value === "string") {
      return value;
    }
    if (Buffer.isBuffer(value)) {
      return value.toString("utf8");
    }
    return String(value);
  }

  private listenerInfo(port: number): PortListener | null {
    const pid = this.listenerPID(port);
    if (!pid) {
      return null;
    }

    const command = this.processCommand(pid);
    return {
      pid,
      command,
      isManagedGateway: this.isManagedGatewayCommand(command),
    };
  }

  private listenerPID(port: number): number | null {
    const lsof = this.runCommand("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
    if (lsof.exitCode === 0) {
      const candidate = lsof.output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => /^\d+$/.test(line));
      if (candidate) {
        return Number(candidate);
      }
    }

    const ss = this.runCommand("ss", ["-ltnp", `sport = :${port}`]);
    if (ss.exitCode === 0) {
      const match = ss.output.match(/pid=(\d+)/);
      if (match) {
        return Number(match[1]);
      }
    }

    return null;
  }

  private processCommand(pid: number): string {
    const ps = this.runCommand("ps", ["-p", String(pid), "-o", "command="]);
    if (ps.exitCode !== 0) {
      return "";
    }

    return ps.output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) || "";
  }

  private isManagedGatewayCommand(command: string): boolean {
    if (!command) {
      return false;
    }

    if (this.directProcess && this.directProcess.pid) {
      const directPid = String(this.directProcess.pid);
      if (command.includes(this.gatewayEntryPath) && command.includes(directPid)) {
        return true;
      }
    }

    if (command.includes(this.gatewayEntryPath)) {
      return true;
    }

    if (command.includes("/gateway/dist/server.js")) {
      return true;
    }

    return false;
  }

  private async waitForGatewayReachable(port: number, timeoutSeconds: number): Promise<boolean> {
    const target = `http://127.0.0.1:${port}/health`;
    const deadline = Date.now() + timeoutSeconds * 1000;

    while (Date.now() < deadline) {
      try {
        const response = await fetch(target);
        if (response.ok) {
          return true;
        }
      } catch {
        // retry
      }

      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    return false;
  }

  private isSystemdUserAvailable(): boolean {
    const result = this.runCommand("systemctl", ["--user", "show-environment"], {
      timeoutMs: 5_000,
    });

    if (result.exitCode === 0) {
      return true;
    }

    this.appendOutput("systemd --user is unavailable; using direct-process fallback.");
    this.appendOutput(result.output);
    return false;
  }

  private upsertAndStartSystemdUnit(port: number): boolean {
    const nodePath = this.resolveExecutablePath("node", this.config.environment);
    if (!nodePath) {
      this.appendOutput("Node.js runtime not found. Install Node.js and retry.");
      return false;
    }

    const env = this.runtimeEnvironment(port);
    const serviceBody = this.buildSystemdUnit(nodePath, env);

    try {
      fs.mkdirSync(this.systemdUserDir, { recursive: true });
      fs.writeFileSync(this.systemdUnitPath, serviceBody, "utf8");
    } catch (error) {
      this.appendOutput(`Failed to write systemd unit: ${this.describeUnknownError(error)}`);
      return false;
    }

    const reload = this.runCommand("systemctl", ["--user", "daemon-reload"]);
    if (reload.exitCode !== 0) {
      this.appendOutput("Failed to reload systemd --user daemon.");
      this.appendOutput(reload.output);
      return false;
    }

    if (this.config.autoStart) {
      const enable = this.runCommand("systemctl", ["--user", "enable", SYSTEMD_UNIT_NAME]);
      if (enable.exitCode !== 0) {
        this.appendOutput(`Failed to enable ${SYSTEMD_UNIT_NAME} for auto-start.`);
        this.appendOutput(enable.output);
      }
    } else {
      const disable = this.runCommand("systemctl", ["--user", "disable", SYSTEMD_UNIT_NAME]);
      if (disable.exitCode !== 0 && !disable.output.includes("not loaded")) {
        this.appendOutput(`Failed to disable ${SYSTEMD_UNIT_NAME}.`);
        this.appendOutput(disable.output);
      }
    }

    const start = this.runCommand("systemctl", ["--user", "restart", SYSTEMD_UNIT_NAME]);
    if (start.exitCode !== 0) {
      this.appendOutput(`Failed to start ${SYSTEMD_UNIT_NAME}.`);
      this.appendOutput(start.output);
      return false;
    }

    this.appendOutput(`systemd unit active: ${SYSTEMD_UNIT_NAME}`);
    return true;
  }

  private buildSystemdUnit(nodePath: string, environment: Record<string, string>): string {
    const envLines = Object.keys(environment)
      .sort((a, b) => a.localeCompare(b))
      .map((key) => `Environment=${key}=${this.systemdEscapeValue(environment[key] || "")}`)
      .join("\n");

    return `[Unit]
Description=Codex Gateway Service
After=network.target

[Service]
Type=simple
WorkingDirectory=${this.gatewayRoot}
ExecStart=${nodePath} ${this.gatewayEntryPath}
Restart=always
RestartSec=2
${envLines}

[Install]
WantedBy=default.target
`;
  }

  private systemdEscapeValue(value: string): string {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }

  private startDirectProcess(port: number): boolean {
    if (this.directProcess && !this.directProcess.killed) {
      this.appendOutput("Gateway process is already running in direct mode.");
      return true;
    }

    const nodePath = this.resolveExecutablePath("node", this.config.environment);
    if (!nodePath) {
      this.appendOutput("Node.js runtime not found. Install Node.js and retry.");
      return false;
    }

    const env = this.runtimeEnvironment(port);

    try {
      const child = spawn(nodePath, [this.gatewayEntryPath], {
        cwd: this.gatewayRoot,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout.on("data", (chunk: Buffer) => {
        this.appendOutput(this.sanitizeLogLine(chunk.toString("utf8")));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        this.appendOutput(this.sanitizeLogLine(chunk.toString("utf8")));
      });
      child.on("exit", (code, signal) => {
        this.appendOutput(`Direct gateway process exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`);
        this.directProcess = null;
        this.isRunning = false;
      });
      child.on("error", (error) => {
        this.appendOutput(`Failed to start direct gateway process: ${this.describeUnknownError(error)}`);
        this.directProcess = null;
        this.isRunning = false;
      });

      this.directProcess = child;
      this.appendOutput(`Direct gateway process started (PID ${child.pid ?? "unknown"}).`);
      return true;
    } catch (error) {
      this.appendOutput(`Failed to spawn direct gateway process: ${this.describeUnknownError(error)}`);
      return false;
    }
  }

  private sanitizeLogLine(line: string): string {
    let cleaned = line;
    cleaned = cleaned.replace(/\u001B\[[0-9;]*[A-Za-z]/g, "");
    cleaned = cleaned.replace(/\[(?:\d{1,3};?)+m/g, "");
    return cleaned.replace(/\t/g, "  ");
  }

  private discoverTailscaleMagicBaseURL(environment: Record<string, string>): string | null {
    const tailscalePath = this.resolvedTailscaleBinaryPath(environment);
    if (!tailscalePath) {
      return null;
    }

    const result = this.runCommand(tailscalePath, ["status", "--json"], {
      env: environment,
    });

    if (result.exitCode !== 0) {
      return null;
    }

    try {
      const json = JSON.parse(result.output) as {
        Self?: { DNSName?: string };
      };

      const dnsName = (json.Self?.DNSName || "").replace(/\.+$/, "");
      return dnsName ? `https://${dnsName}` : null;
    } catch {
      return null;
    }
  }

  private isTailscaleAuthenticated(environment: Record<string, string>): boolean {
    const tailscalePath = this.resolvedTailscaleBinaryPath(environment);
    if (!tailscalePath) {
      return false;
    }

    const result = this.runCommand(tailscalePath, ["status", "--json"], {
      env: environment,
    });

    if (result.exitCode !== 0) {
      return false;
    }

    try {
      const json = JSON.parse(result.output) as {
        BackendState?: string;
        Self?: unknown;
      };

      return Boolean(json.Self) && json.BackendState !== "NeedsLogin";
    } catch {
      return false;
    }
  }

  private isServeRouteConfigured(port: number, environment: Record<string, string>): boolean {
    const tailscalePath = this.resolvedTailscaleBinaryPath(environment);
    if (!tailscalePath) {
      return false;
    }

    const status = this.runCommand(tailscalePath, ["serve", "status", "--json"], {
      env: environment,
    });

    if (status.exitCode !== 0) {
      return false;
    }

    const hasEndpoint = status.output.includes(`127.0.0.1:${port}`);
    const hasService = status.output.includes(TAILSCALE_SERVICE_NAME);
    return hasEndpoint && (hasService || status.output.includes('"Web"'));
  }

  private ensureTailscaleServeRoutesToGateway(port: number): boolean {
    const env = this.runtimeEnvironment(port);
    const tailscalePath = this.resolvedTailscaleBinaryPath(env);
    if (!tailscalePath) {
      this.appendOutput("Tailscale CLI not found; skipping route setup.");
      return false;
    }

    if (!this.isTailscaleAuthenticated(env)) {
      this.appendOutput("Tailscale is not authenticated. Sign in and retry.");
      return false;
    }

    const configure = this.runCommand(
      tailscalePath,
      ["serve", "--service", TAILSCALE_SERVICE_NAME, "--bg", `http://127.0.0.1:${port}`],
      { env }
    );

    if (configure.exitCode === 0) {
      this.didConfigureServeRouteThisSession = true;
      this.didConfigureLegacyServeRouteThisSession = false;
      this.appendOutput(`Configured Tailscale Serve route to 127.0.0.1:${port}.`);
      return true;
    }

    if (configure.output.includes("invalid service name") || configure.output.includes("flag -service")) {
      const fallback = this.runCommand(tailscalePath, ["serve", "--bg", `http://127.0.0.1:${port}`], { env });
      if (fallback.exitCode === 0) {
        this.didConfigureServeRouteThisSession = false;
        this.didConfigureLegacyServeRouteThisSession = true;
        this.appendOutput(
          "Configured Tailscale route in node mode (service mode unsupported by this Tailscale CLI)."
        );
        return true;
      }

      this.appendOutput("Failed to configure Tailscale route in fallback mode.");
      this.appendOutput(fallback.output);
      return false;
    }

    this.appendOutput("Failed to configure Tailscale route.");
    this.appendOutput(configure.output);
    return false;
  }

  private disableTailscaleServeIfManagedByApp() {
    if (!this.didConfigureServeRouteThisSession && !this.didConfigureLegacyServeRouteThisSession) {
      return;
    }

    const env = this.runtimeEnvironment(this.configuredPort());
    const tailscalePath = this.resolvedTailscaleBinaryPath(env);
    if (!tailscalePath) {
      return;
    }

    if (this.didConfigureServeRouteThisSession) {
      const clear = this.runCommand(tailscalePath, ["serve", "clear", TAILSCALE_SERVICE_NAME], { env });
      if (clear.exitCode === 0) {
        this.appendOutput(`Removed Tailscale service route '${TAILSCALE_SERVICE_NAME}' configured by this app.`);
      } else {
        this.appendOutput(`Could not clear Tailscale service route '${TAILSCALE_SERVICE_NAME}'.`);
        this.appendOutput(clear.output);
      }
    } else if (this.didConfigureLegacyServeRouteThisSession) {
      this.appendOutput("Leaving existing node-level Tailscale route unchanged (legacy CLI mode).");
    }

    this.didConfigureServeRouteThisSession = false;
    this.didConfigureLegacyServeRouteThisSession = false;
  }

  private appendOutput(raw: string) {
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      return;
    }

    const timestamp = new Date().toISOString();
    for (const line of lines) {
      this.outputLines.push(`${timestamp} ${line}`);
    }

    if (this.outputLines.length > 280) {
      this.outputLines = this.outputLines.slice(-280);
    }
  }

  private tailFile(filePath: string, maxLines: number): string {
    if (!fs.existsSync(filePath)) {
      return "";
    }

    try {
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split(/\r?\n/).filter(Boolean);
      return lines.slice(-Math.max(1, maxLines)).join("\n");
    } catch {
      return "";
    }
  }

  private journalTail(maxLines: number): string {
    const journal = this.runCommand("journalctl", ["--user", "-u", SYSTEMD_UNIT_NAME, "-n", String(maxLines), "--no-pager"]);
    if (journal.exitCode !== 0) {
      return "";
    }
    return journal.output.trim();
  }

  private describeUnknownError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
}

class LinuxGatewayTui {
  private readonly manager: LinuxGatewayManager;
  private readonly rl: readline.Interface;
  private processingCommand = false;

  constructor() {
    this.manager = new LinuxGatewayManager();
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "codex-gateway> ",
    });

    this.setupSignalHandlers();
  }

  public async start() {
    await this.manager.refreshPairedDevices();
    this.render();

    this.rl.on("line", async (line) => {
      if (this.processingCommand) {
        this.manager.log("A command is already running. Please wait.");
        this.render();
        return;
      }

      this.processingCommand = true;
      try {
        await this.handleCommand(line.trim());
      } finally {
        this.processingCommand = false;
        this.render();
      }
    });

    this.rl.on("close", () => {
      this.manager.shutdown();
      process.exit(0);
    });
  }

  private setupSignalHandlers() {
    const shutdown = () => {
      this.manager.shutdown();
      this.rl.close();
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }

  private render() {
    process.stdout.write("\x1bc");

    const summaryLines = this.manager.describeConfig();
    const diagnostics = this.manager.diagnosticsSummary();
    const logs = this.manager.recentLogsText(24)
      .split(/\r?\n/)
      .slice(-24)
      .join("\n");

    const devices = this.manager.pairedDevices;

    process.stdout.write("Codex Gateway Linux TUI\n");
    process.stdout.write("======================\n");
    process.stdout.write(`Status: ${this.manager.statusMessage}\n`);
    process.stdout.write(`Running: ${this.manager.isRunning ? "yes" : "no"}\n`);
    if (this.manager.conflictingPID) {
      process.stdout.write(`Conflict PID: ${this.manager.conflictingPID}\n`);
    }
    process.stdout.write("\n");

    process.stdout.write("Config\n");
    process.stdout.write("------\n");
    for (const line of summaryLines) {
      process.stdout.write(`${line}\n`);
    }
    process.stdout.write("\n");

    process.stdout.write("Diagnostics\n");
    process.stdout.write("-----------\n");
    for (const line of diagnostics) {
      process.stdout.write(`${line}\n`);
    }
    process.stdout.write("\n");

    process.stdout.write("Paired Devices\n");
    process.stdout.write("--------------\n");
    if (devices.length === 0) {
      process.stdout.write(this.manager.isLoadingDevices ? "Loading devices...\n" : "No active paired devices.\n");
    } else {
      devices.slice(0, 10).forEach((device, index) => {
        const added = new Date(device.createdAt).toLocaleString();
        process.stdout.write(`${index + 1}. ${device.deviceName} | ${device.deviceId} | added ${added} | id=${device.id}\n`);
      });
      if (devices.length > 10) {
        process.stdout.write(`...and ${devices.length - 10} more\n`);
      }
    }
    process.stdout.write("\n");

    process.stdout.write("Recent Logs\n");
    process.stdout.write("-----------\n");
    process.stdout.write(logs ? `${logs}\n` : "No logs yet.\n");
    process.stdout.write("\n");

    process.stdout.write("Commands\n");
    process.stdout.write("--------\n");
    process.stdout.write("start | stop | toggle | fix | status | devices | stop-conflict\n");
    process.stdout.write("pair | pair-create | revoke <index-or-id> | logs\n");
    process.stdout.write("set port <n>\n");
    process.stdout.write("set public-base <url|clear>\n");
    process.stdout.write("set codex <path|auto>\n");
    process.stdout.write("set tailscale <path|auto>\n");
    process.stdout.write("set autostart <on|off>\n");
    process.stdout.write("help | quit\n\n");

    this.rl.prompt();
  }

  private async handleCommand(line: string) {
    if (!line) {
      return;
    }

    const [command, ...tokens] = line.split(/\s+/);
    const rest = line.slice(command.length).trim();

    switch (command) {
      case "help":
        this.manager.log("Use the command list shown in the dashboard.");
        return;
      case "status":
        this.manager.refreshSetupStatus();
        await this.manager.refreshPairedDevices();
        return;
      case "start":
        await this.manager.start();
        return;
      case "stop":
        this.manager.stop();
        return;
      case "toggle":
        if (this.manager.isRunning) {
          this.manager.stop();
        } else {
          await this.manager.start();
        }
        return;
      case "fix":
        await this.manager.fixSetup();
        return;
      case "pair":
        this.manager.printPairPageHint();
        return;
      case "pair-create":
        await this.manager.createPairingSession();
        return;
      case "devices":
        await this.manager.refreshPairedDevices();
        return;
      case "revoke":
        await this.manager.revokeDevice(rest);
        return;
      case "stop-conflict":
        this.manager.stopConflictingProcess();
        return;
      case "logs":
        this.manager.log(`Log directory: ${this.manager.logsDirectoryPath()}`);
        return;
      case "set":
        await this.handleSetCommand(tokens);
        return;
      case "quit":
      case "exit":
        this.manager.shutdown();
        this.rl.close();
        return;
      default:
        this.manager.log(`Unknown command: ${command}`);
        return;
    }
  }

  private async handleSetCommand(tokens: string[]) {
    const [field, ...rest] = tokens;
    if (!field) {
      this.manager.log("Usage: set <port|public-base|codex|tailscale|autostart> <value>");
      return;
    }

    const value = rest.join(" ").trim();
    const next = {
      ...this.manager.config,
      environment: { ...this.manager.config.environment },
    } as LinuxAppConfig;

    switch (field) {
      case "port": {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
          this.manager.log("Port must be an integer between 1 and 65535.");
          return;
        }
        next.port = parsed;
        next.pairURL = `http://127.0.0.1:${parsed}/pair`;
        this.manager.saveConfig(next);
        this.manager.log(`Set port to ${parsed}.`);
        return;
      }
      case "public-base": {
        if (!value || value.toLowerCase() === "clear") {
          delete next.environment.PUBLIC_BASE_URL;
          this.manager.saveConfig(next);
          this.manager.log("Cleared PUBLIC_BASE_URL.");
          return;
        }
        next.environment.PUBLIC_BASE_URL = value;
        this.manager.saveConfig(next);
        this.manager.log(`Set PUBLIC_BASE_URL to ${value}.`);
        return;
      }
      case "codex": {
        if (!value || value.toLowerCase() === "auto") {
          next.codexBinaryPath = null;
          this.manager.saveConfig(next);
          this.manager.log("Set Codex path to auto-detect.");
          return;
        }
        next.codexBinaryPath = value;
        this.manager.saveConfig(next);
        this.manager.log(`Set Codex path to ${value}.`);
        return;
      }
      case "tailscale": {
        if (!value || value.toLowerCase() === "auto") {
          next.tailscaleBinaryPath = null;
          this.manager.saveConfig(next);
          this.manager.log("Set Tailscale path to auto-detect.");
          return;
        }
        next.tailscaleBinaryPath = value;
        this.manager.saveConfig(next);
        this.manager.log(`Set Tailscale path to ${value}.`);
        return;
      }
      case "autostart": {
        const normalized = value.toLowerCase();
        if (!["on", "off", "true", "false", "1", "0"].includes(normalized)) {
          this.manager.log("Autostart value must be on/off.");
          return;
        }
        next.autoStart = ["on", "true", "1"].includes(normalized);
        this.manager.saveConfig(next);
        this.manager.log(`Set auto-start to ${next.autoStart ? "on" : "off"}.`);
        return;
      }
      default:
        this.manager.log(`Unknown set field: ${field}`);
        return;
    }
  }
}

async function main() {
  const tui = new LinuxGatewayTui();
  await tui.start();
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`Fatal error: ${message}\n`);
  process.exit(1);
});
