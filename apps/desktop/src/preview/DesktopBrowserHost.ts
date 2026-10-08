// @effect-diagnostics nodeBuiltinImport:off - Names download files on the shared disk.
/**
 * The desktop end of the desktop browser channel (see `DesktopBrowserEvent` in
 * contracts). The primary backend gets two file descriptors at spawn: this
 * service writes events for the desktop's tabs to one and reads commands from
 * the other. Each attached tab is reachable through its `CdpRelay`, which the
 * server's own Playwright drives, and through sessions it lends the server for
 * external tools.
 *
 * A tab is attached once its `<webview>` registers with a key the web app
 * gave it. The preview manager owns the tab's single debugger and hands it
 * here; the relay shares its root session. A lent session is a Chromium child
 * session of that root (`Target.attachToTarget` on the page's own target), so
 * its domains, overrides, and interception are its own and end with it.
 */
import {
  DesktopBrowserCommand,
  DesktopBrowserEvent,
  type DesktopBrowserEvent as DesktopBrowserEventType,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { createCdpRelayConnection, type CdpRelayConnection } from "./CdpRelay.ts";

const encodeEvent = Schema.encodeSync(Schema.fromJsonString(DesktopBrowserEvent));
const decodeCommand = Schema.decodeUnknownOption(Schema.fromJsonString(DesktopBrowserCommand));
const lineEncoder = new TextEncoder();

export interface DesktopBrowserTabKey {
  readonly threadId: string;
  readonly tabId: string;
}

/** A tab's debugger, as the preview manager lends it to the relay. */
export interface DesktopBrowserTabDebugger {
  readonly webContents: Electron.WebContents;
  readonly debugger: Electron.Debugger;
}

const keyOf = ({ threadId, tabId }: DesktopBrowserTabKey) => `${threadId}\u0000${tabId}`;

interface AttachedTab {
  readonly key: DesktopBrowserTabKey;
  readonly debuggee: DesktopBrowserTabDebugger;
  relay: CdpRelayConnection | null;
  /** Where the server wants this tab's downloads; null keeps Electron's own handling. */
  downloadDirectory: string | null;
  /** The guid CDP gave the download that is about to start. */
  pendingDownloadGuid: string | null;
  /** Sessions lent to the server, and the child sessions they auto-attached. */
  readonly lentSessions: Set<string>;
  /** The page's own CDP target id, read when a session is first lent. */
  targetId: string | undefined;
  readonly onMessage: (
    event: Electron.Event,
    method: string,
    params: unknown,
    sessionId: string,
  ) => void;
}

export class DesktopBrowserHost extends Context.Service<
  DesktopBrowserHost,
  {
    /**
     * Newline-delimited events for a backend's browser fd. Each run starts by
     * announcing the tabs already attached, so a restarted backend hears them.
     */
    readonly events: Stream.Stream<Uint8Array>;
    /** One line from the backend's browser control fd. */
    readonly handleCommandLine: (line: string) => Effect.Effect<void>;
    /** Offers a server tab's `<webview>` to the server. */
    readonly attach: (key: DesktopBrowserTabKey, debuggee: DesktopBrowserTabDebugger) => void;
    /** Withdraws it: closed, swapped, crashed, or devtools needs the debugger. */
    readonly detach: (key: DesktopBrowserTabKey) => void;
    /** Points a server tab's download at the server; false for any other download. */
    readonly placeDownload: (source: Electron.WebContents, item: Electron.DownloadItem) => boolean;
    /** The agent's cursor positions for attached tabs, keyed by their server tab. */
    readonly pointers: Stream.Stream<{
      readonly key: DesktopBrowserTabKey;
      readonly phase: "move" | "click";
      readonly x: number;
      readonly y: number;
    }>;
  }
>()("@t3tools/desktop/preview/DesktopBrowserHost") {}

export const make = Effect.gen(function* () {
  const outbox = yield* PubSub.unbounded<DesktopBrowserEventType>();
  const pointers = yield* PubSub.sliding<{
    readonly key: DesktopBrowserTabKey;
    readonly phase: "move" | "click";
    readonly x: number;
    readonly y: number;
  }>(16);
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const tabs = new Map<string, AttachedTab>();
  const emit = (event: DesktopBrowserEventType) => runFork(PubSub.publish(outbox, event));

  const relayFor = (tab: AttachedTab) => {
    if (tab.relay) return tab.relay;
    const { webContents, debugger: debuggee } = tab.debuggee;
    const relay: CdpRelayConnection = createCdpRelayConnection(
      {
        send: (method, params, sessionId) =>
          sessionId === undefined
            ? debuggee.sendCommand(method, params)
            : debuggee.sendCommand(method, params, sessionId),
        targetId: () =>
          debuggee
            .sendCommand("Target.getTargetInfo")
            .then((result: { targetInfo: { targetId: string } }) => result.targetInfo.targetId),
        url: () => webContents.getURL(),
        title: () => webContents.getTitle(),
        userAgent: () => webContents.getUserAgent(),
        setDownloadDirectory: (directory) => {
          tab.downloadDirectory = directory;
        },
      },
      // A released relay's late replies belong to a connection that is gone.
      (message) => {
        if (tab.relay === relay && tabs.get(keyOf(tab.key)) === tab) {
          emit({ type: "cdp", ...tab.key, message });
        }
      },
    );
    tab.relay = relay;
    return relay;
  };

  /**
   * Saves a download from a server tab where the server's Playwright expects
   * it. Without a path Electron would open its Save dialog over the app for a
   * file the agent asked for. CDP names the download just before this runs.
   */
  const placeDownload = (source: Electron.WebContents, item: Electron.DownloadItem) => {
    const tab = [...tabs.values()].find(
      (candidate) => candidate.debuggee.webContents === source && candidate.downloadDirectory,
    );
    if (!tab?.downloadDirectory || !tab.pendingDownloadGuid) return false;
    item.setSavePath(NodePath.join(tab.downloadDirectory, tab.pendingDownloadGuid));
    tab.pendingDownloadGuid = null;
    return true;
  };

  const isCurrent = (tab: AttachedTab) => tabs.get(keyOf(tab.key)) === tab;

  /** Detaches every lent session, undoing what each changed on the page. */
  const releaseLentSessions = (tab: AttachedTab) => {
    const debuggee = tab.debuggee.debugger;
    for (const sessionId of tab.lentSessions) {
      if (debuggee.isAttached()) {
        debuggee.sendCommand("Target.detachFromTarget", { sessionId }).catch(() => undefined);
      }
    }
    tab.lentSessions.clear();
  };

  /**
   * Routes a debugger event. Lent sessions' events go only to the server's
   * session stream; everything else goes to the relay as before.
   */
  const routeMessage = (tab: AttachedTab, method: string, params: unknown, sessionId: string) => {
    const childSessionId =
      typeof params === "object" && params !== null && "sessionId" in params
        ? (params as { sessionId?: unknown }).sessionId
        : undefined;
    if (sessionId && tab.lentSessions.has(sessionId)) {
      // A lent session's own auto-attached children (iframes, workers) are lent too.
      if (method === "Target.attachedToTarget" && typeof childSessionId === "string") {
        tab.lentSessions.add(childSessionId);
      }
      if (method === "Target.detachedFromTarget" && typeof childSessionId === "string") {
        tab.lentSessions.delete(childSessionId);
      }
      emit({ type: "sessionEvent", ...tab.key, sessionId, method, params: params ?? {} });
      return;
    }
    const attachedTargetId =
      method === "Target.attachedToTarget"
        ? (params as { targetInfo?: { targetId?: unknown } } | undefined)?.targetInfo?.targetId
        : undefined;
    if (
      !sessionId &&
      typeof childSessionId === "string" &&
      attachedTargetId !== undefined &&
      attachedTargetId === tab.targetId
    ) {
      // Only lending attaches to the page's own target; the relay fakes its
      // own. Chromium announces the session before attachToTarget replies, and
      // the server's Playwright would detach a target it does not know.
      tab.lentSessions.add(childSessionId);
      return;
    }
    if (
      method === "Target.detachedFromTarget" &&
      typeof childSessionId === "string" &&
      tab.lentSessions.delete(childSessionId)
    ) {
      // The page dropped a lent session on its own, for example when it crashed.
      emit({ type: "sessionEvent", ...tab.key, sessionId: childSessionId, method, params });
      return;
    }
    if (method === "Browser.downloadWillBegin") {
      const guid = (params as { guid?: unknown } | undefined)?.guid;
      tab.pendingDownloadGuid = typeof guid === "string" ? guid : null;
    }
    tab.relay?.event(method, params, sessionId);
  };

  const detach = (key: DesktopBrowserTabKey) => {
    const id = keyOf(key);
    const tab = tabs.get(id);
    if (!tab) return;
    tabs.delete(id);
    tab.debuggee.debugger.off("message", tab.onMessage);
    releaseLentSessions(tab);
    emit({ type: "detached", ...key });
  };

  const attach = (key: DesktopBrowserTabKey, debuggee: DesktopBrowserTabDebugger) => {
    const id = keyOf(key);
    if (tabs.get(id)?.debuggee.webContents === debuggee.webContents) return;
    detach(key);
    const tab: AttachedTab = {
      key,
      debuggee,
      relay: null,
      downloadDirectory: null,
      pendingDownloadGuid: null,
      lentSessions: new Set(),
      targetId: undefined,
      onMessage: (_event, method, params, sessionId) =>
        routeMessage(tab, method, params, sessionId),
    };
    tabs.set(id, tab);
    debuggee.debugger.on("message", tab.onMessage);
    emit({ type: "attached", ...key });
  };

  const replySession = (tab: AttachedTab, requestId: number, run: () => Promise<unknown>): void => {
    void run().then(
      (result) => {
        if (isCurrent(tab)) {
          emit({ type: "sessionReply", ...tab.key, requestId, result: result ?? {} });
        }
      },
      (cause: unknown) => {
        if (isCurrent(tab)) {
          emit({
            type: "sessionReply",
            ...tab.key,
            requestId,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }
      },
    );
  };

  const openSession = async (tab: AttachedTab) => {
    const debuggee = tab.debuggee.debugger;
    const { targetInfo } = (await debuggee.sendCommand("Target.getTargetInfo")) as {
      targetInfo: { targetId: string };
    };
    tab.targetId = targetInfo.targetId;
    const { sessionId } = (await debuggee.sendCommand("Target.attachToTarget", {
      targetId: targetInfo.targetId,
      flatten: true,
    })) as { sessionId: string };
    if (!isCurrent(tab)) {
      debuggee.sendCommand("Target.detachFromTarget", { sessionId }).catch(() => undefined);
      throw new Error("The tab detached while its session opened.");
    }
    tab.lentSessions.add(sessionId);
    return { sessionId, targetId: targetInfo.targetId };
  };

  const handleCommandLine = (line: string) =>
    Effect.sync(() => {
      const command = decodeCommand(line);
      if (Option.isNone(command)) return;
      const tab = tabs.get(keyOf(command.value));
      if (!tab) {
        // A request for a tab that is gone still needs its answer.
        if (command.value.type === "openSession" || command.value.type === "sessionCommand") {
          const { threadId, tabId, requestId } = command.value;
          emit({
            type: "sessionReply",
            threadId,
            tabId,
            requestId,
            error: "The tab is not attached.",
          });
        }
        return;
      }
      switch (command.value.type) {
        case "pointer": {
          const { threadId, tabId, phase, x, y } = command.value;
          runFork(PubSub.publish(pointers, { key: { threadId, tabId }, phase, x, y }));
          return;
        }
        case "release":
          // A new server connection starts with a fresh relay and fresh sessions.
          tab.relay = null;
          return;
        case "cdp":
          relayFor(tab).receive(command.value.message);
          return;
        case "openSession":
          replySession(tab, command.value.requestId, () => openSession(tab));
          return;
        case "closeSession": {
          const { sessionId } = command.value;
          if (!tab.lentSessions.delete(sessionId)) return;
          tab.debuggee.debugger
            .sendCommand("Target.detachFromTarget", { sessionId })
            .catch(() => undefined);
          return;
        }
        case "sessionCommand": {
          const { requestId, sessionId, method, params } = command.value;
          if (!tab.lentSessions.has(sessionId)) {
            emit({ type: "sessionReply", ...tab.key, requestId, error: "Unknown session." });
            return;
          }
          replySession(tab, requestId, () =>
            tab.debuggee.debugger.sendCommand(
              method,
              (params ?? {}) as Record<string, unknown>,
              sessionId,
            ),
          );
          return;
        }
      }
    });

  // Read when a backend starts, not when the host is built.
  const announceAll = Effect.suspend(() =>
    Effect.forEach(
      [...tabs.values()],
      (tab) => {
        tab.relay = null;
        // The previous backend's lent sessions have no one left to answer.
        releaseLentSessions(tab);
        return PubSub.publish(outbox, { type: "attached", ...tab.key });
      },
      { discard: true },
    ),
  );

  return DesktopBrowserHost.of({
    pointers: Stream.fromPubSub(pointers),
    // Subscribes before announcing, so no attach falls between the two.
    events: Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(outbox);
        yield* announceAll;
        return Stream.fromSubscription(subscription);
      }),
    ).pipe(Stream.map((event) => lineEncoder.encode(`${encodeEvent(event)}\n`))),
    handleCommandLine,
    attach,
    detach,
    placeDownload,
  });
});

export const layer = Layer.effect(DesktopBrowserHost, make);
