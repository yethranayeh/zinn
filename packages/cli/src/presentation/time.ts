const MINUTES_PER_HOUR = 60;

export function formatLocalTime(timestamp: number, options: { includesSeconds?: boolean } = {}) {
  const date = new Date(timestamp);
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffsetMinutes = Math.abs(offsetMinutes);
  const offsetHours = Math.floor(absoluteOffsetMinutes / MINUTES_PER_HOUR);
  const remainingOffsetMinutes = absoluteOffsetMinutes % MINUTES_PER_HOUR;
  const pad = (value: number) => String(value).padStart(2, "0");
  const milliseconds = date.getMilliseconds();
  const fraction = milliseconds === 0 ? "" : `.${String(milliseconds).padStart(3, "0")}`;
  const seconds = options.includesSeconds ? `:${pad(date.getSeconds())}${fraction}` : "";

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}${seconds} ` +
    `${offsetSign}${pad(offsetHours)}:${pad(remainingOffsetMinutes)}`
  );
}
