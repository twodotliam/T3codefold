/**
 * One external tool's connection to a thread's preview tabs, presented as a
 * minimal CDP browser endpoint: what agent-browser, Playwright's
 * `connectOverCDP`, and other `--cdp` clients expect.
 *
 * The targets are the thread's live tabs, wherever their pages run. Attaching
 * to one opens an independent session on its page (see
 * `ServerBrowser.openCdpSession`), so the tool's domains, init scripts, and
 * interception are its own, and closing the connection detaches them, which
 * undoes what it changed. Browser-level commands are answered here.
 *
 * The preview owns the tab's viewport and appearance. Emulation that would
 * replace them is acknowledged without effect, because clients such as
 * Playwright send it while setting up every page.
 */

export interface PreviewCdpTab {
  readonly tabId: string;
  readonly targetId: string;
  readonly url: string;
  readonly title: string;
}

/** What a connection needs from the server. Each call is scoped to one thread. */
export interface PreviewCdpHost {
  /** Opens a tab in the thread and resolves once the desktop renders it. */
  readonly openTab: (url: string | undefined) => Promise<PreviewCdpTab>;
  readonly closeTab: (tabId: string) => Promise<void>;
  /** Asks the person's clients to show the tab, as `preview_open` does; never forced. */
  readonly revealTab: (tabId: string) => void;
  readonly openSession: (tabId: string) => Promise<string>;
  readonly closeSession: (tabId: string, sessionId: string) => void;
  readonly sessionCommand: (
    tabId: string,
    sessionId: string,
    method: string,
    params: Record<string, unknown>,
  ) => Promise<unknown>;
}

export interface PreviewCdpConnection {
  /** Feed one message from the client. */
  readonly receive: (raw: string) => void;
  /** A tab appeared or its URL or title changed. */
  readonly upsertTab: (tab: PreviewCdpTab) => void;
  /** A tab closed or its page went away. */
  readonly removeTab: (tabId: string) => void;
  /** Feed one event from a lent session; events for other connections' sessions are ignored. */
  readonly sessionEvent: (
    tabId: string,
    sessionId: string,
    method: string,
    params: unknown,
  ) => void;
  /** Detaches every session this connection opened. */
  readonly close: () => void;
}

interface CdpCommand {
  readonly id: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
  readonly sessionId?: string;
}

const isCommand = (value: unknown): value is CdpCommand =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { id?: unknown }).id === "number" &&
  typeof (value as { method?: unknown }).method === "string";

const BROWSER_CONTEXT_ID = "t3-preview";

/** Emulation that would replace the preview's own viewport or appearance. */
const PREVIEW_OWNED_EMULATION = new Set([
  "Emulation.setDeviceMetricsOverride",
  "Emulation.clearDeviceMetricsOverride",
  "Emulation.setVisibleSize",
  "Emulation.setPageScaleFactor",
  "Emulation.setEmulatedMedia",
]);

/** Browser-level commands that only need acknowledging for pages T3 owns. */
const ACKNOWLEDGED = new Set([
  "Browser.setDownloadBehavior",
  "Browser.grantPermissions",
  "Browser.resetPermissions",
  "Browser.setPermission",
]);

class CdpError extends Error {}

