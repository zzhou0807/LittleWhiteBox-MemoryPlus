export const LORE_CATEGORIES = Object.freeze({
    world: '世界总则',
    city: '城市与地点',
    item: '物品与道具',
    potion: '药水与药剂',
    magic: '魔法与能力体系',
    faction: '势力与组织',
    custom: '其他设定',
});

export const LORE_FIELDS = Object.freeze({
    overview: '定义与概述',
    details: '具体设定',
    rules: '规则与限制',
    notes: '其他补充',
});

const text = (value, limit = 4000) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const nameKey = value => text(value, 160).toLowerCase();
const list = value => Array.isArray(value) ? value : [];
const isCategory = value => Object.hasOwn(LORE_CATEGORIES, value);

function normalizeField(raw) {
    const field = typeof raw === 'string' ? { value: raw } : raw || {};
    return {
        value: text(field.value),
        locked: field.locked !== false,
        evidence: text(field.evidence, 1000),
        sourceFloor: Number.isInteger(field.sourceFloor) ? field.sourceFloor : null,
    };
}

export function normalizeLore(raw) {
    const ids = new Set();
    return list(raw).filter(item => item && text(item.name, 160)).map((item, index) => {
        let id = text(item.id, 200) || `lore-${index + 1}`;
        while (ids.has(id)) id += '-copy';
        ids.add(id);
        const fields = {};
        for (const key of Object.keys(LORE_FIELDS)) fields[key] = normalizeField(item.fields?.[key]);
        return {
            id,
            name: text(item.name, 160),
            category: isCategory(item.category) ? item.category : 'custom',
            aliases: [...new Set(list(item.aliases).map(alias => text(alias, 160)).filter(Boolean))],
            pinned: item.pinned !== false,
            fields,
            candidates: list(item.candidates).filter(candidate => candidate && Object.hasOwn(LORE_FIELDS, candidate.field) && text(candidate.value))
                .map(candidate => ({
                    field: candidate.field,
                    value: text(candidate.value),
                    evidence: text(candidate.evidence, 1000),
                    sourceFloor: Number.isInteger(candidate.sourceFloor) ? candidate.sourceFloor : null,
                })).slice(-100),
            history: list(item.history).filter(entry => entry && Object.hasOwn(LORE_FIELDS, entry.field))
                .map(entry => ({
                    field: entry.field, previous: text(entry.previous), value: text(entry.value),
                    evidence: text(entry.evidence, 1000),
                    sourceFloor: Number.isInteger(entry.sourceFloor) ? entry.sourceFloor : null,
                    action: ['manual', 'accepted', 'rejected', 'automatic'].includes(entry.action) ? entry.action : 'manual',
                })).slice(-200),
            _addedAt: Number.isInteger(item._addedAt) ? item._addedAt : 0,
        };
    });
}

function recordChange(entry, field, update, action) {
    entry.history.push({
        field, previous: entry.fields[field].value, value: update.value,
        evidence: update.evidence, sourceFloor: update.sourceFloor, action,
    });
    entry.history = entry.history.slice(-200);
}

export function resolveLoreCandidate(rawEntry, index, accept) {
    const entry = normalizeLore([rawEntry])[0];
    const candidate = entry?.candidates[index];
    if (!candidate) return entry;
    recordChange(entry, candidate.field, candidate, accept ? 'accepted' : 'rejected');
    if (accept) entry.fields[candidate.field] = { ...candidate, locked: true };
    entry.candidates.splice(index, 1);
    return normalizeLore([entry])[0];
}

export function reconcileLoreAliases(rawLore) {
    const entries = normalizeLore(rawLore);
    const byKey = new Map();
    const result = [];
    for (const entry of entries) {
        const keys = [nameKey(entry.name), ...entry.aliases.map(nameKey)].filter(Boolean);
        const existing = keys.map(key => byKey.get(key)).find(Boolean);
        if (!existing) {
            result.push(entry);
            for (const key of keys) byKey.set(key, entry);
            continue;
        }
        existing.aliases = [...new Set([...existing.aliases, entry.name, ...entry.aliases])]
            .filter(alias => nameKey(alias) !== nameKey(existing.name));
        existing.pinned ||= entry.pinned;
        existing.history.push(...entry.history);
        existing.candidates.push(...entry.candidates);
        if (existing.category === 'custom' && entry.category !== 'custom') existing.category = entry.category;
        for (const [field, incoming] of Object.entries(entry.fields)) {
            if (!incoming.value) continue;
            if (!existing.fields[field].value) existing.fields[field] = incoming;
            else if (existing.fields[field].value !== incoming.value) {
                existing.candidates.push({ field, value: incoming.value, evidence: incoming.evidence || '合并重复设定时发现不同描述，请核对。', sourceFloor: incoming.sourceFloor });
            }
        }
        for (const key of [...keys, ...existing.aliases.map(nameKey)]) byKey.set(key, existing);
    }
    return normalizeLore(result);
}

