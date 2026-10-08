// @effect-diagnostics nodeBuiltinImport:off - Bridges Playwright's WebSocket transport to the desktop's fds.
/**
 * The server end of the desktop browser channel (see `DesktopBrowserEvent`).
 *
 * Playwright connects over CDP only through a WebSocket URL, so each attached
 * desktop tab gets a loopback endpoint with an unguessable path. Its frames
 * cross the bootstrap file descriptors to the desktop's relay, which owns the
 * tab's `webContents.debugger`. The endpoint only bridges to that one tab.
 *
 * Tabs also lend independent CDP sessions (`openSession`), which the preview
 * CDP endpoint hands to external tools. Their commands and events travel as
 * typed messages rather than relay frames.
 */
import * as NodeStream from "@effect/platform-node/NodeStream";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import {
  DesktopBrowserCommand,
  DesktopBrowserEvent,
  type DesktopBrowserCommand as DesktopBrowserCommandType,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Ndjson from "effect/encoding/Ndjson";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import * as ServerConfig from "../config.ts";
import { writeAllToFileDescriptor } from "../resourceTelemetry/DesktopTelemetryReceiver.ts";

const decodeEvent = Schema.decodeUnknownEffect(DesktopBrowserEvent);
const encodeCommand = Schema.encodeEffect(Schema.fromJsonString(DesktopBrowserCommand));

export interface DesktopTabKey {
  readonly threadId: string;
  readonly tabId: string;
}

const keyOf = ({ threadId, tabId }: DesktopTabKey) => `${threadId}\u0000${tabId}`;

/** A CDP event on a lent session or one of its auto-attached children. */
export interface DesktopSessionEvent extends DesktopTabKey {
  readonly sessionId: string;
  readonly method: string;
  readonly params: unknown;
}

export class DesktopBrowserSessionError extends Schema.TaggedError<DesktopBrowserSessionError>()(
  "DesktopBrowserSessionError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}

export class DesktopBrowserChannel extends Context.Service<
  DesktopBrowserChannel,
  {
    /** False when this server was not started by a desktop app. */
    readonly available: boolean;
    /**
     * Waits for a tab to be attached. Subscribes before it checks, so an
     * attach landing in between is never missed. False after `timeout`.
     */
    readonly awaitAttached: (key: DesktopTabKey, timeout: Duration.Input) => Effect.Effect<boolean>;
    /** Desktop tabs as they detach. */
    readonly detached: Stream.Stream<DesktopTabKey>;
    readonly isAttached: (key: DesktopTabKey) => Effect.Effect<boolean>;
    /**
     * A one-connection CDP endpoint for an attached tab. Closing the scope
     * releases the tab on the desktop and stops the endpoint.
     */
    readonly endpoint: (key: DesktopTabKey) => Effect.Effect<string, never, Scope.Scope>;
    /**
     * Opens an independent CDP session on an attached tab's page. Detaching it
     * with `closeSession` undoes its overrides and interception.
     */
    readonly openSession: (key: DesktopTabKey) => Effect.Effect<string, DesktopBrowserSessionError>;
    readonly closeSession: (key: DesktopTabKey, sessionId: string) => Effect.Effect<void>;
    /** Sends one CDP command on a lent session, failing with the page's CDP error. */
    readonly sessionCommand: (
      key: DesktopTabKey,
      sessionId: string,
      method: string,
      params: unknown,
    ) => Effect.Effect<unknown, DesktopBrowserSessionError>;
    /** Events on every lent session. Only sessions someone opened produce any. */
    readonly subscribeSessionEvents: Effect.Effect<
      PubSub.Subscription<DesktopSessionEvent>,
      never,
      Scope.Scope
    >;
    /** Draws the agent's cursor over a tab the desktop renders. */
    readonly pointer: (
      key: DesktopTabKey,
      pointer: { readonly phase: "move" | "click"; readonly x: number; readonly y: number },
    ) => Effect.Effect<void>;
  }
>()("t3/preview/DesktopBrowserChannel") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const inputFd = config.desktopBrowserFd;
  const controlFd = config.desktopBrowserControlFd;
  const changes = yield* PubSub.unbounded<{ key: DesktopTabKey; attached: boolean }>();
  const attachedTabs = new Set<string>();
  const sessionEvents = yield* PubSub.unbounded<DesktopSessionEvent>();
  /** Lent-session requests awaiting the desktop's reply, by request id. */
  const pending = new Map<
    number,
    { readonly id: string; readonly reply: Deferred.Deferred<unknown, DesktopBrowserSessionError> }
  >();
  let nextRequestId = 0;
  /** CDP frames from the desktop, per tab, for the endpoint connected to it. */
  const inbound = new Map<string, Queue.Queue<string>>();
  const writeLock = yield* Semaphore.make(1);

  if (inputFd === undefined || controlFd === undefined) {
    return DesktopBrowserChannel.of({
      available: false,
      awaitAttached: () => Effect.succeed(false),
      detached: Stream.empty,
      isAttached: () => Effect.succeed(false),
      endpoint: () => Effect.die("No desktop app is attached to this server."),
      openSession: () =>
        Effect.fail(new DesktopBrowserSessionError({ detail: "No desktop app is attached." })),
      closeSession: () => Effect.void,
      sessionCommand: () =>
        Effect.fail(new DesktopBrowserSessionError({ detail: "No desktop app is attached." })),
      subscribeSessionEvents: PubSub.subscribe(sessionEvents),
      pointer: () => Effect.void,
    });
  }

  const command = (message: DesktopBrowserCommandType) =>
    writeLock.withPermits(1)(
      encodeCommand(message).pipe(
        Effect.flatMap((line) => writeAllToFileDescriptor(controlFd, Buffer.from(`${line}\n`))),
        Effect.catchCause((cause) =>
          Effect.logWarning("desktop browser command failed", { cause }),
        ),
      ),
    );

  const failPending = (
    matches: (entry: { readonly id: string }) => boolean,
    detail: string,
  ): Effect.Effect<void> =>
    Effect.forEach(
      [...pending].filter(([, entry]) => matches(entry)),
      ([requestId, entry]) => {
        pending.delete(requestId);
        return Deferred.fail(entry.reply, new DesktopBrowserSessionError({ detail }));
      },
      { discard: true },
    );

  const readable = yield* Effect.acquireRelease(
    Effect.sync(() => NodeFS.createReadStream("", { fd: inputFd, autoClose: true })),
    (stream) => Effect.sync(() => stream.destroy()),
  );
  yield* NodeStream.fromReadable<Uint8Array, Error>({
    evaluate: () => readable,
    closeOnDone: true,
    onError: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(
    Stream.pipeThroughChannel(Ndjson.decode({ ignoreEmptyLines: true })),
    Stream.mapEffect((value) => decodeEvent(value).pipe(Effect.option)),
    Stream.runForEach((decoded) => {
      if (Option.isNone(decoded)) return Effect.void;
      const event = decoded.value;
      const key = { threadId: event.threadId, tabId: event.tabId };
      const id = keyOf(key);
      switch (event.type) {
        case "cdp": {
          const queue = inbound.get(id);
          return queue ? Queue.offer(queue, event.message).pipe(Effect.asVoid) : Effect.void;
        }
        case "attached":
          attachedTabs.add(id);
          return PubSub.publish(changes, { key, attached: true });
        case "detached": {
          attachedTabs.delete(id);
          const queue = inbound.get(id);
          return (queue ? Queue.shutdown(queue) : Effect.void).pipe(
            Effect.andThen(failPending((entry) => entry.id === id, "The tab detached.")),
            Effect.andThen(PubSub.publish(changes, { key, attached: false })),
          );
        }
        case "sessionReply": {
          const entry = pending.get(event.requestId);
          if (!entry) return Effect.void;
          pending.delete(event.requestId);
          return event.error === undefined
            ? Deferred.succeed(entry.reply, event.result)
            : Deferred.fail(entry.reply, new DesktopBrowserSessionError({ detail: event.error }));
        }
        case "sessionEvent":
          return PubSub.publish(sessionEvents, {
            ...key,
            sessionId: event.sessionId,
            method: event.method,
            params: event.params,
          });
      }
    }),
    Effect.catchCause((cause) => Effect.logWarning("desktop browser channel stopped", { cause })),
    Effect.andThen(failPending(() => true, "The desktop app disconnected.")),
    Effect.forkScoped,
  );

  /** Sends a lent-session request and waits for the desktop's reply. */
  const request = (
    key: DesktopTabKey,
    message: (requestId: number) => DesktopBrowserCommandType,
  ): Effect.Effect<unknown, DesktopBrowserSessionError> =>
    Effect.gen(function* () {
      const id = keyOf(key);
      if (!attachedTabs.has(id)) {
        return yield* new DesktopBrowserSessionError({ detail: "The tab is not attached." });
      }
      const requestId = ++nextRequestId;
      const reply = yield* Deferred.make<unknown, DesktopBrowserSessionError>();
      pending.set(requestId, { id, reply });
      yield* command(message(requestId));
      return yield* Deferred.await(reply).pipe(
        Effect.onInterrupt(() => Effect.sync(() => pending.delete(requestId))),
      );
    });

  const endpoint = (key: DesktopTabKey) =>
    Effect.gen(function* () {
      const id = keyOf(key);
      const secret = NodeCrypto.randomBytes(24).toString("base64url");
      const server = yield* NodeSocketServer.makeWebSocket({
        host: "127.0.0.1",
        port: 0,
        path: `/${secret}`,
      }).pipe(Effect.orDie);
      const queue = yield* Queue.unbounded<string>();
      inbound.set(id, queue);
      // A detach before this registration shut down no queue, so check again.
      if (!attachedTabs.has(id)) {
        inbound.delete(id);
        return yield* Effect.die("The desktop tab detached before the server connected.");
      }
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (inbound.get(id) === queue) inbound.delete(id);
          yield* Queue.shutdown(queue);
          yield* command({ type: "release", ...key });
        }),
      );
      // The relay serves one Playwright connection; a second would see the first's sessions.
      let connected = false;
      yield* server
        .run((socket) =>
          Effect.gen(function* () {
            if (connected) return;
            connected = true;
            const writer = yield* socket.writer;
            const reader = yield* socket.reader;
            yield* Stream.fromQueue(queue).pipe(
              Stream.runForEach((message) => writer.write(message)),
              Effect.forkScoped,
            );
            const decoder = new TextDecoder();
            return yield* reader.pull.pipe(
              Effect.flatMap((frames) =>
                Effect.forEach(
                  frames,
                  (frame) =>
                    command({
                      type: "cdp",
                      ...key,
                      message: typeof frame === "string" ? frame : decoder.decode(frame),
                    }),
                  { discard: true },
                ),
              ),
              Effect.forever,
            );
          }).pipe(Effect.scoped, Effect.ignore),
        )
        .pipe(Effect.forkScoped);
      const address = server.address;
      if (address._tag !== "InetAddressV4") return yield* Effect.die("Unexpected relay address.");
      return `ws://127.0.0.1:${address.port}/${secret}`;
    });

  return DesktopBrowserChannel.of({
    available: true,
    awaitAttached: (key, timeout) =>
      Effect.scoped(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          if (attachedTabs.has(keyOf(key))) return true;
          return yield* Stream.fromSubscription(subscription).pipe(
            Stream.filter((change) => change.attached && keyOf(change.key) === keyOf(key)),
            Stream.runHead,
            Effect.map(Option.isSome),
            Effect.timeoutOption(timeout),
            Effect.map((result) => Option.getOrElse(result, () => false)),
          );
        }),
      ),
    detached: Stream.fromPubSub(changes).pipe(
      Stream.filter((change) => !change.attached),
      Stream.map((change) => change.key),
    ),
    isAttached: (key) => Effect.sync(() => attachedTabs.has(keyOf(key))),
    endpoint,
    openSession: (key) =>
      request(key, (requestId) => ({ type: "openSession", ...key, requestId })).pipe(
        Effect.flatMap((result) => {
          const sessionId = (result as { sessionId?: unknown } | null)?.sessionId;
          return typeof sessionId === "string"
            ? Effect.succeed(sessionId)
            : Effect.fail(
                new DesktopBrowserSessionError({ detail: "The desktop opened no session." }),
              );
        }),
      ),
    closeSession: (key, sessionId) => command({ type: "closeSession", ...key, sessionId }),
    sessionCommand: (key, sessionId, method, params) =>
      request(key, (requestId) => ({
        type: "sessionCommand",
        ...key,
        requestId,
        sessionId,
        method,
        params,
      })),
    subscribeSessionEvents: PubSub.subscribe(sessionEvents),
    pointer: (key, pointer) => command({ type: "pointer", ...key, ...pointer }),
  });
});

export const layer = Layer.effect(DesktopBrowserChannel, make);
