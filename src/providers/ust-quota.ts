import { load } from "cheerio";
import { ACADEMIC_SOURCE } from "../domain/academic.js";

export type QuotaTarget = {
  termCode: string;
  subject: string;
  courseCode: string;
  sectionId: string;
  classNbr: string;
};

export type QuotaObservation = {
  snapshotId: string;
  sectionId: string;
  capacity: number | null;
  enrolled: number | null;
  remaining: number | null;
  waitlisted: number | null;
  reserveCapacity: number | null;
  observedAt: string;
  source: string;
};

export interface QuotaSource {
  fetchQuota(target: QuotaTarget): Promise<QuotaObservation>;
}

export class QuotaProviderError extends Error {
  constructor(
    readonly retryable: boolean,
    readonly code: string,
  ) {
    super(code);
  }
}

function quotaNumber(value: string): number | null {
  if (!value) return null;
  if (!/^\d+$/.test(value))
    throw new QuotaProviderError(false, "QUOTA_FORMAT_INVALID");
  return Number(value);
}

export function parseUstQuota(
  html: string,
  target: QuotaTarget,
  observedAt: string,
): QuotaObservation {
  const $ = load(html);
  let cells: ReturnType<typeof $> | undefined;
  $("#classes .course").each((_, course) => {
    const heading = $(course).find(".subject").first().text().trim();
    if (
      !heading.startsWith(
        `${target.subject} ${target.courseCode.slice(target.subject.length)} `,
      )
    )
      return;
    $(course)
      .find("table.sections tr.newsect")
      .each((_, row) => {
        const candidate = $(row).children("td");
        const match = /\((\d+)\)/.exec(candidate.eq(0).text());
        if (match?.[1] === target.classNbr) cells = candidate;
      });
  });
  if (!cells) throw new QuotaProviderError(false, "SECTION_NOT_IN_PROVIDER");
  const cell = (index: number) =>
    (
      cells?.eq(index).clone().find(".quotadetail").remove().end().text() ?? ""
    ).trim();
  const capacity = quotaNumber(cell(5));
  const enrolled = quotaNumber(cell(6));
  const remaining = quotaNumber(cell(7));
  const waitlisted = quotaNumber(cell(8));
  if (
    [capacity, enrolled, remaining, waitlisted].every((value) => value === null)
  )
    throw new QuotaProviderError(false, "QUOTA_NOT_PUBLISHED");
  return {
    snapshotId: `${target.sectionId}@${observedAt}`,
    sectionId: target.sectionId,
    capacity,
    enrolled,
    remaining:
      remaining ??
      (capacity !== null && enrolled !== null ? capacity - enrolled : null),
    waitlisted,
    reserveCapacity: null,
    observedAt,
    source: ACADEMIC_SOURCE,
  };
}

export class FixtureQuotaSource implements QuotaSource {
  readonly calls: QuotaTarget[] = [];
  constructor(private readonly observations: Map<string, QuotaObservation>) {}
  async fetchQuota(target: QuotaTarget): Promise<QuotaObservation> {
    this.calls.push(target);
    const observation = this.observations.get(target.sectionId);
    if (!observation)
      throw new QuotaProviderError(false, "SECTION_NOT_IN_PROVIDER");
    return observation;
  }
}

export type UstQuotaOptions = {
  baseUrl?: string;
  timeoutMs?: number;
  maxBytes?: number;
  minIntervalMs?: number;
  retries?: number;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
};

export class UstQuotaSource implements QuotaSource {
  private lastRequestAt = 0;
  constructor(private readonly options: UstQuotaOptions = {}) {}

  private nowMs() {
    return (this.options.now?.() ?? new Date()).getTime();
  }

  async fetchQuota(target: QuotaTarget): Promise<QuotaObservation> {
    if (
      !/^\d{2}(10|20|30|40)$/.test(target.termCode) ||
      !/^[A-Z]{2,8}$/.test(target.subject) ||
      !/^[A-Z]{2,8}\d+[A-Z]?$/.test(target.courseCode) ||
      !target.courseCode.startsWith(target.subject) ||
      !/^\d+$/.test(target.classNbr)
    ) {
      throw new QuotaProviderError(false, "QUOTA_TARGET_INVALID");
    }
    const base = this.options.baseUrl ?? "https://w5.ab.ust.hk/wcq/cgi-bin";
    const url = `${base.replace(/\/$/, "")}/${target.termCode}/subject/${target.subject}`;
    const sleep = this.options.sleep ?? ((ms: number) => Bun.sleep(ms));
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const retries = this.options.retries ?? 2;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const requestStartedAt = this.nowMs();
      const delay =
        (this.options.minIntervalMs ?? 1000) -
        (requestStartedAt - this.lastRequestAt);
      if (delay > 0) await sleep(delay);
      this.lastRequestAt = this.nowMs();
      try {
        const observedAt = new Date(this.nowMs()).toISOString();
        const response = await fetchImpl(url, {
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 10000),
          headers: { "User-Agent": "USThing-academic-refresh/1.0" },
        });
        if (!response.ok)
          throw new QuotaProviderError(
            response.status === 429 || response.status >= 500,
            `HTTP_${response.status}`,
          );
        const limit = this.options.maxBytes ?? 8_000_000;
        const reader = response.body?.getReader();
        if (!reader) throw new QuotaProviderError(true, "EMPTY_RESPONSE");
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.length;
            if (size > limit)
              throw new QuotaProviderError(false, "RESPONSE_TOO_LARGE");
            chunks.push(chunk.value);
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        return parseUstQuota(
          new TextDecoder().decode(Buffer.concat(chunks)),
          target,
          observedAt,
        );
      } catch (error) {
        const retryable =
          error instanceof QuotaProviderError
            ? error.retryable
            : /TimeoutError|fetch failed/i.test(String(error));
        if (!retryable || attempt === retries)
          throw error instanceof QuotaProviderError
            ? error
            : new QuotaProviderError(retryable, "PROVIDER_NETWORK_ERROR");
        await sleep(Math.min(8000, 250 * 2 ** attempt));
      }
    }
    throw new QuotaProviderError(true, "PROVIDER_RETRY_EXHAUSTED");
  }
}
