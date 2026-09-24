import type { WithId } from "mongodb";
import type { EventDocument } from "../plugins/init-mongo.js";
import type { CalendarOccurrence, CalendarWindow } from "./calendar.js";
import { expandManualEvent } from "./calendar.js";
import { EventError } from "./events.js";

export function expandIcsSeries(
  events: WithId<EventDocument>[],
  window: CalendarWindow,
  maxItems: number,
): CalendarOccurrence[] {
  const byUid = new Map<string, WithId<EventDocument>[]>();
  for (const event of events) {
    const uid = String(event.externalId ?? "");
    const group = byUid.get(uid) ?? [];
    group.push(event);
    byUid.set(uid, group);
  }

  const items: CalendarOccurrence[] = [];
  const append = (occurrences: CalendarOccurrence[]) => {
    items.push(...occurrences);
    if (items.length > maxItems)
      throw new EventError(
        "calendar_window_too_dense",
        400,
        "Choose a narrower calendar window",
      );
  };

  for (const group of byUid.values()) {
    const master = group.find((event) => !event.recurrenceId);
    if (!master || master.recurrenceStatus === "CANCELLED") continue;

    const exceptions = new Map(
      group
        .filter((event) => event.recurrenceId)
        .map((event) => [event.recurrenceId!, event]),
    );
    const applied = new Set<string>();
    const occurrences = expandManualEvent(master, window, maxItems + 1);
    for (const occurrence of occurrences) {
      const exception = exceptions.get(occurrence.startsAt);
      if (!exception) {
        append([occurrence]);
        continue;
      }
      applied.add(exception._id.toHexString());
      if (exception.recurrenceStatus === "CANCELLED") continue;
      append(expandManualEvent(exception, window, 1));
    }

    for (const exception of exceptions.values()) {
      if (
        applied.has(exception._id.toHexString()) ||
        exception.recurrenceStatus === "CANCELLED"
      )
        continue;
      append(expandManualEvent(exception, window, 1));
    }
  }

  return items;
}
