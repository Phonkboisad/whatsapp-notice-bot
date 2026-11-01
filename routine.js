const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const ROUTINE_TIMEZONE = 'Asia/Dhaka';
export const ROUTINE_PERIODS = [
    { id: '1', label: 'Male 1st', start: '10:50', end: '11:30' },
    { id: '2', label: 'Male 2nd', start: '11:30', end: '12:20' },
    { id: '3', label: 'Male 3rd', start: '12:20', end: '13:10' },
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

function canMergeRoutineEntries(previous, current) {
    return !previous.break &&
        !current.break &&
        !previous.cancelled &&
        !current.cancelled &&
        previous.class &&
        current.class &&
        previous.class === current.class &&
        (previous.teacher || '') === (current.teacher || '') &&
        (previous.room || '') === (current.room || '') &&
        Number(current.id) === Number(previous.id) + 1;
}

export function groupRoutineEntries(entries) {
    const groups = [];
    for (const entry of entries) {
        const previous = groups.at(-1);
        if (previous && canMergeRoutineEntries(previous.entries.at(-1), entry)) {
            previous.entries.push(entry);
            previous.end = entry.end;
            previous.periodEnd = entry.id;
        } else if (!entry.break && entry.class) {
            groups.push({
                entries: [entry],
                periodStart: entry.id,
                periodEnd: entry.id,
                start: entry.start,
                end: entry.end,
                class: entry.class,
                teacher: entry.teacher || '',
                room: entry.room || '',
                cancelled: Boolean(entry.cancelled)
            });
        }
    }
    return groups;
}

export function parsePeriodSelection(value) {
    if (typeof value !== 'string') return undefined;
    const match = /^(?:([1-7])|([1-7])-([1-7]))$/.exec(value.trim());
    if (!match) return undefined;
    const start = Number(match[1] || match[2]);
    const end = Number(match[1] || match[3]);
    if (end < start) return undefined;
    return Array.from({ length: end - start + 1 }, (_, index) => String(start + index));
}

export function formatRoutine(dateKey, entries, unconfirmed = false) {
    const day = getDateWeekday(dateKey);
    const lines = [
        '╭━━ 📚 *CLASS ROUTINE* ━━╮',
        `┃ 📅 *${day}, ${dateKey}*`,
        '╰━━━━━━━━━━━━━━━━━━━━╯'
    ];
    if (unconfirmed) lines.push('\n⚠️ _Published without CR/ACR confirmation._');
    const groups = groupRoutineEntries(entries);
    if (!groups.length) return `${lines.join('\n')}\n\n📭 _No scheduled classes._`;
    for (const group of groups) {
        const periodLabel = group.periodStart === group.periodEnd
            ? `Period ${group.periodStart}`
            : `Periods ${group.periodStart}-${group.periodEnd}`;
        const details = [
            `⏰ *${group.start}–${group.end}* · _${periodLabel}_`,
            `${group.cancelled ? '❌' : '📘'} *${group.class}*`,
            group.teacher && `👨‍🏫 ${group.teacher}`,
            group.room && `📍 Room: *${group.room}*`
        ].filter(Boolean);
        lines.push(`\n${details.join('\n')}`);
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
        `📝 *Routine review — ${dateKey}*`,
        ...groupRoutineEntries(entries).map(group =>
            `• *${group.periodStart === group.periodEnd ? `P${group.periodStart}` : `P${group.periodStart}-${group.periodEnd}`}* ${group.start}-${group.end} — ${group.cancelled ? '❌ Cancelled' : group.class}${group.room ? ` · ${group.room}` : ''}`
        )
    ].join('\n');
}
