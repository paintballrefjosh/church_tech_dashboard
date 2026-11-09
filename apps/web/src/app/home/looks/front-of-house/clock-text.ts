import type { CountdownLeft } from "../../parts/countdown";

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * The front-of-house clock: "2d 16h 04m" while the service is a day or more away (a 64-hour
 * clock reads as nonsense), then a stage clock, "16:04:12", once it is inside the last day.
 */
export function clockText(left: CountdownLeft): string {
  if (left.days > 0) return `${left.days}d ${left.hours}h ${pad(left.minutes)}m`;
  return `${pad(left.hours)}:${pad(left.minutes)}:${pad(left.seconds)}`;
}
