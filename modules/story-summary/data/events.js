export const EVENT_MEMORY_ROLES = Object.freeze([
    '状态变化',
    '约定承诺',
    '信息揭示',
    '偏好习惯',
    '具体经历',
]);

const EVENT_FIELDS = ['id', 'title', 'timeLabel', 'summary', 'participants', 'causedBy', '_addedAt', 'sortOrder'];

export function normalizeEventMemoryRole(value) {
    const role = typeof value === 'string' ? value.trim() : '';
    return EVENT_MEMORY_ROLES.includes(role) ? role : '';
}

/** Current event projection at generation, editing and stored-data boundaries. */
export function projectSummaryEvent(event) {
    const result = {};
    for (const field of EVENT_FIELDS) {
        if (Object.hasOwn(event, field)) result[field] = event[field];
    }
    result.memoryRole = normalizeEventMemoryRole(event.memoryRole);
    return result;
}

/** Project a complete edited collection and keep causal references within it. */
export function projectEditedSummaryEvents(events) {
    const eventIds = new Set(events.map(event => event.id));
    return events.map(event => {
        const projected = projectSummaryEvent(event);
        if (Array.isArray(projected.causedBy)) {
            projected.causedBy = projected.causedBy.filter(id => eventIds.has(id));
        }
        return projected;
    });
}

export function orderSummaryEvents(events = []) {
    return events.map((event, index) => ({ event, index }))
        .sort((left, right) => (Number.isFinite(left.event.sortOrder) ? left.event.sortOrder : left.index)
            - (Number.isFinite(right.event.sortOrder) ? right.event.sortOrder : right.index) || left.index - right.index)
        .map(({ event }) => event);
}

export function stampEditedSummaryEvents(previous, edited, floor) {
    const previousById = new Map((previous || []).map(event => [event.id, event]));
    const usedIds = new Set();
    let nextId = Math.max(0, ...(previous || []).map(event => Number(/^evt-(\d+)$/.exec(event.id)?.[1]) || 0));
    return projectEditedSummaryEvents((Array.isArray(edited) ? edited : []).filter(event => event && typeof event === 'object').map((event, index) => {
        let id = String(event.id || '').trim();
        if (!id || usedIds.has(id)) {
            do { id = `evt-${++nextId}`; } while (previousById.has(id) || usedIds.has(id));
        }
        usedIds.add(id);
        const old = previousById.get(id);
        return {
            ...event,
            id,
            sortOrder: index,
            _addedAt: old?._addedAt ?? Math.max(0, Number.isInteger(floor) ? floor : 0),
            causedBy: Array.isArray(event.causedBy) ? event.causedBy : old?.causedBy || [],
        };
    }));
}
