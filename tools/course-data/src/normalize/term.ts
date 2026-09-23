import type { Term } from "../contract.ts";

const seasons = {
  "10": ["fall", "Fall", "秋季"],
  "20": ["winter", "Winter", "冬季"],
  "30": ["spring", "Spring", "春季"],
  "40": ["summer", "Summer", "夏季"],
} as const;

export function parseUstTerm(
  termCode: string,
  signals?: { current?: boolean; selectable?: boolean },
): Term {
  const match = /^(\d{2})(10|20|30|40)$/.exec(termCode);
  if (!match) throw new Error("TERM_CODE_INVALID");
  const year = 2000 + Number(match[1]);
  const season = seasons[match[2] as keyof typeof seasons];
  return {
    termCode,
    source: "ust-class-schedule",
    academicYearStart: year,
    academicYearEnd: year + 1,
    season: season[0],
    displayName: `${year}-${String(year + 1).slice(-2)} ${season[1]}`,
    localizedName: `${year}-${String(year + 1).slice(-2)} ${season[2]}`,
    sortKey: year * 100 + Number(match[2]),
    timezone: "Asia/Hong_Kong",
    sourceRecordId: termCode,
    ...(signals?.current === undefined
      ? {}
      : { providerCurrent: signals.current }),
    ...(signals?.selectable === undefined
      ? {}
      : { providerSelectable: signals.selectable }),
  };
}
