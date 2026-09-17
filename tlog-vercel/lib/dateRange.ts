/**
 * dateRange.ts
 * =============
 * Shared range-parsing logic for the dashboard's API routes. Pulled out
 * of /api/summary so /api/insights uses the EXACT same "today"/"7d"/etc
 * boundary math - two independent copies of this logic would be an easy
 * way to introduce a subtle mismatch between the KPI tiles and the new
 * analytics endpoint.
 */

import { startOfDayInTZ, startOfYearInTZ, localDateStringToUTC } from "./tz";

export function rangeBounds(rangeKey: string, startParam: string | null, endParam: string | null) {
  const now = new Date();

  if (rangeKey === "custom" && startParam && endParam) {
    // startParam/endParam are plain "YYYY-MM-DD" strings from a date
    // picker - both endpoints are INCLUSIVE calendar days in Central
    // time, so "end" becomes the start of the day AFTER the picked date.
    const start = localDateStringToUTC(startParam);
    const endDayStart = localDateStringToUTC(endParam);
    const end = new Date(endDayStart.getTime() + 24 * 3600 * 1000);
    return { start: start.toISOString(), end: end.toISOString() };
  }

  let start: Date;
  let end: Date = now;

  switch (rangeKey) {
    case "24h":
      start = new Date(now.getTime() - 24 * 3600 * 1000);
      break;
    case "7d":
      start = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
      break;
    case "30d":
      start = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
      break;
    case "ytd":
      start = startOfYearInTZ(now);
      break;
    case "year":
      start = new Date(now.getTime() - 365 * 24 * 3600 * 1000);
      break;
    case "today":
    default:
      start = startOfDayInTZ(now);
      end = new Date(start.getTime() + 24 * 3600 * 1000);
      break;
  }
  return { start: start.toISOString(), end: end.toISOString() };
}

export function granularityFor(rangeKey: string): string {
  return (
    { today: "hour", "24h": "hour", "7d": "day", "30d": "day", ytd: "month", year: "month" }[
      rangeKey
    ] ?? "hour"
  );
}
