import type { StreamEvent } from "./types";

/**
 * The live connection to the server.
 *
 * The dashboard's job is to show what agents are doing *now*, which polling
 * cannot do well: a ten-second interval either lags or floods. So the server
 * pushes, and this is the client half.
 *
 * Two details that are easy to get wrong and expensive to debug:
 *
 *  - The token goes in the query string, because `EventSource` has no way to set
 *    an `Authorization` header. It is the same secret over the same loopback
 *    request the rest of the API already makes, and the server accepts it for
 *    exactly this reason.
 *  - The server sends *named* events, so `onmessage` never fires. Each type needs
 *    its own listener, or the stream looks connected and delivers nothing.
 */

const TOKEN_KEY = "nah.studio.token";

const STREAM_TYPES = ["hello", "agent", "trace", "log", "pong"] as const;

export type StreamHandlers = {
  onEvent: (event: StreamEvent) => void;
  onOpen?: () => void;
  onClose?: () => void;
};

/**
 * Open the stream. Returns the close function.
 *
 * `EventSource` reconnects on its own, using the retry interval the server
 * sends, so this deliberately does not implement a backoff: two reconnect loops
 * racing is a worse bug than a slow reconnection.
 */
export const openStream = (handlers: StreamHandlers, path = "/api/stream"): (() => void) => {
  const token = localStorage.getItem(TOKEN_KEY);
  const url = token ? `${path}?token=${encodeURIComponent(token)}` : path;

  let source: EventSource;
  try {
    source = new EventSource(url);
  } catch {
    // `EventSource` throws rather than reporting when the URL is unusable or the
    // constructor is unavailable, and an exception here would unwind the effect
    // that called it — taking the entire dashboard down with it, on a page that was
    // otherwise fine. Reported as closed so the caller falls back to polling, which
    // is a slower dashboard rather than an empty one.
    handlers.onClose?.();
    return () => undefined;
  }

  try {
    source.addEventListener("open", () => handlers.onOpen?.());
    source.addEventListener("error", () => handlers.onClose?.());
    for (const type of STREAM_TYPES) {
      source.addEventListener(type, (message) => {
        const data = (message as MessageEvent<string>).data;
        if (!data) return;
        try {
          handlers.onEvent(JSON.parse(data) as StreamEvent);
        } catch {
          // A frame this build does not understand is skipped rather than fatal: the
          // alternative is a studio whose dashboard dies on upgrade.
        }
      });
    }
  } catch {
    handlers.onClose?.();
    return () => {
      try {
        source.close();
      } catch {
        // Already gone.
      }
    };
  }

  return () => {
    try {
      source.close();
    } catch {
      // Already gone, or never opened. Nothing to clean up either way.
    }
  };
};