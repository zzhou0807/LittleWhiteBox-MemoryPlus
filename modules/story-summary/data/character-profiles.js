import { buildAliasResolver } from './character-aliases.js';

export const PROFILE_FIELDS = Object.freeze({
    background: '身份与背景',
    appearance: '外貌与识别特征',
    personality: '稳定性格',
    values: '价值观与底线',
    speech: '说话方式',
    motivation: '长期动机与目标',
    abilities: '能力与限制',
    notes: '其他固定设定',
});

const text = (value, limit = 4000) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const nameKey = value => text(value, 160).toLowerCase();
const list = value => Array.isArray(value) ? value : [];

function normalizeField(raw) {
    const field = typeof raw === 'string' ? { value: raw } : raw || {};
    return {
        value: text(field.value),
        locked: field.locked !== false,
        evidence: text(field.evidence, 1000),
        sourceFloor: Number.isInteger(field.sourceFloor) ? field.sourceFloor : null,
    };
}

export function normalizeProfiles(raw) {
    const ids = new Set();
    return list(raw).filter(item => item && text(item.name, 160)).map((item, index) => {
        let id = text(item.id, 200) || `person-${index + 1}`;
        while (ids.has(id)) id += '-copy';
        ids.add(id);
        const fields = {};
        for (const key of Object.keys(PROFILE_FIELDS)) fields[key] = normalizeField(item.fields?.[key]);
        return {
            id,
            name: text(item.name, 160),
            aliases: [...new Set(list(item.aliases).map(alias => text(alias, 160)).filter(Boolean))],
            pinned: item.pinned !== false,
            fields,
            candidates: list(item.candidates).filter(candidate => candidate && Object.hasOwn(PROFILE_FIELDS, candidate.field) && text(candidate.value))
                .map(candidate => ({
                    field: candidate.field,
                    value: text(candidate.value),
                    evidence: text(candidate.evidence, 1000),
                    sourceFloor: Number.isInteger(candidate.sourceFloor) ? candidate.sourceFloor : null,
                })).slice(-100),
            history: list(item.history).filter(entry => entry && Object.hasOwn(PROFILE_FIELDS, entry.field))
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

function recordChange(profile, field, update, action) {
    profile.history.push({
        field, previous: profile.fields[field].value, value: update.value,
        evidence: update.evidence, sourceFloor: update.sourceFloor, action,
    });
    profile.history = profile.history.slice(-200);
}

export function resolveProfileCandidate(rawProfile, index, accept) {
    const profile = normalizeProfiles([rawProfile])[0];
    const candidate = profile?.candidates[index];
    if (!candidate) return profile;
    recordChange(profile, candidate.field, candidate, accept ? 'accepted' : 'rejected');
    if (accept) profile.fields[candidate.field] = { ...candidate, locked: true };
    profile.candidates.splice(index, 1);
    return normalizeProfiles([profile])[0];
}

export function reconcileProfileAliases(rawProfiles, aliases = []) {
    const resolver = buildAliasResolver(aliases);
    const profiles = normalizeProfiles(rawProfiles);
    const result = [];
    const byName = new Map();
    for (const profile of profiles) {
        const canonicalName = resolver.resolveName(profile.name);
        if (canonicalName !== profile.name) {
            profile.aliases = [...new Set([...profile.aliases, profile.name])];
            profile.name = canonicalName;
        }
        const existing = byName.get(nameKey(profile.name));
        if (!existing) {
            byName.set(nameKey(profile.name), profile);
            result.push(profile);
            continue;
        }
        existing.aliases = [...new Set([...existing.aliases, ...profile.aliases])];
        existing.pinned ||= profile.pinned;
        existing.history.push(...profile.history);
        existing.candidates.push(...profile.candidates);
        for (const [field, incoming] of Object.entries(profile.fields)) {
            if (!incoming.value) continue;
            if (!existing.fields[field].value) existing.fields[field] = incoming;
            else if (existing.fields[field].value !== incoming.value) {
                existing.candidates.push({ field, value: incoming.value, evidence: incoming.evidence || '合并别名档案时发现不同设定，请核对。', sourceFloor: incoming.sourceFloor });
            }
        }
    }
    return normalizeProfiles(result);
}

export function mergeProfileUpdates(rawProfiles, updates, floor, aliases = []) {
    const resolver = buildAliasResolver(aliases);
    const profiles = reconcileProfileAliases(rawProfiles, aliases);
    const byName = new Map();
    profiles.forEach(profile => {
        [profile.name, ...profile.aliases].forEach(name => byName.set(nameKey(resolver.resolveName(name)), profile));
    });
    for (const update of list(updates)) {
        const name = resolver.resolveName(text(update?.name, 160));
        if (!name) continue;
        const validFields = Object.entries(PROFILE_FIELDS).flatMap(([field]) => {
            const value = text(update.fields?.[field]?.value);
            const evidence = text(update.fields?.[field]?.evidence, 1000);
            return value && evidence ? [{ field, value, evidence, sourceFloor: floor }] : [];
        });
        if (!validFields.length) continue;
        let profile = byName.get(nameKey(name));
        if (!profile) {
            const usedIds = new Set(profiles.map(item => item.id));
            let nextId = profiles.length + 1;
            while (usedIds.has(`person-${nextId}`)) nextId++;
            profile = normalizeProfiles([{ id: `person-${nextId}`, name, _addedAt: floor }])[0];
            profiles.push(profile);
            byName.set(nameKey(name), profile);
        }
        for (const updateField of validFields) {
            const current = profile.fields[updateField.field];
            if (current.value === updateField.value) continue;
            if (profile.candidates.some(item => item.field === updateField.field && item.value === updateField.value)) continue;
            if (profile.history.some(item => item.action === 'rejected' && item.field === updateField.field && item.value === updateField.value)) continue;
            if (current.value && current.locked) {
                profile.candidates.push(updateField);
            } else {
                recordChange(profile, updateField.field, updateField, 'automatic');
                profile.fields[updateField.field] = { ...updateField, locked: current.locked };
            }
        }
    }
    return normalizeProfiles(profiles);
}

export function stampEditedProfiles(previous, edited, floor) {
    const oldById = new Map(normalizeProfiles(previous).map(profile => [profile.id, profile]));
    return normalizeProfiles(edited).map(profile => {
        const old = oldById.get(profile.id);
        profile._addedAt = old?._addedAt ?? floor;
        for (const [field, value] of Object.entries(profile.fields)) {
            const before = old?.fields[field];
            if (value.value !== (before?.value || '')) {
                const alreadyRecorded = profile.history.some(entry => entry.field === field && entry.previous === (before?.value || '') && entry.value === value.value && entry.action === 'accepted');
                if (!alreadyRecorded) {
                    profile.history.push({ field, previous: before?.value || '', value: value.value, evidence: value.evidence || '用户手动编辑', sourceFloor: floor, action: 'manual' });
                    value.sourceFloor = floor;
                    value.evidence ||= '用户手动编辑';
                }
            } else if (before) {
                value.evidence = before.evidence;
                value.sourceFloor = before.sourceFloor;
            }
        }
        return profile;
    });
}

export function formatCharacterProfiles(rawProfiles, { maxChars = 8000 } = {}) {
    const profiles = normalizeProfiles(rawProfiles).filter(profile => profile.pinned);
    const header = '【人物基础档案｜稳定设定】\n以下为角色底稿；关系、情绪与成长属于动态状态，不应无依据改写性格、底线或长期动机。未列出的信息未知，不要补造。\n';
    let output = header;
    let omittedFields = 0;
    for (const profile of profiles) {
        const heading = `\n角色：${profile.name}${profile.aliases.length ? `（别名：${profile.aliases.join('、')}）` : ''}\n`;
        let block = '';
        for (const [field, label] of Object.entries(PROFILE_FIELDS)) {
            const value = profile.fields[field].value;
            if (!value) continue;
            const line = `${label}：${value}\n`;
            if (output.length + heading.length + block.length + line.length <= maxChars) block += line;
            else omittedFields++;
        }
        if (block) output += heading + block;
    }
    return { text: output === header ? '' : output.trim(), omittedFields };
}

export const PROFILE_UPDATE_PROMPT = `
人物基础档案增量（可选）：在 JSON 根对象加入 "profileUpdates": [
  {"name":"规范角色名","fields":{"personality":{"value":"有原文依据的稳定性格","evidence":"本批原文中的直接依据"}}}
]。
可用字段：background 身份背景、appearance 外貌、personality 稳定性格、values 价值观底线、speech 说话方式、motivation 长期动机、abilities 能力限制、notes 固定设定。
只提取本批原文明确支持的基础信息，每个字段必须同时提供 value 和 evidence；缺失信息不猜测、不清空。临时情绪、好感、当前位置和关系变化仍写 factUpdates/arcUpdates，不能当作固定性格。
已有锁定字段是稳定底稿；除非原文明确揭示新的事实，不提出相反设定。更新不会自动覆盖锁定字段，而会交由用户审核。没有新证据时省略 profileUpdates。`;
