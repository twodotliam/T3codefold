import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import {
  providerSessionEnvironment,
  setMcpProviderSession,
  clearMcpProviderSession,
  withAgentDeviceEnvironment,
  workCliEnvironment,
} from "./McpProviderSession.ts";

describe("device CLI environment", () => {
  it("preserves provider credentials and commands while routing devices to the owned daemon", () => {
    const environment = withAgentDeviceEnvironment(
      { PATH: "/provider/bin:/usr/bin", PROVIDER_KEY: "fixture" },
      {
        agentDeviceEnvironment: {
          PATH: "/t3/device/bin",
          PATH_SEPARATOR: ":",
          AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
          AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
        },
      },
    );
    expect(environment).toEqual({
      PATH: "/t3/device/bin:/provider/bin:/usr/bin",
      PROVIDER_KEY: "fixture",
      AGENT_DEVICE_DAEMON_BASE_URL: "http://127.0.0.1:9000",
      AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
    });
  });

  it("does not grant CLI access when device access was not supplied", () => {
    const environment = { PATH: "/usr/bin", PROVIDER_KEY: "fixture" };
    expect(withAgentDeviceEnvironment(environment, undefined)).toBe(environment);
    expect(withAgentDeviceEnvironment(environment, {})).toBe(environment);
  });
});

describe("work CLI environment", () => {
  it("gives only the owning thread its work credential, without the device shim", () => {
    const threadId = ThreadId.make("work-environment-test");
    setMcpProviderSession({
      threadId,
      environmentId: EnvironmentId.make("fixture-env"),
      providerSessionId: "fixture-session",
      providerInstanceId: ProviderInstanceId.make("codex"),
      endpoint: "http://localhost:9000/mcp",
      authorizationHeader: "Bearer fixture-work",
      browserToolsAvailable: false,
      capabilities: new Set(["device", "orchestration"]),
      agentDeviceEnvironment: {
        PATH: "/device/bin",
        AGENT_DEVICE_DAEMON_AUTH_TOKEN: "fixture-device",
      },
    });
    try {
      expect(
        providerSessionEnvironment({ PATH: "/usr/bin", PROVIDER_KEY: "fixture" }, threadId),
      ).toEqual({
        PATH: "/usr/bin",
        PROVIDER_KEY: "fixture",
        T3_WORK_ENDPOINT: "http://localhost:9000/mcp",
        T3_WORK_AUTHORIZATION: "Bearer fixture-work",
      });
      const unrelated = { PATH: "/usr/bin" };
      expect(providerSessionEnvironment(unrelated, ThreadId.make("unrelated"))).toBe(unrelated);
    } finally {
      clearMcpProviderSession(threadId);
    }
    expect(workCliEnvironment(threadId)).toEqual({});
  });
});

describe("preview CDP environment", () => {
  it("points agent-browser at the owning thread's preview tabs", () => {
    const threadId = ThreadId.make("preview-cdp-environment-test");
    const cdpUrl =
      "ws://127.0.0.1:3773/api/preview/cdp?thread=preview-cdp-environment-test&token=t";
    setMcpProviderSession({
      threadId,
      environmentId: EnvironmentId.make("fixture-env"),
      providerSessionId: "fixture-session",
      providerInstanceId: ProviderInstanceId.make("claude"),
      endpoint: "http://localhost:9000/mcp",
      authorizationHeader: "Bearer fixture-work",
      browserToolsAvailable: true,
      previewCdpUrl: cdpUrl,
    });
    try {
      expect(providerSessionEnvironment({ PATH: "/usr/bin" }, threadId)).toMatchObject({
        AGENT_BROWSER_CDP: cdpUrl,
        // Its own agent-browser daemon, so another thread's daemon cannot take its commands.
        AGENT_BROWSER_SESSION: "t3-preview-cdp-environment-test",
      });
      expect(
        providerSessionEnvironment({ PATH: "/usr/bin" }, ThreadId.make("unrelated")),
      ).not.toHaveProperty("AGENT_BROWSER_CDP");
    } finally {
      clearMcpProviderSession(threadId);
    }
  });
});
