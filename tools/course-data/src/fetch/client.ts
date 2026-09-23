export type FetchOptions = {
  timeoutMs?: number;
  retries?: number;
  minIntervalMs?: number;
  maxBytes?: number;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
};

export class BoundedClient {
  private lastRequestAt = 0;
  constructor(private readonly options: FetchOptions = {}) {}

  async get(url: string): Promise<string> {
    const sleep = this.options.sleep ?? ((ms: number) => Bun.sleep(ms));
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const retries = this.options.retries ?? 2;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const wait =
        (this.options.minIntervalMs ?? 1000) -
        (Date.now() - this.lastRequestAt);
      if (wait > 0) await sleep(wait);
      this.lastRequestAt = Date.now();
      try {
        const response = await fetchImpl(url, {
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 10000),
          headers: {
            "User-Agent": "USThing-course-data/1.0 (academic schedule import)",
          },
        });
        if (!response.ok) {
          if (response.status === 429 || response.status >= 500)
            throw new Error(`RETRYABLE_HTTP_${response.status}`);
          throw new Error(`HTTP_${response.status}`);
        }
        const limit = this.options.maxBytes ?? 8_000_000;
        const declared = Number(response.headers.get("content-length"));
        if (declared > limit) throw new Error("RESPONSE_TOO_LARGE");
        const reader = response.body?.getReader();
        if (!reader) throw new Error("EMPTY_RESPONSE");
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > limit) throw new Error("RESPONSE_TOO_LARGE");
            chunks.push(value);
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        return new TextDecoder().decode(Buffer.concat(chunks));
      } catch (error) {
        if (
          attempt === retries ||
          !/RETRYABLE_HTTP_|TimeoutError|fetch failed/i.test(String(error))
        )
          throw error;
        await sleep(Math.min(8000, 250 * 2 ** attempt));
      }
    }
    throw new Error("FETCH_EXHAUSTED");
  }
}
