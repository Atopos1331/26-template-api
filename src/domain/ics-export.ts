import type { CalendarOccurrence } from "./calendar.js";

function escapeIcsText(value: string) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,")
    .replaceAll(/\r?\n/g, "\\n");
}

function compactUtc(value: string) {
  return value.replaceAll(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function serializeIcs(items: CalendarOccurrence[]) {
  const stamp = compactUtc(new Date().toISOString());
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//USThing//Timetable//EN",
    "CALSCALE:GREGORIAN",
  ];
  for (const item of items) {
    lines.push("BEGIN:VEVENT");
    lines.push(
      `UID:${escapeIcsText(item.exportUid ?? `${item.source}:${item.sourceId}`)}`,
    );
    lines.push(`DTSTAMP:${stamp}`);
    if (item.allDay && item.startDate && item.endDate) {
      lines.push(`DTSTART;VALUE=DATE:${item.startDate.replaceAll("-", "")}`);
      lines.push(`DTEND;VALUE=DATE:${item.endDate.replaceAll("-", "")}`);
    } else {
      lines.push(`DTSTART:${compactUtc(item.startsAt)}`);
      lines.push(`DTEND:${compactUtc(item.endsAt)}`);
    }
    lines.push(`SUMMARY:${escapeIcsText(item.title)}`);
    if (item.description)
      lines.push(`DESCRIPTION:${escapeIcsText(item.description)}`);
    if (item.location) lines.push(`LOCATION:${escapeIcsText(item.location)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}
