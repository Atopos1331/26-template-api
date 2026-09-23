import { Temporal } from "@js-temporal/polyfill";
import {
  type CalendarOccurrence,
  type CalendarWindow,
  detectConflicts,
  expandManualEvent,
  sortOccurrences,
  timeBanner,
} from "../domain/calendar.js";
import { EventError } from "../domain/events.js";
import type { EventRepository } from "../repositories/events.js";

export interface CalendarSource {
  readonly source: string;
  load(
    owner: string,
    window: CalendarWindow,
    maxItems: number,
  ): Promise<CalendarOccurrence[]>;
  resolvesCalendarKey?(owner: string, key: string): Promise<boolean>;
}

export class ManualCalendarSource implements CalendarSource {
  readonly source = "manual";

  constructor(private readonly events: EventRepository) {}

  async load(owner: string, window: CalendarWindow, maxItems: number) {
    const items: CalendarOccurrence[] = [];
    for await (const event of this.events.calendarCandidates(owner, window)) {
      items.push(...expandManualEvent(event, window, maxItems - items.length));
    }
    return items;
  }

  suppressedKeys(owner: string) {
    return this.events.suppressedKeys(owner);
  }
}

export class CoursePlanCalendarSource implements CalendarSource {
  readonly source = "course";

  constructor(
    private readonly loader: (
      owner: string,
      window: CalendarWindow,
      planId?: string,
      termCode?: string,
    ) => Promise<CalendarOccurrence[]>,
    private readonly resolver: (owner: string, key: string) => Promise<boolean>,
    private readonly planId?: string,
    private readonly termCode?: string,
  ) {}

  async load(owner: string, window: CalendarWindow, maxItems: number) {
    const items = await this.loader(owner, window, this.planId, this.termCode);
    if (items.length > maxItems)
      throw new EventError(
        "calendar_window_too_dense",
        400,
        "Choose a narrower calendar window",
      );
    return items;
  }

  resolvesCalendarKey(owner: string, key: string) {
    return this.resolver(owner, key);
  }
}

export type CalendarSettings = {
  timezone: string;
  maxItems: number;
  maxConflicts: number;
  upcomingHours: number;
};

export class CalendarService {
  constructor(
    private readonly manual: ManualCalendarSource,
    private readonly sources: CalendarSource[],
    private readonly settings: CalendarSettings,
  ) {}

  async canSupersede(owner: string, key: string) {
    for (const source of this.sources) {
      if (
        source.source !== "manual" &&
        (await source.resolvesCalendarKey?.(owner, key))
      )
        return true;
    }
    return false;
  }

  async list(owner: string, window: CalendarWindow) {
    const byKey = new Map<string, CalendarOccurrence>();
    for (const source of this.sources) {
      const items = await source.load(
        owner,
        window,
        this.settings.maxItems + 1,
      );
      for (const item of items) byKey.set(item.calendarKey, item);
    }
    const suppressed = new Set(await this.manual.suppressedKeys(owner));
    const visible = [...byKey.values()].filter(
      (item) => item.source === "manual" || !suppressed.has(item.calendarKey),
    );
    if (visible.length > this.settings.maxItems) {
      throw new EventError(
        "calendar_window_too_dense",
        400,
        "Choose a narrower calendar window",
      );
    }
    return sortOccurrences(visible, this.settings.timezone);
  }

  async conflicts(owner: string, window: CalendarWindow) {
    const items = await this.list(owner, window);
    return detectConflicts(
      items,
      this.settings.timezone,
      this.settings.maxConflicts,
    );
  }

  async banner(owner: string, now: Temporal.Instant = Temporal.Now.instant()) {
    const window = {
      from: new Date(now.epochMilliseconds).toISOString(),
      to: new Date(
        now.epochMilliseconds + this.settings.upcomingHours * 3_600_000 + 1,
      ).toISOString(),
    };
    const items = await this.list(owner, window);
    return {
      ...timeBanner(items, now, this.settings.upcomingHours),
      evaluatedAt: window.from,
    };
  }
}
