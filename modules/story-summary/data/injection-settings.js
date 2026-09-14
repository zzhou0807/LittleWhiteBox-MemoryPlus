export function normalizeInjectionSettings(trigger = {}) {
    const depth = trigger.injectionDepth == null || trigger.injectionDepth === '' ? NaN : Number(trigger.injectionDepth);
    const budget = trigger.profileCharBudget == null || trigger.profileCharBudget === '' ? NaN : Number(trigger.profileCharBudget);
    return {
        injectionMode: trigger.injectionMode === 'fixed' ? 'fixed' : 'auto',
        injectionDepth: Number.isFinite(depth) ? Math.max(0, Math.min(9999, Math.trunc(depth))) : 4,
        forceInsertAtEnd: trigger.forceInsertAtEnd === true,
        profileCharBudget: Number.isFinite(budget) ? Math.max(1000, Math.min(32000, Math.trunc(budget))) : 8000,
    };
}

export function resolveSummaryInjection(trigger, chatLength, boundary) {
    const settings = normalizeInjectionSettings(trigger);
    const length = Math.max(0, Math.trunc(Number(chatLength) || 0));
    const mode = settings.forceInsertAtEnd ? 'end' : settings.injectionMode;
    const requestedDepth = mode === 'end' ? 0 : mode === 'fixed'
        ? settings.injectionDepth : Math.max(2, length - Math.max(-1, boundary) - 1);
    return { mode, depth: Math.min(length, requestedDepth), requestedDepth };
}
