import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import vm from 'node:vm';
import test from 'node:test';
import { parse } from 'acorn';
import { normalizeEventMemoryRole, projectSummaryEvent } from '../data/events.js';
import { PROFILE_FIELDS, formatCharacterProfiles, mergeProfileUpdates, normalizeProfiles, reconcileProfileAliases } from '../data/character-profiles.js';
import { normalizeInjectionSettings, resolveSummaryInjection } from '../data/injection-settings.js';
import { LORE_CATEGORIES, LORE_FIELDS, formatWorldLore, mergeLoreUpdates, normalizeLore, reconcileLoreAliases } from '../data/world-lore.js';
import { applyCharacterAliasUpdates, canonicalizeIncrementalSummaryData, formatCharacterAliasTableForAI, normalizeCharacterAliases } from '../data/character-aliases.js';
import { applySummaryUndo, buildSummaryUndo } from '../data/summary-undo.js';
import { isRelationFact, normalizeRelationPredicate, parseRelationTarget } from '../data/fact-predicates.js';
import { sanitizeFacts } from '../generate/fact-updates.js';

async function loadFunctions(file, names, dependencies) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    const functions = tree.body.map(node => node.type === 'ExportNamedDeclaration' ? node.declaration : node)
        .filter(node => node?.type === 'FunctionDeclaration' && names.includes(node.id.name));
    assert.equal(functions.length, names.length, 'all tested production functions must still exist');
    const context = vm.createContext({ structuredClone, console, performance, ...dependencies });
    vm.runInContext(functions.map(node => source.slice(node.start, node.end)).join('\n'), context);
    return context;
}

const makeProfiles = () => normalizeProfiles([{ id: 'p1', name: '旅人', fields: { personality: '谨慎', motivation: '编写图鉴' } }]);
const portableDependencies = { normalizeProfiles, normalizeLore, normalizeCharacterAliases, normalizeEventMemoryRole, formatCharacterProfiles };
const portable = await loadFunctions('../story-summary.js', [
    'cloneSummaryJsonForPortability', 'stripFloorMarker', 'normalizeInternalFact', 'normalizePortableFact',
    'extractSummaryImportJson', 'stampImportedSummaryJson', 'serializePortableFact', 'buildSummaryExportPackage',
], portableDependencies);

test('actual host memory export/import preserves profiles, locks, review queues and manual order', () => {
    const profiles = mergeProfileUpdates(makeProfiles(), [{ name: '旅人', fields: { personality: { value: '冲动', evidence: '新证据' } } }], 40);
    const json = {
        events: [{ id: 'evt-1', summary: '首条 (#0-8)', sortOrder: 1, _addedAt: 8 }, { id: 'evt-2', summary: '补录', sortOrder: 0, _addedAt: 40 }],
        profiles, characters: { main: [] },
        facts: [{ s: '旅人', p: '住所', o: '木屋' }],
    };
    const pkg = portable.buildSummaryExportPackage({ json });
    assert.equal(pkg.counts.profiles, 1);
    const imported = portable.extractSummaryImportJson(JSON.parse(JSON.stringify(pkg)));
    assert.equal(imported.profiles[0].fields.personality.value, '谨慎');
    assert.equal(imported.profiles[0].fields.personality.locked, true);
    assert.equal(imported.profiles[0].candidates[0].value, '冲动');
    assert.equal(imported.profiles[0].candidates[0].sourceFloor, null);
    assert.equal(imported.events[1].sortOrder, 0);
    assert.equal(imported.events[0].summary, '首条');
    assert.equal(imported.facts[0].o, '木屋');
    portable.stampImportedSummaryJson(imported, 10);
    assert.equal(imported.profiles[0]._addedAt, 10);
    assert.equal(imported.events[1]._addedAt, 10);
    assert.equal(json.events[1]._addedAt, 40);
});

test('legacy packages import with an empty optional profile panel', () => {
    const imported = portable.extractSummaryImportJson({ events: [{ id: 'evt-1', type: '主线', weight: '核心', summary: '旧记忆' }] });
    assert.equal(imported.profiles.length, 0);
    assert.equal(imported.events[0].summary, '旧记忆');
    assert.equal(portable.extractSummaryImportJson({ profiles: makeProfiles() }).profiles.length, 1);
});

