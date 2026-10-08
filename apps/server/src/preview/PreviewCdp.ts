// @effect-diagnostics nodeBuiltinImport:off - Derives and checks endpoint tokens with HMAC.
/**
 * A CDP browser endpoint per thread for external tools such as agent-browser
 * and Playwright: `ws://<server>/api/preview/cdp?thread=<id>&token=<token>`.
 * Its targets are the thread's tabs wherever their pages run, as with the
 * preview tools: in the desktop app for a thread it shows, otherwise in the
 * server's own browser. See `PreviewCdpConnection` for the protocol.
 *
 * The token is an HMAC of the thread id under a key in the server's secret
 * store, so every way of getting the URL (agent tools, the CLI, the preview's
 * copy action, provider environments) hands out the same one, the CLI can
 * derive it without the server, and nothing is stored per thread. Holding it
 * grants the thread's preview tabs and nothing else.
 */
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import { ThreadId, type PreviewSessionSnapshot } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { agentBrowserSessionName } from "../mcp/McpProviderSession.ts";
import * as ProcessRunner from "../processRunner.ts";

import * as PreviewManager from "./Manager.ts";
import * as ServerBrowser from "./ServerBrowser.ts";
import {
  createPreviewCdpConnection,
  type PreviewCdpHost,
  type PreviewCdpTab,
} from "./PreviewCdpConnection.ts";

export const PREVIEW_CDP_ROUTE = "/api/preview/cdp";
/** Secret-store entry the endpoint tokens derive from. */
export const PREVIEW_CDP_KEY_NAME = "preview-cdp-key";

/** The token for one thread's endpoint. */
export const previewCdpToken = (key: Uint8Array, threadId: string): string =>
  NodeCrypto.createHmac("sha256", key).update(`preview-cdp:${threadId}`).digest("base64url");

/** The endpoint URL on an HTTP origin such as `http://127.0.0.1:3773`. */
export const previewCdpUrl = (origin: string, threadId: string, token: string): string => {
  const url = new URL(PREVIEW_CDP_ROUTE, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("thread", threadId);
  url.searchParams.set("token", token);
  return url.toString();
};

const tokensMatch = (expected: string, actual: string) => {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && NodeCrypto.timingSafeEqual(left, right);
};

const tabInfo = (snapshot: PreviewSessionSnapshot) =>
  snapshot.navStatus._tag === "Idle"
    ? { url: "about:blank", title: "" }
    : { url: snapshot.navStatus.url, title: snapshot.navStatus.title };

export class PreviewCdp extends Context.Service<
  PreviewCdp,
  {
    /** The thread's endpoint on this machine's loopback. */
    readonly urlFor: (threadId: string) => Effect.Effect<string>;
    /** Stops the thread's agent-browser daemon, if one runs, once its agents are gone. Tabs stay open. */
    readonly closeAgentBrowser: (threadId: ThreadId) => Effect.Effect<void>;
  }
>()("t3/preview/PreviewCdp") {}

/** A wildcard bind is reachable on loopback, where the tools run beside the server. */
const loopbackOrigin = (address: HttpServer.HttpServer["Service"]["address"]) =>
  NetAddress.isInetAddress(address)
    ? `http://${
        NetAddress.isUnspecified(address.address)
          ? "127.0.0.1"
          : NetAddress.formatUrlHostString(NetAddress.formatIp(address.address))
      }:${address.port}`
    : "http://127.0.0.1";

const readKey = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  return yield* secrets.getOrCreateRandom(PREVIEW_CDP_KEY_NAME, 32).pipe(Effect.orDie);
});

const make = Effect.gen(function* () {
  const httpServer = yield* HttpServer.HttpServer;
  const secrets = yield* Effect.context<ServerSecretStore.ServerSecretStore>();
  const key = yield* Effect.cached(readKey.pipe(Effect.provideContext(secrets)));
  const origin = loopbackOrigin(httpServer.address);
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  return PreviewCdp.of({
    urlFor: (threadId) =>
      key.pipe(
        Effect.map((bytes) => previewCdpUrl(origin, threadId, previewCdpToken(bytes, threadId))),
      ),
    closeAgentBrowser: (threadId) =>
      Effect.gen(function* () {
        const session = agentBrowserSessionName(threadId);
        // `close` starts a daemon when none runs, so only ask one that left its pid file.
        const pidFile = path.join(NodeOS.homedir(), ".agent-browser", `${session}.pid`);
        if (!(yield* fileSystem.exists(pidFile))) return;
        yield* processRunner.run({
          command: "agent-browser",
          args: ["--session", session, "close"],
          timeout: "10 seconds",
        });
      }).pipe(Effect.ignore),
  });
});

export const layer = Layer.effect(PreviewCdp, make);

