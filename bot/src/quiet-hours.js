const TIME_PATTERN = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/;

export function parseQuietHours(value = '00:00-07:00') {
  const match = TIME_PATTERN.exec(value);
  if (!match) {
    throw new Error(`BOT_QUIET_HOURS 格式无效: ${value}`);
  }
  const [, startHour, startMinute, endHour, endMinute] = match.map(Number);
  if (
    startHour > 23
    || endHour > 23
    || startMinute > 59
    || endMinute > 59
  ) {
    throw new Error(`BOT_QUIET_HOURS 时间无效: ${value}`);
  }
  return {
    start: startHour * 60 + startMinute,
    end: endHour * 60 + endMinute,
  };
}

export function minuteOfDay(date, timezone = 'Asia/Shanghai') {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value);
  return hour * 60 + minute;
}

export function isQuietTime(
  date = new Date(),
  range = parseQuietHours(process.env.BOT_QUIET_HOURS || '00:00-07:00'),
  timezone = process.env.BOT_TIMEZONE || 'Asia/Shanghai',
) {
  const current = minuteOfDay(date, timezone);
  if (range.start === range.end) return false;
  if (range.start < range.end) {
    return current >= range.start && current < range.end;
  }
  return current >= range.start || current < range.end;
}