async function prepare({ vector = false, boundary = 9, length = 15, trigger = {}, profiles = makeProfiles(), lore = [], aborted = false } = {}) {
    let vectorCalls = 0;
    let nonVectorCalls = 0;
    const dependencies = {
        MODULE_ID: 'test',
        xbLog: { info() {}, warn() {} },
        getVectorConfig: () => ({ enabled: vector }),
        isTokenizerReady: () => true,
        getContext: () => ({ chatId: 'fixture-chat', chat: Array.from({ length }, () => ({ mes: 'test' })) }),
        getSummaryStore: () => ({ json: { profiles, lore }, lastSummarizedMesId: boundary }),
        getMeta: async () => ({ lastChunkFloor: boundary }),
        getSummaryPanelConfig: () => ({ trigger }),
        formatCharacterProfiles, formatWorldLore, normalizeInjectionSettings, resolveSummaryInjection,
        buildVectorPromptText: async () => { vectorCalls++; return { text: '向量召回的事件', logText: '测试召回' }; },
        buildNonVectorPromptText: () => { nonVectorCalls++; return '完整剧情记忆'; },
        ROLE_MAP: { system: 0, user: 1, assistant: 2 },
        extension_prompt_roles: { SYSTEM: 0 },
    };
    const host = await loadFunctions('../story-summary.js', ['prepareMemoryPrompt'], dependencies);
    const result = await host.prepareMemoryPrompt('normal', { aborted });
    return { result, vectorCalls, nonVectorCalls };
}

test('actual prepare path includes resident profiles with vector mode on and off', async () => {
    const vector = await prepare({ vector: true, trigger: { injectionMode: 'fixed', injectionDepth: 3 } });
    assert.match(vector.result.text, /编写图鉴[\s\S]*向量召回的事件/);
    assert.equal(vector.result.depth, 3);
    assert.equal(vector.vectorCalls, 1);
    const plain = await prepare();
    assert.match(plain.result.text, /编写图鉴[\s\S]*完整剧情记忆/);
    assert.equal(plain.result.depth, 5);
    assert.equal(plain.nonVectorCalls, 1);
});

test('profiles inject before the first summary without inventing a vector boundary', async () => {
    const { result, vectorCalls, nonVectorCalls } = await prepare({ vector: true, boundary: -1, length: 2 });
    assert.match(result.text, /谨慎/);
    assert.equal(result.depth, 2);
    assert.equal(vectorCalls, 0);
    assert.equal(nonVectorCalls, 0);
    const empty = await prepare({ boundary: -1, profiles: [] });
    assert.equal(empty.result.skipReason, 'no_boundary');
});

test('actual prepare honors end placement and role and never injects after cancellation', async () => {
    const { result } = await prepare({ trigger: { forceInsertAtEnd: true, injectionMode: 'fixed', injectionDepth: 6, role: 'user' } });
    assert.equal(result.depth, 0);
    assert.equal(result.role, 1);
    assert.equal((await prepare({ aborted: true })).result.text, '');
    assert.equal((await prepare({ length: 0 })).result.skipReason, 'empty_chat');
});

test('profile budget overflow is reported by the actual host prepare path', async () => {
    const profiles = makeProfiles();
    profiles[0].fields.appearance.value = '描述'.repeat(1800);
    const { result } = await prepare({ profiles, trigger: { profileCharBudget: 1000 } });
    assert.equal(result.notice.issueCode, 'profile_budget');
    assert.match(result.text, /编写图鉴/);
    assert.doesNotMatch(result.text, /描述描述/);
});

const storeFunctions = await loadFunctions('../data/store.js', [
    'mergeNewData', 'mergeFacts', 'factKey', 'getNextFactId', 'normalizeCharacterNameKey', 'normalizeArcProgress', 'extractRelationshipsFromFacts',
], {
    FACTS_LIMIT_PER_SUBJECT: 10,
    canonicalizeIncrementalSummaryData, projectSummaryEvent, applyCharacterAliasUpdates,
    mergeProfileUpdates, normalizeProfiles, reconcileProfileAliases, buildSummaryUndo, isRelationFact,
    mergeLoreUpdates, reconcileLoreAliases,
    normalizeRelationPredicate, parseRelationTarget,
});

