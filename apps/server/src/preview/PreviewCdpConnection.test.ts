import { describe, expect, it } from "vite-plus/test";

import {
  createPreviewCdpConnection,
  type PreviewCdpHost,
  type PreviewCdpTab,
} from "./PreviewCdpConnection.ts";

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

const docs: PreviewCdpTab = {
  tabId: "tab-docs",
  targetId: "TARGET-DOCS",
  url: "http://localhost:5173/docs",
  title: "Docs",
};

/** A thread's desktop tabs as the server would present them, recording what reaches the page. */
const makeHarness = () => {
  let sessionCount = 0;
  let tabCount = 0;
  const sent: Array<{ tabId: string; sessionId: string; method: string; params: unknown }> = [];
  const closedSessions: Array<string> = [];
  const closedTabs: Array<string> = [];
  const revealed: Array<string> = [];
  const written: Array<Record<string, any>> = [];
  const host: PreviewCdpHost = {
    openTab: async (url) => ({
      tabId: `tab-new-${++tabCount}`,
      targetId: `TARGET-NEW-${tabCount}`,
      url: url ?? "about:blank",
      title: "",
    }),
    revealTab: (tabId) => {
      revealed.push(tabId);
    },
    closeTab: async (tabId) => {
      closedTabs.push(tabId);
      connection.removeTab(tabId);
    },
    openSession: async (tabId) => `SESSION-${tabId}-${++sessionCount}`,
    closeSession: (_tabId, sessionId) => {
      closedSessions.push(sessionId);
    },
    sessionCommand: async (tabId, sessionId, method, params) => {
      sent.push({ tabId, sessionId, method, params });
      return method === "Runtime.evaluate" ? { result: { type: "number", value: 1 } } : {};
    },
  };
  const connection = createPreviewCdpConnection(host, (raw) => written.push(JSON.parse(raw)));
  let id = 0;
  const call = async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
    const commandId = ++id;
    connection.receive(
      JSON.stringify({ id: commandId, method, params, ...(sessionId ? { sessionId } : {}) }),
    );
    await settle();
    const reply = written.find((message) => message["id"] === commandId);
    if (!reply) throw new Error(`no reply to ${method}`);
    return reply;
  };
  const events = (method: string) => written.filter((message) => message["method"] === method);
  return { connection, call, events, sent, closedSessions, closedTabs, revealed, written };
};

