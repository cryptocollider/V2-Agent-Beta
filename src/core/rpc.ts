export type JsonRpcSuccess<T> = {
  jsonrpc: "2.0";
  id: number;
  result: T;
};

export type JsonRpcFailure = {
  jsonrpc: "2.0";
  id: number;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export type RpcClientOptions = {
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableNetworkError(err: unknown): boolean {
  const msg = String(err ?? "");
  return (
    msg.includes("fetch failed") ||
    msg.includes("UND_ERR_SOCKET") ||
    msg.includes("ECONNRESET") ||
    msg.includes("other side closed") ||
    msg.includes("socket hang up") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("aborted")
  );
}

export class JsonRpcClient {
  private nextId = 1;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly url: string,
    private readonly defaultHeaders: Record<string, string> = {},
    opts: RpcClientOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.retries = opts.retries ?? 2;
    this.retryDelayMs = opts.retryDelayMs ?? 600;
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    const id = this.nextId++;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.timeoutMs);

      try {
        console.log(`[rpc] -> ${method} ${this.url}`);

        const res = await fetch(this.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "connection": "close",
            ...this.defaultHeaders,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id,
            method,
            params,
          }),
          signal: ac.signal,
        });

        clearTimeout(timer);
        console.log(`[rpc] <- ${method} HTTP ${res.status}`);

        if (!res.ok) {
          throw new Error(`RPC HTTP ${res.status} ${res.statusText}`);
        }

        const data = (await res.json()) as JsonRpcSuccess<T> | JsonRpcFailure;

        if ("error" in data) {
          throw new Error(`RPC ${method} failed: ${data.error.message}`);
        }

        return data.result;
      } catch (err) {
        clearTimeout(timer);

        const retryable = isRetryableNetworkError(err);
        console.warn(`[rpc] ${retryable ? "network failure" : "failure"} on ${method}:`, err);

        if (!retryable || attempt >= this.retries) {
          throw err;
        }

        const delay = this.retryDelayMs * (attempt + 1);
        console.warn(`[rpc] retrying ${method} in ${delay}ms (attempt ${attempt + 1}/${this.retries})`);
        await sleep(delay);
      }
    }

    throw new Error(`RPC ${method} exhausted retries`);
  }
}