test('关系从原始 JSON 经真实清洗合并到面板，保留手工关系并支持精确撤销', () => {
    const before = {
        facts: [{ id: 'f-1', s: '蘇晚', p: '对顧衡的看法', o: '钦佩其医术', trend: '投缘', _isState: true, _addedAt: 2 }],
        characters: { main: [{ name: '蘇晚' }, { name: '顧衡' }, { name: '林月' }] },
    };
    const parsed = JSON.parse('{"factUpdates":[{"s":"顧衡","p":"與林月的關係","o":"提防她的勒索","trend":"反感"}]}');
    sanitizeFacts(parsed);
    const result = storeFunctions.mergeNewData(before, parsed, 20, { returnMeta: true });
    const relations = storeFunctions.extractRelationshipsFromFacts(result.json.facts);
    assert.equal(relations.length, 2);
    assert.equal(relations[1].to, '林月');
    assert.equal(relations[1].label, '提防她的勒索');
    assert.deepEqual(result.json.facts[0], before.facts[0]);
    const undone = applySummaryUndo(result.json, result.undo);
    assert.ok(undone);
    assert.deepEqual(undone.facts, before.facts);
});

test('旧繁体和与字关系立即可显示，后续更新复用 ID 和趋势，不产生重复边', () => {
    const before = [{ id: 'f-7', s: '蘇晚', p: '與顧衡的關係', o: '旧描述', trend: '投缘', _isState: false, _addedAt: 2 }];
    assert.equal(storeFunctions.extractRelationshipsFromFacts(before)[0].to, '顧衡');
    const merged = storeFunctions.mergeFacts(before, [
        { s: '蘇晚', p: '对顧衡的看法', o: '托付保管信物', isState: false },
    ], 30);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, 'f-7');
    assert.equal(merged[0].trend, '投缘');
    assert.equal(merged[0]._addedAt, 2);
    assert.equal(merged[0]._isState, true);
    assert.equal(storeFunctions.mergeFacts(merged, [{ s: '蘇晚', p: '對顧衡的態度', retracted: true }], 31).length, 0);
});

test('历史同向关系有多个谓词时保留最近状态，撤销后还原所有旧条目', () => {
    const before = { facts: [
        { id: 'f-1', s: '蘇晚', p: '对顧衡的看法', o: '托付信物', trend: '亲密', since: 40, _addedAt: 1 },
        { id: 'f-2', s: '蘇晚', p: '與顧衡的關係', o: '刚认识', trend: '陌生', since: 10, _addedAt: 10 },
    ] };
    const result = storeFunctions.mergeNewData(before, {}, 50, { returnMeta: true });
    assert.equal(result.json.facts.length, 1);
    assert.equal(result.json.facts[0].o, '托付信物');
    assert.deepEqual(applySummaryUndo(result.json, result.undo).facts, before.facts);
});

test('跨批普通事实容量清理保留旧非核心关系，不凭角色名单新增关系', () => {
    const before = [{ id: 'f-1', s: '蘇晚', p: '對顧衡的看法', o: '愿意协助', trend: '投缘', _isState: false, _addedAt: 1 }];
    let facts = before;
    for (let index = 0; index < 25; index++) {
        facts = storeFunctions.mergeFacts(facts, [{ s: '蘇晚', p: `见闻${index}`, o: `记录${index}` }], index + 2);
    }
    assert.equal(facts.length, 11);
    assert.equal(storeFunctions.extractRelationshipsFromFacts(facts).length, 1);
    assert.deepEqual(facts[0], before[0]);
    assert.equal(storeFunctions.extractRelationshipsFromFacts(
        storeFunctions.mergeNewData({}, { newCharacters: ['蘇晚', '顧衡'] }, 26).facts,
    ).length, 0);
});

const summaryFormatting = await loadFunctions('../generate/generator.js', [
    'formatExistingSummaryForAI', 'formatMissingFieldsForAI',
], { PROFILE_FIELDS, LORE_FIELDS, LORE_CATEGORIES, isRelationFact, parseRelationTarget, formatCharacterAliasTableForAI });