export function createPreviewCdpConnection(
  host: PreviewCdpHost,
  write: (message: string) => void,
): PreviewCdpConnection {
  const send = (message: Record<string, unknown>) => write(JSON.stringify(message));
  const tabs = new Map<string, PreviewCdpTab>();
  /** Every session this connection may use, root or child, mapped to its tab. */
  const sessions = new Map<string, string>();
  /** Sessions opened on a tab's page, as opposed to children they auto-attached. */
  const roots = new Set<string>();
  let discover = false;
  let autoAttach = false;
  let closed = false;

  const tabByTarget = (targetId: unknown) =>
    [...tabs.values()].find((tab) => tab.targetId === targetId);

  const targetInfo = (tab: PreviewCdpTab) => ({
    targetId: tab.targetId,
    type: "page",
    title: tab.title,
    url: tab.url,
    attached: [...roots].some((sessionId) => sessions.get(sessionId) === tab.tabId),
    canAccessOpener: false,
    browserContextId: BROWSER_CONTEXT_ID,
  });

  const openSession = async (tab: PreviewCdpTab) => {
    const sessionId = await host.openSession(tab.tabId);
    if (closed || !tabs.has(tab.tabId)) {
      host.closeSession(tab.tabId, sessionId);
      throw new CdpError("The tab closed while its session opened.");
    }
    sessions.set(sessionId, tab.tabId);
    roots.add(sessionId);
    return sessionId;
  };

  /** Auto-attach announces each page with a session, as Chromium does for Playwright. */
  const announceAttached = (tab: PreviewCdpTab) =>
    openSession(tab).then(
      (sessionId) =>
        send({
          method: "Target.attachedToTarget",
          params: { sessionId, targetInfo: targetInfo(tab), waitingForDebugger: false },
        }),
      () => undefined,
    );

  const dropSessions = (tabId: string) => {
    for (const [sessionId, owner] of sessions) {
      if (owner !== tabId) continue;
      sessions.delete(sessionId);
      if (!roots.delete(sessionId)) continue;
      host.closeSession(tabId, sessionId);
    }
  };

  const browserCommand = async (command: CdpCommand): Promise<unknown> => {
    const params = command.params ?? {};
    if (ACKNOWLEDGED.has(command.method)) return {};
    switch (command.method) {
      case "Browser.getVersion":
        return {
          protocolVersion: "1.3",
          product: "T3 Code Preview",
          revision: "",
          userAgent: "",
          jsVersion: "",
        };
      case "Browser.close":
        throw new CdpError("T3 Code owns this browser; close tabs with Target.closeTarget.");
      case "Target.setDiscoverTargets":
        discover = params["discover"] !== false;
        if (discover) {
          // Chromium reports the existing targets right after enabling discovery.
          queueMicrotask(() => {
            for (const tab of tabs.values()) {
              send({ method: "Target.targetCreated", params: { targetInfo: targetInfo(tab) } });
            }
          });
        }
        return {};
      case "Target.getTargets":
        return { targetInfos: [...tabs.values()].map(targetInfo) };
      case "Target.getTargetInfo": {
        if (params["targetId"] === undefined) {
          return {
            targetInfo: {
              targetId: "browser",
              type: "browser",
              title: "",
              url: "",
              attached: true,
              canAccessOpener: false,
            },
          };
        }
        const tab = tabByTarget(params["targetId"]);
        if (!tab) throw new CdpError("No target with given id found");
        return { targetInfo: targetInfo(tab) };
      }
      case "Target.getBrowserContexts":
        return { browserContextIds: [] };
      case "Target.setAutoAttach": {
        const enable = params["autoAttach"] === true;
        const announce = enable && !autoAttach;
        autoAttach = enable;
        if (announce) queueMicrotask(() => tabs.forEach((tab) => void announceAttached(tab)));
        return {};
      }
      case "Target.attachToTarget": {
        if (params["flatten"] === false) {
          throw new CdpError("Only flattened sessions are supported.");
        }
        const tab = tabByTarget(params["targetId"]);
        if (!tab) throw new CdpError("No target with given id found");
        return { sessionId: await openSession(tab) };
      }
      case "Target.detachFromTarget": {
        const sessionId = params["sessionId"];
        if (typeof sessionId !== "string" || !roots.has(sessionId)) {
          throw new CdpError("No session with given id");
        }
        const tabId = sessions.get(sessionId)!;
        roots.delete(sessionId);
        sessions.delete(sessionId);
        host.closeSession(tabId, sessionId);
        const tab = tabs.get(tabId);
        queueMicrotask(() =>
          send({
            method: "Target.detachedFromTarget",
            params: { sessionId, ...(tab ? { targetId: tab.targetId } : {}) },
          }),
        );
        return {};
      }
      case "Target.activateTarget": {
        const tab = tabByTarget(params["targetId"]);
        if (!tab) throw new CdpError("No target with given id found");
        host.revealTab(tab.tabId);
        return {};
      }
      case "Target.createTarget": {
        const url = params["url"];
        const tab = await host.openTab(
          typeof url === "string" && url !== "" && url !== "about:blank" ? url : undefined,
        );
        upsertTab(tab);
        // A tool's new tab surfaces like an agent's preview_open does.
        host.revealTab(tab.tabId);
        return { targetId: tab.targetId };
      }
      case "Target.closeTarget": {
        const tab = tabByTarget(params["targetId"]);
        if (!tab) throw new CdpError("No target with given id found");
        await host.closeTab(tab.tabId);
        return { success: true };
      }
      default:
        throw new CdpError(`Not supported by T3 Code preview tabs: ${command.method}`);
    }
  };

  const pageCommand = (command: CdpCommand, tabId: string): Promise<unknown> => {
    const params = command.params ?? {};
    if (PREVIEW_OWNED_EMULATION.has(command.method)) return Promise.resolve({});
    if (command.method === "Page.close") return host.closeTab(tabId).then(() => ({}));
    if (command.method === "Page.bringToFront") {
      host.revealTab(tabId);
      return Promise.resolve({});
    }
    // A tool that pauses new frames and workers holds them up for the person
    // watching too, until its next command resumes them.
    const forwarded =
      command.method === "Target.setAutoAttach"
        ? { ...params, waitForDebuggerOnStart: false }
        : params;
    return host.sessionCommand(tabId, command.sessionId!, command.method, forwarded);
  };

  const upsertTab = (tab: PreviewCdpTab) => {
    const previous = tabs.get(tab.tabId);
    if (previous?.targetId !== undefined && previous.targetId !== tab.targetId) {
      // A swapped page is a new target.
      removeTab(tab.tabId);
    }
    const known = tabs.get(tab.tabId);
    tabs.set(tab.tabId, tab);
    if (closed) return;
    if (!known) {
      if (discover)
        send({ method: "Target.targetCreated", params: { targetInfo: targetInfo(tab) } });
      if (autoAttach) void announceAttached(tab);
      return;
    }
    if (discover && (known.url !== tab.url || known.title !== tab.title)) {
      send({ method: "Target.targetInfoChanged", params: { targetInfo: targetInfo(tab) } });
    }
  };

  const removeTab = (tabId: string) => {
    const tab = tabs.get(tabId);
    if (!tab) return;
    const tabRoots = [...roots].filter((sessionId) => sessions.get(sessionId) === tabId);
    dropSessions(tabId);
    tabs.delete(tabId);
    if (closed) return;
    for (const sessionId of tabRoots) {
      send({ method: "Target.detachedFromTarget", params: { sessionId, targetId: tab.targetId } });
    }
    if (discover) send({ method: "Target.targetDestroyed", params: { targetId: tab.targetId } });
  };

  return {
    receive: (raw) => {
      if (closed) return;
      let command: unknown;
      try {
        command = JSON.parse(raw);
      } catch {
        return;
      }
      if (!isCommand(command)) return;
      const route = command.sessionId === undefined ? {} : { sessionId: command.sessionId };
      const tabId = command.sessionId === undefined ? undefined : sessions.get(command.sessionId);
      const result =
        command.sessionId === undefined
          ? browserCommand(command)
          : tabId === undefined
            ? Promise.reject(new CdpError(`Session with given id not found.`))
            : pageCommand(command, tabId);
      // Replies leave as commands finish, as Chromium's do, so a slow
      // screenshot never holds up the commands behind it.
      void result.then(
        (value) => {
          if (!closed) send({ id: command.id, result: value ?? {}, ...route });
        },
        (cause: unknown) => {
          if (closed) return;
          send({
            id: command.id,
            error: {
              code: -32000,
              message: cause instanceof Error ? cause.message : String(cause),
            },
            ...route,
          });
        },
      );
    },
    upsertTab,
    removeTab,
    sessionEvent: (tabId, sessionId, method, params) => {
      if (closed || sessions.get(sessionId) !== tabId) return;
      const childSessionId =
        typeof params === "object" && params !== null && "sessionId" in params
          ? (params as { sessionId?: unknown }).sessionId
          : undefined;
      if (method === "Target.detachedFromTarget" && childSessionId === sessionId) {
        // The page dropped this connection's session on its own.
        sessions.delete(sessionId);
        roots.delete(sessionId);
        send({ method, params });
        return;
      }
      if (method === "Target.attachedToTarget" && typeof childSessionId === "string") {
        sessions.set(childSessionId, tabId);
      }
      if (method === "Target.detachedFromTarget" && typeof childSessionId === "string") {
        sessions.delete(childSessionId);
      }
      send({ method, params, sessionId });
    },
    close: () => {
      if (closed) return;
      closed = true;
      for (const sessionId of roots) host.closeSession(sessions.get(sessionId)!, sessionId);
      roots.clear();
      sessions.clear();
    },
  };
}
