import WebSocket from "ws";

export type WsEventEnvelope = {
  topic?: string;
  type?: string;
  data?: unknown;
  [k: string]: unknown;
};

export type EventsWsClient = {
  connect(): Promise<void>;
  close(): void;
  onEvent(fn: (evt: WsEventEnvelope) => void): void;
  onStatus(fn: (status: "connecting" | "open" | "closed" | "error") => void): void;
};

export function buildEventsWsUrlFromRpc(rpcUrl: string): string {
  const u = new URL(rpcUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/ws/events";
  u.search = "";
  return u.toString();
}

export function createEventsWsClient(url: string): EventsWsClient {
  let ws: WebSocket | null = null;
  const eventHandlers: Array<(evt: WsEventEnvelope) => void> = [];
  const statusHandlers: Array<(status: "connecting" | "open" | "closed" | "error") => void> = [];

  function emitStatus(status: "connecting" | "open" | "closed" | "error") {
    for (const fn of statusHandlers) fn(status);
  }

  function emitEvent(evt: WsEventEnvelope) {
    for (const fn of eventHandlers) fn(evt);
  }

  return {
    async connect(): Promise<void> {
      emitStatus("connecting");

      await new Promise<void>((resolve, reject) => {
        ws = new WebSocket(url);

        ws.on("open", () => {
          emitStatus("open");
          resolve();
        });

        ws.on("message", (buf) => {
          try {
            const txt = String(buf);
            const parsed = JSON.parse(txt) as WsEventEnvelope;
            emitEvent(parsed);
          } catch {
            // Ignore malformed frames for now.
          }
        });

        ws.on("close", () => {
          emitStatus("closed");
        });

        ws.on("error", (err) => {
          emitStatus("error");
          reject(err);
        });
      });
    },

    close(): void {
      if (ws) {
        ws.close();
        ws = null;
      }
    },

    onEvent(fn: (evt: WsEventEnvelope) => void): void {
      eventHandlers.push(fn);
    },

    onStatus(fn: (status: "connecting" | "open" | "closed" | "error") => void): void {
      statusHandlers.push(fn);
    },
  };
}