/** Serves one client for a thread until the socket closes. */
const serveConnection = Effect.fn("PreviewCdp.serveConnection")(function* (threadId: ThreadId) {
  const browser = yield* ServerBrowser.ServerBrowser;
  const manager = yield* PreviewManager.PreviewManager;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const runFork = Effect.runForkWith(yield* Effect.context<never>());

  // Subscribe before listing, so no tab falls between the two.
  const targetChanges = yield* browser.subscribeCdpTargets;
  const managerEvents = yield* manager.subscribeEvents;

  const outgoing = yield* Queue.unbounded<string>();
  /** Sessions this connection opened, by session id, so commands reach the right page. */
  const lent = new Map<string, ServerBrowser.ServerBrowserCdpSession>();
  const lentByTab = new Map<string, Set<string>>();
  const sessionFor = (tabId: string, sessionId: string) =>
    lent.get(sessionId) ??
    // A desktop page's child sessions (iframes) travel on the session that attached them.
    [...(lentByTab.get(tabId) ?? [])].map((id) => lent.get(id)).find(Boolean);
  const host: PreviewCdpHost = {
    openTab: (url) =>
      runPromise(
        Effect.gen(function* () {
          // Opened unrevealed, as an agent's preview_open does, so the reveal
          // below floats it instead of filing it straight into the panel.
          const snapshot = yield* manager.open({
            threadId,
            ...(url === undefined ? {} : { url }),
            runtime: "server",
            reveal: false,
          });
          // The page starts where any server tab does: in the desktop app when it
          // shows the thread, otherwise in the server's own browser.
          const targetId = yield* browser.cdpTarget({ threadId, tabId: snapshot.tabId });
          return { tabId: snapshot.tabId, targetId, ...tabInfo(snapshot) };
        }),
      ),
    closeTab: (tabId) => runPromise(manager.close({ threadId, tabId })),
    revealTab: (tabId) => {
      // Unforced, as preview_open asks: the person's floating-preview setting decides.
      runFork(manager.requestReveal({ threadId, tabId, force: false }).pipe(Effect.ignore));
    },
    openSession: (tabId) =>
      runPromise(
        browser.openCdpSession({
          threadId,
          tabId,
          onEvent: (sessionId, method, params) =>
            connection.sessionEvent(tabId, sessionId, method, params),
        }),
      ).then((session) => {
        lent.set(session.sessionId, session);
        lentByTab.set(tabId, (lentByTab.get(tabId) ?? new Set()).add(session.sessionId));
        return session.sessionId;
      }),
    closeSession: (tabId, sessionId) => {
      lent.get(sessionId)?.close();
      lent.delete(sessionId);
      lentByTab.get(tabId)?.delete(sessionId);
    },
    sessionCommand: (tabId, sessionId, method, params) => {
      const session = sessionFor(tabId, sessionId);
      return session
        ? session.send(method, params, sessionId)
        : Promise.reject(new Error("Session with given id not found."));
    },
  };
  const connection = createPreviewCdpConnection(host, (message) =>
    Queue.offerUnsafe(outgoing, message),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => connection.close()));

  // A tab is a target while its page is live; its URL and title come from the manager.
  const snapshots = new Map<string, PreviewSessionSnapshot>();
  const targets = new Map<string, string>();
  const sync = (tabId: string) => {
    const snapshot = snapshots.get(tabId);
    const targetId = targets.get(tabId);
    if (snapshot && targetId !== undefined) {
      connection.upsertTab({ tabId, targetId, ...tabInfo(snapshot) } satisfies PreviewCdpTab);
    } else {
      connection.removeTab(tabId);
    }
  };
  for (const snapshot of (yield* manager.list({ threadId })).sessions) {
    snapshots.set(snapshot.tabId, snapshot);
  }
  for (const target of yield* browser.cdpTargets(threadId)) {
    targets.set(target.tabId, target.targetId);
  }
  for (const tabId of snapshots.keys()) sync(tabId);

  yield* Stream.fromSubscription(targetChanges).pipe(
    Stream.filter((change) => change.threadId === threadId),
    Stream.runForEach((change) =>
      Effect.sync(() => {
        if (change.targetId === null) targets.delete(change.tabId);
        else targets.set(change.tabId, change.targetId);
        sync(change.tabId);
      }),
    ),
    Effect.forkScoped,
  );
  yield* Stream.fromSubscription(managerEvents).pipe(
    Stream.filter((event) => event.threadId === threadId),
    Stream.runForEach((event) =>
      Effect.sync(() => {
        if (event.type === "closed") snapshots.delete(event.tabId);
        else if ("snapshot" in event) snapshots.set(event.tabId, event.snapshot);
        else return;
        sync(event.tabId);
      }),
    ),
    Effect.forkScoped,
  );

  // CDP messages can be large (screenshots), and permessage-deflate would hold them in zlib.
  delete NodeHttpServerRequest.toIncomingMessage(request).headers["sec-websocket-extensions"];
  const socket = yield* request.upgrade;
  const reader = yield* socket.reader;
  const writer = yield* socket.writer;
  const decoder = new TextDecoder();
  const send = Queue.take(outgoing).pipe(Effect.flatMap((message) => writer.write(message)));
  const receive = reader.pull.pipe(
    Effect.flatMap((chunks) =>
      Effect.sync(() => {
        for (const chunk of chunks) {
          connection.receive(typeof chunk === "string" ? chunk : decoder.decode(chunk));
        }
      }),
    ),
  );
  return yield* Effect.raceFirst(Effect.forever(send), Effect.forever(receive));
});

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url) || request.headers.upgrade?.toLowerCase() !== "websocket") {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  const threadId = decodeThreadId(url.value.searchParams.get("thread"));
  const token = url.value.searchParams.get("token") ?? "";
  const key = yield* readKey;
  if (Option.isNone(threadId) || !tokensMatch(previewCdpToken(key, threadId.value), token)) {
    return HttpServerResponse.text("Unauthorized", { status: 401 });
  }
  return yield* serveConnection(threadId.value).pipe(
    Effect.scoped,
    // A dropped socket is a normal end of a session.
    Effect.ignoreCause,
    Effect.as(HttpServerResponse.empty()),
  );
});

// Capture the services because handlers only see request-scoped ones.
export const routeLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<
      | ServerBrowser.ServerBrowser
      | PreviewManager.PreviewManager
      | ServerSecretStore.ServerSecretStore
    >();
    yield* router.add("GET", PREVIEW_CDP_ROUTE, handler.pipe(Effect.provideContext(services)));
  }),
);
