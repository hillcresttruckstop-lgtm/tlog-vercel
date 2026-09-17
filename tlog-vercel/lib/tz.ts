/**
 * tz.ts
 * ======
 * Vercel reserves the TZ environment variable for its own Lambda runtime,
 * so we can't just set process.env.TZ = "America/Chicago" and have Date's
 * local-time methods do the right thing - the server always thinks in
 * UTC. These helpers convert explicitly instead, using only Node's
 * built-in Intl (no date-fns-tz / moment-timezone dependency needed),
 * and correctly handle the CST/CDT daylight-saving switch automatically.
 */

export const STORE_TZ = "America/Chicago"; // Minnesota

function getOffsetMinutes(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) parts[p.type] = p.value;
  const asUTC = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second)
  );
  return (asUTC - utcMs) / 60000;
}

/** The real UTC instant for local midnight, on whatever calendar date
 * `date` falls on in `timeZone`. */
export function startOfDayInTZ(date: Date, timeZone: string = STORE_TZ): Date {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  const naiveUTC = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 0, 0, 0);
  const offsetMin = getOffsetMinutes(naiveUTC, timeZone);
  return new Date(naiveUTC - offsetMin * 60000);
}

/** The real UTC instant for local Jan 1 00:00 of whatever year `date`
 * falls in, in `timeZone`. */
export function startOfYearInTZ(date: Date, timeZone: string = STORE_TZ): Date {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  const naiveUTC = Date.UTC(Number(parts.year), 0, 1, 0, 0, 0);
  const offsetMin = getOffsetMinutes(naiveUTC, timeZone);
  return new Date(naiveUTC - offsetMin * 60000);
}

/** Converts a plain "YYYY-MM-DD" string (e.g. from an HTML date picker)
 * into the real UTC instant for local midnight on THAT exact calendar
 * date in `timeZone` - not the date as seen from some other anchor
 * instant, the literal Y-M-D the person picked. */
export function localDateStringToUTC(dateStr: string, timeZone: string = STORE_TZ): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  const naiveUTC = Date.UTC(y, m - 1, d, 0, 0, 0);
  const offsetMin = getOffsetMinutes(naiveUTC, timeZone);
  return new Date(naiveUTC - offsetMin * 60000);
}
