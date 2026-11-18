/**
 * Calendar-date rules for `x-sunset` handling (locked decision L-4). Sunset
 * dates are compared as calendar dates in IST; a sunset equal to the as-of
 * date counts as due, so expiry is `sunset <= asOf`.
 */
import { istCalendarDate } from "../config.js";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Parse a `YYYY-MM-DD` calendar date to a UTC-midnight Date; `undefined` if malformed. */
export function parseCalendarDate(value: string): Date | undefined {
  const match = ISO_DATE.exec(value.trim());
  if (match === null) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])] as [
    number,
    number,
    number,
  ];
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  // Reject impossible dates such as 2026-02-31, which Date would silently roll over.
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return date;
}

/**
 * True when a sunset date is due or past, given the as-of instant. Unparseable
 * sunset values are treated as not expired — the field simply has no proven
 * removal deadline.
 */
export function sunsetExpired(sunsetDate: string, asOf: Date): boolean {
  const sunset = parseCalendarDate(sunsetDate);
  if (sunset === undefined) return false;
  return sunset.getTime() <= istCalendarDate(asOf).getTime();
}

/** True when the sunset deadline is still ahead of the as-of instant. */
export function sunsetInFuture(sunsetDate: string, asOf: Date): boolean {
  return !sunsetExpired(sunsetDate, asOf);
}
