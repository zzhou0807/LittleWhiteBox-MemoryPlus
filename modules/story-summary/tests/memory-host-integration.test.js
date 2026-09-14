import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import vm from 'node:vm';
import test from 'node:test';
import { parse } from 'acorn';
import { normalizeEventMemoryRole, projectSummaryEvent } from '../data/events.js';
import { formatCharacterProfiles, mergeProfileUpdates, normalizeProfiles, reconcileProfileAliases } from '../data/character-profiles.js';
import { normalizeInjectionSettings, resolveSummaryInjection } from '../data/injection-settings.js';
import { applyCharacterAliasUpdates, canonicalizeIncrementalSummaryData, normalizeCharacterAliases } from '../data/character-aliases.js';
import { buildSummaryUndo } from '../data/summary-undo.js';
import { isRelationFact } from '../data/fact-predicates.js';

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
const portableDependencies = { normalizeProfiles, normalizeCharacterAliases, normalizeEventMemoryRole, formatCharacterProfiles };
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

async function prepare({ vector = false, boundary = 9, length = 15, trigger = {}, profiles = makeProfiles(), aborted = false } = {}) {
    let vectorCalls = 0;
    let nonVectorCalls = 0;
    const dependencies = {
        MODULE_ID: 'test',
        xbLog: { info() {}, warn() {} },
        getVectorConfig: () => ({ enabled: vector }),
        isTokenizerReady: () => true,
        getContext: () => ({ chatId: 'fixture-chat', chat: Array.from({ length }, () => ({ mes: 'test' })) }),
        getSummaryStore: () => ({ json: { profiles }, lastSummarizedMesId: boundary }),
        getMeta: async () => ({ lastChunkFloor: boundary }),
        getSummaryPanelConfig: () => ({ trigger }),
        formatCharacterProfiles, normalizeInjectionSettings, resolveSummaryInjection,
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
    'mergeNewData', 'mergeFacts', 'factKey', 'getNextFactId', 'normalizeCharacterNameKey', 'normalizeArcProgress',
], {
    FACTS_LIMIT_PER_SUBJECT: 10,
    canonicalizeIncrementalSummaryData, projectSummaryEvent, applyCharacterAliasUpdates,
    mergeProfileUpdates, normalizeProfiles, reconcileProfileAliases, buildSummaryUndo, isRelationFact,
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
