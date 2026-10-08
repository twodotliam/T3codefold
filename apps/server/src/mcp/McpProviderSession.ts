import type {
  AgentBrowserTooling,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /**
   * Whether this credential includes the "preview" capability. Adapters read
   * it to keep developer instructions truthful: when the user withholds agent
   * browser access, the prompt must not advertise `preview_*` tools that every
   * call would reject.
   */
  readonly browserToolsAvailable: boolean;
  /** Capabilities the credential grants ("preview", "device"). */
  readonly capabilities?: ReadonlySet<string>;
  /**
   * Set when the session may drive devices. Adapters spread this into the
   * provider subprocess environment so the `agent-device` CLI is on PATH and
   * already pointed at the server's daemon; the agent never handles a token.
   */
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
  /**
   * The thread's preview CDP endpoint, when the session may use the browser and
   * a desktop app renders its tabs. Exported as `AGENT_BROWSER_CDP`, so
   * agent-browser drives the thread's tabs without being told where they are.
   */
  readonly previewCdpUrl?: string;
  /** Which browser tooling the injected instructions prefer; see `AgentBrowserTooling`. */
  readonly browserTooling?: AgentBrowserTooling;
}

/** Provider env with the device variables applied over `base`, or `base` untouched. */
export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}

const sessionsByThread = new Map<ThreadId, McpProviderSessionConfig>();

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  sessionsByThread.set(config.threadId, config);
}

export function readMcpProviderSession(threadId: ThreadId): McpProviderSessionConfig | undefined {
  return sessionsByThread.get(threadId);
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
}

function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
}

/**
 * The agent-browser session a thread's agents use. agent-browser keeps one
 * daemon per session name and connects it once, so without a per-thread name
 * every thread's commands would reach whichever thread connected first.
 */
export function agentBrowserSessionName(threadId: ThreadId): string {
  return `t3-${threadId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

/**
 * The `t3 work` CLI's credential: the thread's own revocable MCP authority,
 * never local admin auth. Empty when the thread has no MCP session.
 */
export function workCliEnvironment(threadId: ThreadId): Readonly<Record<string, string>> {
  const session = readMcpProviderSession(threadId);
  return session
    ? {
        T3_WORK_ENDPOINT: session.endpoint,
        T3_WORK_AUTHORIZATION: session.authorizationHeader,
        ...(session.previewCdpUrl
          ? {
              AGENT_BROWSER_CDP: session.previewCdpUrl,
              AGENT_BROWSER_SESSION: agentBrowserSessionName(threadId),
            }
          : {}),
      }
    : {};
}

/**
 * Provider env with the thread's `t3 work` credential and preview CDP endpoint
 * applied over `base`, or `base` untouched. Adapters call it where they spawn a per-thread process.
 * The device shim is separate (`withAgentDeviceEnvironment`) and not applied
 * here; devices reach agents through the MCP device tools.
 */
export function providerSessionEnvironment(
  base: NodeJS.ProcessEnv,
  threadId: ThreadId,
): NodeJS.ProcessEnv {
  const work = workCliEnvironment(threadId);
  return Object.keys(work).length === 0 ? base : { ...base, ...work };
}
