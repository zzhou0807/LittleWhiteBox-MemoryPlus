import { normalizeRelationPredicate } from '../data/fact-predicates.js';

const FACT_PREDICATE_ALIASES = new Map([
    ['当前位置', '位置'],
    ['当前所在地', '位置'],
    ['所在位置', '位置'],
    ['所在地', '位置'],
    ['当前状态', '状态'],
]);
const VALID_TRENDS = new Set(['破裂', '厌恶', '反感', '陌生', '投缘', '亲密', '交融']);
const TREND_ALIASES = new Map([['厭惡', '厌恶'], ['投緣', '投缘'], ['親密', '亲密']]);
const text = value => typeof value === 'string' ? value.trim() : '';

export function sanitizeFacts(parsed) {
    if (!parsed || typeof parsed !== 'object') return;

    const updates = [];
    for (const relations of [parsed.relationshipUpdates, parsed.relationships, parsed.characters?.relationships]) {
        if (!Array.isArray(relations)) continue;
        for (const relation of relations) {
            const from = text(relation?.from);
            const to = text(relation?.to);
            if (!from || !to || from === to) continue;
            updates.push({
                s: from,
                p: `对${to}的看法`,
                o: relation.label,
                trend: relation.trend,
                retracted: relation.retracted,
            });
        }
    }
    if (Array.isArray(parsed.factUpdates)) updates.push(...parsed.factUpdates);

    const facts = new Map();
    for (const item of updates) {
        const subject = text(item?.s);
        const rawPredicate = text(item?.p);
        if (!subject || !rawPredicate) continue;
        const relationPredicate = normalizeRelationPredicate(rawPredicate);
        const predicate = relationPredicate || FACT_PREDICATE_ALIASES.get(rawPredicate) || rawPredicate;
        const key = `${subject}::${predicate}`;
        if (item.retracted === true) {
            facts.set(key, { s: subject, p: predicate, retracted: true });
            continue;
        }
        const value = typeof item.o === 'number' && Number.isFinite(item.o) ? String(item.o) : text(item.o);
        if (!value) continue;
        const fact = { s: subject, p: predicate, o: value, isState: !!relationPredicate || !!item.isState };
        const trend = TREND_ALIASES.get(text(item.trend)) || text(item.trend);
        if (relationPredicate && VALID_TRENDS.has(trend)) fact.trend = trend;
        facts.set(key, fact);
    }
    parsed.factUpdates = [...facts.values()];
}
