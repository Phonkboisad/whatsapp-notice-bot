const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const ROUTINE_TIMEZONE = 'Asia/Dhaka';
export const ROUTINE_PERIODS = [
    { id: '1', label: 'Male 1st', start: '10:30', end: '11:20' },
    { id: '2', label: 'Male 2nd', start: '11:20', end: '12:10' },
    { id: '3', label: 'Male 3rd', start: '12:10', end: '13:00' },
    { id: '4', label: 'Male Break', start: '13:00', end: '13:50', break: true },
    { id: '5', label: 'Male 4th', start: '13:50', end: '14:40' },
    { id: '6', label: 'Male 5th', start: '14:40', end: '15:30' },
    { id: '7', label: 'Male 6th', start: '15:30', end: '16:20' }
];

export function getDhakaParts(timestamp = Date.now()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: ROUTINE_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        weekday: 'long',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).formatToParts(new Date(timestamp));
    const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
    return {
        dateKey: `${values.year}-${values.month}-${values.day}`,
        year: Number(values.year),
        month: Number(values.month),
        day: Number(values.day),
        weekday: values.weekday,
        hour: Number(values.hour) % 24,
        minute: Number(values.minute)
    };
}

export function getNextDateKey(timestamp = Date.now()) {
    const dhakaDate = new Date(timestamp + DHAKA_OFFSET_MS);
    dhakaDate.setUTCHours(12, 0, 0, 0);
    dhakaDate.setUTCDate(dhakaDate.getUTCDate() + 1);
    return dhakaDate.toISOString().slice(0, 10);
}

export function getDateWeekday(dateKey) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
    if (!match) return undefined;
    const weekday = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay();
    return DAY_NAMES[weekday];
}

export function isValidRoutineEntry(entry) {
    return entry === null || (
        typeof entry === 'object' &&
        typeof entry.class === 'string' &&
        typeof entry.room === 'string' &&
        (entry.teacher === undefined || typeof entry.teacher === 'string')
    );
}

export function normalizeRoutineConfig(config) {
    if (!config || typeof config !== 'object') return { days: {}, noClassDays: ['Thursday', 'Friday'] };
    const days = {};
    for (const [day, entries] of Object.entries(config.days || {})) {
        if (!DAY_NAMES.includes(day) || !entries || typeof entries !== 'object') continue;
        days[day] = {};
        for (const period of ROUTINE_PERIODS) {
            const entry = entries[period.id];
            if (isValidRoutineEntry(entry)) days[day][period.id] = entry;
        }
    }
    return {
        days,
        noClassDays: [...new Set((config.noClassDays || []).filter(day => DAY_NAMES.includes(day)))]
    };
}

export function getRoutineForDate(config, dateKey, overrides = {}) {
    const day = getDateWeekday(dateKey);
    const base = normalizeRoutineConfig(config).days[day] || {};
    const dateOverrides = overrides[dateKey] || {};
    return ROUTINE_PERIODS.map(period => {
        const source = base[period.id] || (period.break ? { class: 'Break', room: '' } : null);
        const override = dateOverrides[period.id];
        if (override?.cancelled) {
            return { ...period, class: 'Cancelled', room: '', teacher: '', cancelled: true };
        }
        return { ...period, ...(source || {}), ...(override || {}), id: period.id };
    });
}

export function applyRoutineOverride(overrides, dateKey, periodId, change) {
    if (!overrides[dateKey]) overrides[dateKey] = {};
    const current = overrides[dateKey][periodId] || {};
    overrides[dateKey][periodId] = {
        ...current,
        ...change,
        ...(change.cancelled ? { class: 'Cancelled', room: '', teacher: '' } : {})
    };
    return overrides;
}

export function findNextPeriod(config, dateKey, now = Date.now(), overrides = {}) {
    const current = getDhakaParts(now);
    if (current.dateKey !== dateKey) return getRoutineForDate(config, dateKey, overrides).find(item => !item.break && item.class && item.class !== 'Cancelled');
    const minutes = current.hour * 60 + current.minute;
    return getRoutineForDate(config, dateKey, overrides).find(item => {
        const [hour, minute] = item.start.split(':').map(Number);
        return !item.break && hour * 60 + minute >= minutes && item.class && item.class !== 'Cancelled';
    });
}

export function formatRoutine(dateKey, entries, unconfirmed = false) {
    const day = getDateWeekday(dateKey);
    const lines = [`📚 *Class Routine — ${day}, ${dateKey}*`];
    if (unconfirmed) lines.push('⚠️ Published without CR/ACR confirmation.');
    const classes = entries.filter(entry => !entry.break && entry.class);
    if (!classes.length) return `${lines.join('\n')}\n\nNo scheduled classes.`;
    for (const entry of classes) {
        const details = [entry.class, entry.teacher, entry.room && `Room: ${entry.room}`].filter(Boolean).join(' — ');
        lines.push(`\n*${entry.id}. ${entry.start}-${entry.end}*\n${entry.cancelled ? '❌ ' : ''}${details}`);
    }
    return lines.join('\n');
}

export function makeMentionList(participants) {
    return [...new Set((participants || [])
        .map(participant => typeof participant === 'string' ? participant : participant?.id)
        .filter(jid => typeof jid === 'string' && jid.length > 0))];
}

export function formatRoutineReview(dateKey, entries) {
    return [
        `Review for ${dateKey}:`,
        ...entries.map(entry => `${entry.id}. ${entry.start}-${entry.end}: ${entry.class || 'Free'}${entry.room ? ` (${entry.room})` : ''}`)
    ].join('\n');
}
