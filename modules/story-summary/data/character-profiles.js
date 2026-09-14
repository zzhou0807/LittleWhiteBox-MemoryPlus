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
const MISSING_EVIDENCE = '模型未提供依据，请核对原文';

// 模型偶尔会把字段写成纯字符串，或把依据只写在该条目顶层。
// 这类输出同样有价值：取值照收，但没有逐字段依据时不直接落库，而是转交审核。
function resolveUpdateField(raw, fallbackEvidence) {
    const source = typeof raw === 'string' ? { value: raw } : (raw && typeof raw === 'object' ? raw : null);
    if (!source) return null;
    const value = text(source.value || source.text || source.content);
    if (!value) return null;
    const evidence = text(source.evidence, 1000) || text(fallbackEvidence, 1000);
    return { value, evidence: evidence || MISSING_EVIDENCE, verified: !!evidence };
}

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
        const fieldSource = update?.fields && typeof update.fields === 'object' ? update.fields : update;
        const validFields = Object.entries(PROFILE_FIELDS).flatMap(([field]) => {
            const parsed = resolveUpdateField(fieldSource?.[field], update?.evidence);
            return parsed ? [{ field, ...parsed, sourceFloor: floor }] : [];
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
            const staged = {
                field: updateField.field,
                value: updateField.value,
                evidence: updateField.evidence,
                sourceFloor: updateField.sourceFloor,
            };
            // 没有逐字段依据时只排队审核：底稿会长期影响生成，不能凭一条无出处的内容直接改写。
            if (!updateField.verified || (current.value && current.locked)) {
                profile.candidates.push(staged);
            } else {
                recordChange(profile, updateField.field, staged, 'automatic');
                profile.fields[updateField.field] = { ...staged, locked: current.locked };
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
人物基础档案增量（每批必查）：在 JSON 根对象加入 "profileUpdates": [
  {"name":"规范角色名","evidence":"本批原文或已记录事件中的依据","fields":{"personality":{"value":"有原文依据的稳定性格"}}}
]。
可用字段：background 身份背景、appearance 外貌、personality 稳定性格、values 价值观底线、speech 说话方式、motivation 长期动机、abilities 能力限制、notes 固定设定。
每批开始前先做一遍检查，三件事都要看：
1) 本批新对话里出现的稳定人物信息；
2) 「已有基础档案」里列出的待补全字段，能否用本批对话或【已记录事件】里的已有内容补上；
3) 已经记录过的字段是否有新的明确依据需要修正。
每个字段都要给 value；evidence 写在字段内或写在该条目顶层都可以，至少提供一处。缺失信息不猜测、不清空。
临时情绪、好感、当前位置和关系变化仍写 factUpdates/arcUpdates，不能当作固定性格。
已有 locked 字段是稳定底稿；除非原文明确揭示新的事实，不提出相反设定。更新不会自动覆盖锁定字段，而会交由用户审核。
确实没有任何可补充或修正的档案时才能省略 profileUpdates，但必须真的检查过。`;