export function mergeLoreUpdates(rawLore, updates, floor) {
    const entries = reconcileLoreAliases(rawLore);
    const byKey = new Map();
    entries.forEach(entry => {
        [entry.name, ...entry.aliases].forEach(name => byKey.set(nameKey(name), entry));
    });
    for (const update of list(updates)) {
        const name = text(update?.name, 160);
        if (!name) continue;
        const validFields = Object.entries(LORE_FIELDS).flatMap(([field]) => {
            const value = text(update.fields?.[field]?.value);
            const evidence = text(update.fields?.[field]?.evidence, 1000);
            return value && evidence ? [{ field, value, evidence, sourceFloor: floor }] : [];
        });
        if (!validFields.length) continue;
        let entry = byKey.get(nameKey(name));
        if (!entry) {
            const usedIds = new Set(entries.map(item => item.id));
            let nextId = entries.length + 1;
            while (usedIds.has(`lore-${nextId}`)) nextId++;
            entry = normalizeLore([{
                id: `lore-${nextId}`, name, category: isCategory(update.category) ? update.category : 'custom', _addedAt: floor,
            }])[0];
            entries.push(entry);
            byKey.set(nameKey(name), entry);
        } else if (entry.category === 'custom' && isCategory(update.category)) {
            entry.category = update.category;
        }
        for (const updateField of validFields) {
            const current = entry.fields[updateField.field];
            if (current.value === updateField.value) continue;
            if (entry.candidates.some(item => item.field === updateField.field && item.value === updateField.value)) continue;
            if (entry.history.some(item => item.action === 'rejected' && item.field === updateField.field && item.value === updateField.value)) continue;
            if (current.value && current.locked) {
                entry.candidates.push(updateField);
            } else {
                recordChange(entry, updateField.field, updateField, 'automatic');
                entry.fields[updateField.field] = { ...updateField, locked: current.locked };
            }
        }
    }
    return normalizeLore(entries);
}

export function stampEditedLore(previous, edited, floor) {
    const oldById = new Map(normalizeLore(previous).map(entry => [entry.id, entry]));
    return normalizeLore(edited).map(entry => {
        const old = oldById.get(entry.id);
        entry._addedAt = old?._addedAt ?? floor;
        for (const [field, value] of Object.entries(entry.fields)) {
            const before = old?.fields[field];
            if (value.value !== (before?.value || '')) {
                const alreadyRecorded = entry.history.some(item => item.field === field && item.previous === (before?.value || '') && item.value === value.value && item.action === 'accepted');
                if (!alreadyRecorded) {
                    entry.history.push({ field, previous: before?.value || '', value: value.value, evidence: value.evidence || '用户手动编辑', sourceFloor: floor, action: 'manual' });
                    value.sourceFloor = floor;
                    value.evidence ||= '用户手动编辑';
                }
            } else if (before) {
                value.evidence = before.evidence;
                value.sourceFloor = before.sourceFloor;
            }
        }
        return entry;
    });
}

export function formatWorldLore(rawLore, { maxChars = 4000 } = {}) {
    const entries = normalizeLore(rawLore).filter(entry => entry.pinned);
    const header = '【世界观设定｜固定设定】\n以下为已确认的世界观底稿（地点、物品、药水、魔法体系等）；除原文明确揭示新事实外，不要无依据改写、删除或替换这些设定。未列出的信息未知，不要补造。\n';
    let output = header;
    let omittedFields = 0;
    for (const entry of entries) {
        const category = LORE_CATEGORIES[entry.category] || LORE_CATEGORIES.custom;
        const heading = `\n[${category}] ${entry.name}${entry.aliases.length ? `（别名：${entry.aliases.join('、')}）` : ''}\n`;
        let block = '';
        for (const [field, label] of Object.entries(LORE_FIELDS)) {
            const value = entry.fields[field].value;
            if (!value) continue;
            const line = `${label}：${value}\n`;
            if (output.length + heading.length + block.length + line.length <= maxChars) block += line;
            else omittedFields++;
        }
        if (block) output += heading + block;
    }
    return { text: output === header ? '' : output.trim(), omittedFields };
}

export const LORE_UPDATE_PROMPT = `
世界观设定增量（可选）：在 JSON 根对象加入 "loreUpdates": [
  {"name":"设定名称","category":"city","fields":{"details":{"value":"有原文依据的具体设定","evidence":"本批原文中的直接依据"}}}
]。
可用 category：world 世界总则、city 城市与地点、item 物品与道具、potion 药水与药剂、magic 魔法与能力体系、faction 势力与组织、custom 其他设定。
可用字段：overview 定义与概述、details 具体设定、rules 规则与限制、notes 其他补充。
只提取本批原文明确支持、并且后续剧情需要保持一致的世界观设定，例如新出现的特殊城市、特殊物品、药水、魔法规则或组织。每个字段必须同时提供 value 和 evidence；缺失信息不猜测、不清空。
一次性的道具消耗、临时场景、角色情绪和关系变化不属于世界观设定，仍写 events/factUpdates/arcUpdates。同一个 name 会更新已有设定；已有锁定字段不会被直接覆盖，而是交由用户审核。没有新证据时省略 loreUpdates。`;
