export type Bucket =
  | { kind: "this_week" }
  | { kind: "last_week" }
  | { kind: "month"; year: number; month: number }
  | { kind: "older" };

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function startOfWeek(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  out.setDate(out.getDate() - ((out.getDay() + 6) % 7));
  return out;
}

export function bucketFromISO(iso: string, now: Date): Bucket {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return { kind: "older" };
  const wkStart = startOfWeek(now);
  const lastWkStart = new Date(wkStart);
  lastWkStart.setDate(lastWkStart.getDate() - 7);
  if (d >= wkStart) return { kind: "this_week" };
  if (d >= lastWkStart) return { kind: "last_week" };
  const yearAgo = new Date(now);
  yearAgo.setFullYear(yearAgo.getFullYear() - 1);
  if (d >= yearAgo) return { kind: "month", year: d.getFullYear(), month: d.getMonth() + 1 };
  return { kind: "older" };
}

export function bucketKey(b: Bucket): string {
  switch (b.kind) {
    case "this_week": return "this_week";
    case "last_week": return "last_week";
    case "month": return `month:${b.year}-${b.month}`;
    case "older": return "older";
  }
}

export function bucketLabel(b: Bucket, now: Date): string {
  switch (b.kind) {
    case "this_week": return "This week";
    case "last_week": return "Last week";
    case "month": {
      const n = MONTH_NAMES[b.month - 1];
      return b.year === now.getFullYear() ? n : `${n} ${b.year}`;
    }
    case "older": return "Older";
  }
}

export function bucketOrder(b: Bucket): number {
  switch (b.kind) {
    case "this_week": return 0;
    case "last_week": return 1;
    case "month": return 1_000_000 - (b.year * 12 + b.month);
    case "older": return Number.MAX_SAFE_INTEGER;
  }
}

export function formatDate(iso: string, now: Date): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const ageDays = (now.getTime() - d.getTime()) / (24 * 3600 * 1000);
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (ageDays < 7 && ageDays >= 0) {
    return `${WEEKDAYS[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const monthAbbr = MONTH_NAMES[d.getMonth()].slice(0, 3);
  if (d.getFullYear() === now.getFullYear()) return `${monthAbbr} ${d.getDate()}`;
  return `${monthAbbr} ${d.getFullYear()}`;
}
