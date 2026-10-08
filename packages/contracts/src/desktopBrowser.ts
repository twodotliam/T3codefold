import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * The desktop app renders browser tabs for the server it launched, and the
 * server drives them with the same engine as its headless tabs. Messages
 * travel as newline-delimited JSON over two bootstrap file descriptors, so
 * only that one server can reach the desktop's pages; nothing listens on a port.
 *
 * Each tab carries one CDP connection, multiplexed by `tabId`. CDP frames pass
 * through untouched; the desktop answers them with `CdpRelay`.
 *
 * A tab can also lend independent CDP sessions to the server, which exposes
 * them to external tools such as agent-browser. Each is a real Chromium child
 * session of the tab's debugger, so its domain state is its own, and closing it
 * undoes what it changed.
 */

const TabKey = {
  threadId: TrimmedNonEmptyString,
  tabId: TrimmedNonEmptyString,
};

/** Desktop -> server. */
export const DesktopBrowserEvent = Schema.Union([
  /** A desktop `<webview>` for this server tab is attached and can be driven. */
  Schema.Struct({ type: Schema.Literal("attached"), ...TabKey }),
  /** Its `<webview>` went away: closed, crashed, swapped, or devtools took the debugger. */
  Schema.Struct({ type: Schema.Literal("detached"), ...TabKey }),
  /** One CDP message from the tab's relay. */
  Schema.Struct({ type: Schema.Literal("cdp"), ...TabKey, message: Schema.String }),
  /** Answers `openSession` and `sessionCommand`. `openSession` succeeds with `{ sessionId }`. */
  Schema.Struct({
    type: Schema.Literal("sessionReply"),
    ...TabKey,
    requestId: Schema.Int,
    result: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.String),
  }),
  /**
   * A CDP event for a lent session, or for a child session it auto-attached.
   * `Target.detachedFromTarget` names a lent session the page dropped on its own.
   */
  Schema.Struct({
    type: Schema.Literal("sessionEvent"),
    ...TabKey,
    sessionId: Schema.String,
    method: Schema.String,
    params: Schema.Unknown,
  }),
]);
export type DesktopBrowserEvent = typeof DesktopBrowserEvent.Type;

/** Server -> desktop. */
export const DesktopBrowserCommand = Schema.Union([
  /** One CDP message for the tab's relay. */
  Schema.Struct({ type: Schema.Literal("cdp"), ...TabKey, message: Schema.String }),
  /** The server stopped driving this tab, so the relay can drop its sessions. */
  Schema.Struct({ type: Schema.Literal("release"), ...TabKey }),
  /** Where an agent action is about to land, so the desktop draws its cursor there. */
  Schema.Struct({
    type: Schema.Literal("pointer"),
    ...TabKey,
    phase: Schema.Literals(["move", "click"]),
    x: Schema.Finite,
    y: Schema.Finite,
  }),
  /** Lends a new independent CDP session on the tab's page. */
  Schema.Struct({ type: Schema.Literal("openSession"), ...TabKey, requestId: Schema.Int }),
  /** Detaches a lent session, which undoes its overrides and interception. */
  Schema.Struct({ type: Schema.Literal("closeSession"), ...TabKey, sessionId: Schema.String }),
  /** One CDP command on a lent session or one of its child sessions. */
  Schema.Struct({
    type: Schema.Literal("sessionCommand"),
    ...TabKey,
    requestId: Schema.Int,
    sessionId: Schema.String,
    method: Schema.String,
    params: Schema.optional(Schema.Unknown),
  }),
]);
export type DesktopBrowserCommand = typeof DesktopBrowserCommand.Type;
