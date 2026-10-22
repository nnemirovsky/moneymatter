/** `240` becomes `UTC+04:00`, `-210` becomes `UTC-03:30`. */
export function formatOffset({ minutes }: { minutes: number }): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const hours = String(Math.floor(abs / 60)).padStart(2, '0');
  const mins = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${hours}:${mins}`;
}