describe("preview CDP connection", () => {
  it("serves agent-browser's connect sequence on a real child session per tab", async () => {
    const { connection, call, events, sent } = makeHarness();
    connection.upsertTab(docs);

    expect((await call("Browser.getVersion")).result.product).toBe("T3 Code Preview");
    await call("Target.setDiscoverTargets", { discover: true });
    expect(events("Target.targetCreated")).toEqual([
      {
        method: "Target.targetCreated",
        params: { targetInfo: expect.objectContaining({ targetId: "TARGET-DOCS", type: "page" }) },
      },
    ]);
    const { targetInfos } = (await call("Target.getTargets")).result;
    expect(targetInfos.map((info: { url: string }) => info.url)).toEqual([docs.url]);

    const { sessionId } = (
      await call("Target.attachToTarget", {
        targetId: "TARGET-DOCS",
        flatten: true,
      })
    ).result;
    expect(sessionId).toBe("SESSION-tab-docs-1");
    expect((await call("Runtime.evaluate", { expression: "1" }, sessionId)).result).toEqual({
      result: { type: "number", value: 1 },
    });
    await call("Page.enable", {}, sessionId);
    // agent-browser pauses new frames until it next drains events; the page must not wait on it.
    await call(
      "Target.setAutoAttach",
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
      sessionId,
    );
    expect(sent.map((command) => command.method)).toEqual([
      "Runtime.evaluate",
      "Page.enable",
      "Target.setAutoAttach",
    ]);
    expect(sent[2]!.params).toMatchObject({ waitForDebuggerOnStart: false });
  });

  it("keeps the preview's viewport and appearance its own", async () => {
    const { connection, call, sent } = makeHarness();
    connection.upsertTab(docs);
    const { sessionId } = (
      await call("Target.attachToTarget", {
        targetId: "TARGET-DOCS",
        flatten: true,
      })
    ).result;
    // Playwright sends these while setting up every page, so they succeed without effect.
    expect(
      (
        await call(
          "Emulation.setDeviceMetricsOverride",
          { width: 375, height: 812, deviceScaleFactor: 3, mobile: true },
          sessionId,
        )
      ).result,
    ).toEqual({});
    await call("Emulation.setEmulatedMedia", { media: "" }, sessionId);
    await call("Emulation.setGeolocationOverride", { latitude: 1, longitude: 2 }, sessionId);
    expect(sent.map((command) => command.method)).toEqual(["Emulation.setGeolocationOverride"]);
  });

  it("announces existing and new tabs to an auto-attaching client, as Playwright expects", async () => {
    const { connection, call, events } = makeHarness();
    connection.upsertTab(docs);
    await call("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    await settle();
    connection.upsertTab({ ...docs, tabId: "tab-app", targetId: "TARGET-APP" });
    await settle();
    expect(
      events("Target.attachedToTarget").map((event) => [
        event["params"].targetInfo.targetId,
        event["params"].sessionId,
        event["params"].waitingForDebugger,
      ]),
    ).toEqual([
      ["TARGET-DOCS", "SESSION-tab-docs-1", false],
      ["TARGET-APP", "SESSION-tab-app-2", false],
    ]);
  });

  it("opens and closes preview tabs for tab new and tab close", async () => {
    const { call, events, closedTabs, closedSessions } = makeHarness();
    await call("Target.setDiscoverTargets", { discover: true });
    const { targetId } = (await call("Target.createTarget", { url: "about:blank" })).result;
    expect(targetId).toBe("TARGET-NEW-1");
    expect(events("Target.targetCreated")).toHaveLength(1);
    const { sessionId } = (await call("Target.attachToTarget", { targetId, flatten: true })).result;

    expect((await call("Target.closeTarget", { targetId })).result).toEqual({ success: true });
    expect(closedTabs).toEqual(["tab-new-1"]);
    expect(closedSessions).toEqual([sessionId]);
    expect(events("Target.detachedFromTarget")).toEqual([
      { method: "Target.detachedFromTarget", params: { sessionId, targetId } },
    ]);
    expect(events("Target.targetDestroyed")).toEqual([
      { method: "Target.targetDestroyed", params: { targetId } },
    ]);
    // A session that went with its tab answers like Chromium's.
    expect((await call("Runtime.evaluate", {}, sessionId)).error.message).toMatch(/not found/);
  });

  it("routes events by session, including auto-attached children, and reports URL changes", async () => {
    const { connection, call, events, written } = makeHarness();
    connection.upsertTab(docs);
    await call("Target.setDiscoverTargets", { discover: true });
    const { sessionId } = (
      await call("Target.attachToTarget", {
        targetId: "TARGET-DOCS",
        flatten: true,
      })
    ).result;

    connection.sessionEvent("tab-docs", "SOMEONE-ELSES-SESSION", "Page.loadEventFired", {});
    connection.sessionEvent("tab-docs", sessionId, "Target.attachedToTarget", {
      sessionId: "IFRAME-SESSION",
      targetInfo: { targetId: "IFRAME", type: "iframe" },
    });
    connection.sessionEvent("tab-docs", "IFRAME-SESSION", "Runtime.consoleAPICalled", {});
    expect(written.filter((message) => message["sessionId"] !== undefined)).toEqual([
      expect.objectContaining({ method: "Target.attachedToTarget", sessionId }),
      expect.objectContaining({ method: "Runtime.consoleAPICalled", sessionId: "IFRAME-SESSION" }),
    ]);

    connection.upsertTab({ ...docs, url: "http://localhost:5173/settings", title: "Settings" });
    expect(events("Target.targetInfoChanged")).toEqual([
      {
        method: "Target.targetInfoChanged",
        params: {
          targetInfo: expect.objectContaining({
            url: "http://localhost:5173/settings",
            attached: true,
          }),
        },
      },
    ]);
  });

  it("detaches every session it opened when the client goes away", async () => {
    const { connection, call, closedSessions } = makeHarness();
    connection.upsertTab(docs);
    const first = (await call("Target.attachToTarget", { targetId: "TARGET-DOCS", flatten: true }))
      .result.sessionId;
    // agent-browser's recorder opens a second session on the same tab.
    const second = (await call("Target.attachToTarget", { targetId: "TARGET-DOCS", flatten: true }))
      .result.sessionId;
    expect(second).not.toBe(first);
    connection.close();
    expect(closedSessions).toEqual([first, second]);
  });

  it("refuses to close the browser T3 owns", async () => {
    const { call } = makeHarness();
    expect((await call("Browser.close")).error.message).toMatch(/owns this browser/);
    expect((await call("Target.createBrowserContext")).error.message).toMatch(/Not supported/);
  });
  it("shows a blank tab a tool opens only once something loads in it", async () => {
    const { connection, call, revealed } = makeHarness();
    // agent-browser opens one of these whenever it finds no tabs.
    const { targetId } = (await call("Target.createTarget", { url: "about:blank" })).result;
    await call("Target.activateTarget", { targetId });
    expect(revealed).toEqual([]);
    connection.upsertTab({
      tabId: "tab-new-1",
      targetId,
      url: "http://localhost:5173/",
      title: "",
    });
    connection.upsertTab({
      tabId: "tab-new-1",
      targetId,
      url: "http://localhost:5173/a",
      title: "",
    });
    expect(revealed).toEqual(["tab-new-1"]);
  });

  it("asks to show tabs a tool opens or brings to the front, as preview_open does", async () => {
    const { connection, call, revealed, sent } = makeHarness();
    connection.upsertTab(docs);
    await call("Target.createTarget", { url: "http://localhost:5173/new" });
    await call("Target.activateTarget", { targetId: "TARGET-DOCS" });
    const { sessionId } = (
      await call("Target.attachToTarget", { targetId: "TARGET-DOCS", flatten: true })
    ).result;
    await call("Page.bringToFront", {}, sessionId);
    expect(revealed).toEqual(["tab-new-1", "tab-docs", "tab-docs"]);
    // Showing the tab is T3's to do; the page itself is not asked.
    expect(sent).toEqual([]);
  });
});
