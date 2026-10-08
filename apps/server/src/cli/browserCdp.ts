/**
 * `t3 browser cdp-url <thread-id>` - prints a thread's preview CDP endpoint, for
 * driving its desktop-rendered tabs with agent-browser (`--cdp <url>`),
 * Playwright's `connectOverCDP`, or another CDP client on this machine.
 *
 * The token derives from the running server's secret store, so this prints
 * the same URL agents receive and needs no request to the server.
 */
import { ThreadId } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { Argument, Command, GlobalFlag } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { PREVIEW_CDP_KEY_NAME, previewCdpToken, previewCdpUrl } from "../preview/PreviewCdp.ts";
import { baseDirFlag } from "./config.ts";
import { discoverPairTarget, makePairServerConfig } from "./pair.ts";

const WILDCARD_HOSTS = new Set(["", "0.0.0.0", "::", "[::]"]);

/** The running server's origin on loopback, where the tools run. */
export const loopbackOrigin = (host: string | undefined, port: number) => {
  const reachable = host === undefined || WILDCARD_HOSTS.has(host) ? "127.0.0.1" : host;
  return `http://${reachable.includes(":") && !reachable.startsWith("[") ? `[${reachable}]` : reachable}:${port}`;
};

export const browserCdpUrlCommand = Command.make("cdp-url", {
  baseDir: baseDirFlag,
  threadId: Argument.String("thread-id").pipe(
    Argument.withSchema(ThreadId),
    Argument.withDescription("The thread whose preview tabs the endpoint exposes."),
  ),
}).pipe(
  Command.withDescription(
    "Print a thread's CDP endpoint for driving its desktop preview tabs with agent-browser or Playwright.",
  ),
  Command.withHandler((input) =>
    Effect.gen(function* () {
      const logLevel = Option.getOrElse(yield* GlobalFlag.LogLevel, () => "Warn" as const);
      const target = yield* discoverPairTarget(Option.getOrUndefined(input.baseDir));
      const config = yield* makePairServerConfig({ target, logLevel });
      const key = yield* Effect.gen(function* () {
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        return yield* secrets.getOrCreateRandom(PREVIEW_CDP_KEY_NAME, 32);
      }).pipe(
        Effect.provide(ServerSecretStore.layer.pipe(Layer.provide(ServerConfig.layer(config)))),
      );
      const origin = loopbackOrigin(target.state.host, target.state.port);
      yield* Console.log(
        previewCdpUrl(origin, input.threadId, previewCdpToken(key, input.threadId)),
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  ),
);
