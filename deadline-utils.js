export function parseDhakaDeadlineInput(dateStr, timeStr = '09:00') {
    if (typeof dateStr !== 'string' || typeof timeStr !== 'string') return undefined;

    const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(dateStr.trim());
    const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(timeStr.trim());
    if (!match || !timeMatch) return undefined;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2]);

    const daysInMonth = month >= 1 && month <= 12
        ? new Date(Date.UTC(year, month, 0)).getUTCDate()
        : 0;
    if (
        month < 1 || month > 12 ||
        day < 1 || day > daysInMonth ||
        hour > 23 || minute > 59
    ) {
        return undefined;
    }

    const isoString = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+06:00`;
    const timestamp = Date.parse(isoString);
    return Number.isFinite(timestamp) ? timestamp : undefined;
}
