export function parseRelationTarget(predicate) {
    const match = String(predicate || '').trim().match(/^[对對与與和跟](.+)的(?:看法|态度|態度|关系|關係)$/);
    return match?.[1]?.trim() || null;
}

export function normalizeRelationPredicate(predicate) {
    const target = parseRelationTarget(predicate);
    return target ? `对${target}的看法` : null;
}

export function isRelationFact(fact) {
    return !!parseRelationTarget(fact?.p);
}