test('真实总结上下文单列现有关系，并提示只补有依据的遗漏而非重写事件', () => {
    const json = {
        facts: [
            { s: '蘇晚', p: '與顧衡的關係', o: '信任', trend: '投缘' },
            { s: '林月', p: '对顧衡的看法', o: '旧描述', retracted: true },
        ],
        events: [{ title: '援手', timeLabel: '入城时', summary: '顧衡因蘇晚的协助而信任她。' }],
        profiles: makeProfiles(),
    };
    const text = summaryFormatting.formatExistingSummaryForAI({ json });
    assert.match(text, /【已记录人物关系/);
    assert.match(text, /"from":"蘇晚","to":"顧衡","label":"信任"/);
    assert.match(text, /尚未记录的关系也要通过 factUpdates 补建/);
    assert.match(text, /顧衡因蘇晚的协助而信任她/);
    assert.match(text, /【档案待补全字段】/);
    assert.doesNotMatch(text, /林月/);
    assert.match(summaryFormatting.formatExistingSummaryForAI({ json: { characters: { main: ['蘇晚', '顧衡'] } } }),
        /尚未记录人物关系；有角色名单不代表已经建立关系/);
});

test('actual store merge appends generated events after manual order and protects profiles across batches', () => {
    const before = {
        profiles: makeProfiles(),
        events: [{ id: 'evt-1', sortOrder: 0, summary: '旧事件', _addedAt: 9 }],
    };
    const after = storeFunctions.mergeNewData(before, {
        events: [{ id: 'evt-2', summary: '新事件', sortOrder: -999 }],
        profileUpdates: [{ name: '旅人', fields: { personality: { value: '冲动', evidence: '新片段' } } }],
    }, 20, { returnMeta: true });
    assert.equal(after.json.events[1].sortOrder, 1);
    assert.equal(after.json.events[1]._addedAt, 20);
    assert.equal(after.json.profiles[0].fields.personality.value, '谨慎');
    assert.equal(after.json.profiles[0].candidates.length, 1);
    assert.ok(after.undo.profileChanges);
    const next = storeFunctions.mergeNewData(after.json, { keywords: [{ text: '旅行', weight: '核心' }] }, 30);
    assert.equal(next.profiles[0].fields.motivation.value, '编写图鉴');
    assert.equal(next.profiles[0].candidates.length, 1);
});

test('actual store merge keeps locked world lore and queues conflicting settings for review', () => {
    const before = {
        lore: mergeLoreUpdates(normalizeLore([{
            id: 'lore-1', name: '药谷', category: 'city', fields: { rules: { value: '雾气会放大气味', evidence: '虚构设定卡' } },
        }]), [], 9),
    };
    const after = storeFunctions.mergeNewData(before, {
        loreUpdates: [
            { name: '药谷', fields: { details: { value: '谷口有一座废弃哨塔', evidence: '#12 原文描述' } } },
            { name: '药谷', category: 'city', fields: { rules: { value: '雾气会让人忘记来路', evidence: '#13 传闻' } } },
        ],
    }, 20, { returnMeta: true });
    assert.equal(after.json.lore.length, 1);
    assert.equal(after.json.lore[0].category, 'city');
    assert.equal(after.json.lore[0].fields.rules.value, '雾气会放大气味');
    assert.equal(after.json.lore[0].fields.details.value, '谷口有一座废弃哨塔');
    assert.equal(after.json.lore[0].candidates.length, 1);
    assert.equal(after.json.lore[0].candidates[0].sourceFloor, 20);
    assert.ok(after.undo.loreChanges);
});

test('actual prepare path injects resident world lore before the summary body', async () => {
    const lore = mergeLoreUpdates(normalizeLore([{
        id: 'lore-1', name: '药谷', category: 'city', fields: { rules: { value: '雾气会放大气味', evidence: '虚构设定卡' } },
    }]), [], 9);
    const { result } = await prepare({ lore });
    assert.match(result.text, /【世界观设定｜固定设定】/);
    assert.match(result.text, /雾气会放大气味[\s\S]*完整剧情记忆/);
});

test('world lore budget overflow is reported by the actual host prepare path', async () => {
    const lore = normalizeLore([{
        id: 'lore-1', name: '药谷', category: 'city', fields: { details: { value: '设定'.repeat(1200), evidence: '虚构设定卡' } },
    }]);
    const { result } = await prepare({ lore, trigger: { loreCharBudget: 1000 } });
    assert.equal(result.notice.issueCode, 'lore_budget');
    assert.doesNotMatch(result.text, /设定设定/);
});
