import assert from 'node:assert/strict';
import test from 'node:test';
import { orderSummaryEvents, stampEditedSummaryEvents } from '../data/events.js';
import { normalizeInjectionSettings, resolveSummaryInjection } from '../data/injection-settings.js';
import { formatCharacterProfiles, mergeProfileUpdates, normalizeProfiles, reconcileProfileAliases, resolveProfileCandidate, stampEditedProfiles } from '../data/character-profiles.js';
import { applySummaryUndo, buildSummaryUndo } from '../data/summary-undo.js';
import { formatStorySummaryL2Events } from '../prompt-events.js';
import { projectStoryCharacters } from '../prompt-characters.js';

const baseline = () => normalizeProfiles([{
    id: 'person-1', name: '旅人', fields: {
        personality: { value: '谨慎，重视考据', evidence: '设定卡', locked: true },
        motivation: { value: '编写万草图鉴', locked: true },
    },
}]);
const update = (field, value, evidence = '本批对话中的明确依据') => ({ name: '旅人', fields: { [field]: { value, evidence } } });

test('manual event order preserves IDs, causal references and original source floors', () => {
    const before = [{ id: 'evt-1', summary: '一', _addedAt: 8 }, { id: 'evt-2', summary: '二', causedBy: ['evt-1'], _addedAt: 19 }];
    const edited = stampEditedSummaryEvents(before, [before[0], { id: 'evt-3', summary: '补录' }, before[1]], 35);
    assert.deepEqual(edited.map(event => event.id), ['evt-1', 'evt-3', 'evt-2']);
    assert.deepEqual(edited.map(event => event._addedAt), [8, 35, 19]);
    assert.deepEqual(edited[2].causedBy, ['evt-1']);
    assert.deepEqual(orderSummaryEvents([edited[2], edited[0], edited[1]]), edited);
    const prompt = formatStorySummaryL2Events(edited, { throughMessageIndex: 35 });
    assert.ok(prompt.indexOf('一') < prompt.indexOf('补录'));
    assert.ok(prompt.indexOf('补录') < prompt.indexOf('二'));
    assert.doesNotMatch(formatStorySummaryL2Events(edited, { throughMessageIndex: 19 }), /补录/);
});

test('duplicate event IDs are repaired and deleting events cleans causal links', () => {
    const result = stampEditedSummaryEvents([{ id: 'evt-7' }], [
        { id: 'evt-7', causedBy: ['gone'] }, { id: 'evt-7' }, { summary: 'new' },
    ], 0);
    assert.equal(new Set(result.map(event => event.id)).size, 3);
    assert.deepEqual(result[0].causedBy, []);
});

test('legacy event order is unchanged until manually edited', () => {
    const events = [{ id: 'evt-4', _addedAt: 90 }, { id: 'evt-1', _addedAt: 0 }];
    assert.deepEqual(orderSummaryEvents(events), events);
});

test('locked personality becomes a candidate without overwriting the baseline', () => {
    const before = baseline();
    const result = mergeProfileUpdates(before, [update('personality', '鲁莽冲动')], 40);
    assert.equal(result[0].fields.personality.value, '谨慎，重视考据');
    assert.equal(result[0].fields.motivation.value, '编写万草图鉴');
    assert.equal(result[0].candidates[0].sourceFloor, 40);
    assert.deepEqual(before, baseline());
});

test('missing and empty updates never clear a profile', () => {
    const before = baseline();
    assert.deepEqual(mergeProfileUpdates(before, [], 40), before);
    assert.deepEqual(mergeProfileUpdates(before, [update('personality', '')], 40), before);
    const staged = mergeProfileUpdates(before, [update('motivation', '不同目标', '')], 40);
    assert.equal(staged[0].fields.motivation.value, '编写万草图鉴');
    assert.equal(staged[0].candidates[0].value, '不同目标');
    assert.match(staged[0].candidates[0].evidence, /未提供依据/);
});

test('blank fields fill from evidence and remain locked by default', () => {
    const result = mergeProfileUpdates(baseline(), [update('speech', '习惯引用典籍')], 40);
    assert.equal(result[0].fields.speech.value, '习惯引用典籍');
    assert.equal(result[0].fields.speech.locked, true);
    assert.equal(result[0].history[0].action, 'automatic');
    const next = mergeProfileUpdates(result, [update('speech', '满口粗话')], 50);
    assert.equal(next[0].fields.speech.value, '习惯引用典籍');
    assert.equal(next[0].candidates.length, 1);
});

test('explicitly unlocked fields may update and retain the previous value in history', () => {
    const profiles = baseline();
    profiles[0].fields.personality.locked = false;
    const result = mergeProfileUpdates(profiles, [update('personality', '谨慎但变得勇敢')], 40);
    assert.equal(result[0].fields.personality.value, '谨慎但变得勇敢');
    assert.equal(result[0].history[0].previous, '谨慎，重视考据');
});

test('accept and reject candidates are staged, logged, and duplicates are suppressed', () => {
    const proposed = mergeProfileUpdates(baseline(), [update('personality', '鲁莽冲动')], 40);
    const repeated = mergeProfileUpdates(proposed, [update('personality', '鲁莽冲动')], 50);
    assert.equal(repeated[0].candidates.length, 1);
    const accepted = resolveProfileCandidate(proposed[0], 0, true);
    assert.equal(accepted.fields.personality.value, '鲁莽冲动');
    assert.equal(accepted.fields.personality.locked, true);
    assert.equal(accepted.candidates.length, 0);
    assert.equal(proposed[0].candidates.length, 1);
    const rejected = resolveProfileCandidate(proposed[0], 0, false);
    assert.equal(rejected.fields.personality.value, '谨慎，重视考据');
    assert.equal(mergeProfileUpdates([rejected], [update('personality', '鲁莽冲动')], 60)[0].candidates.length, 0);
});

test('manual profile saves preserve provenance and log changed values', () => {
    const before = baseline();
    const edited = structuredClone(before);
    edited[0].fields.motivation.value = '完成大陆植物志';
    const result = stampEditedProfiles(before, edited, 50);
    assert.equal(result[0].fields.personality.evidence, '设定卡');
    assert.equal(result[0].fields.motivation.sourceFloor, 50);
    assert.equal(result[0].history.at(-1).previous, '编写万草图鉴');
});

test('alias merging retains identity and queues conflicting locked fields', () => {
    const before = baseline();
    before.push(normalizeProfiles([{ id: 'person-2', name: '学者', fields: { personality: '勇敢', abilities: '辨认药草' } }])[0]);
    const result = reconcileProfileAliases(before, [{ from: '学者', to: '旅人', evidence: '同一人', _addedAt: 10 }]);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'person-1');
    assert.equal(result[0].fields.personality.value, '谨慎，重视考据');
    assert.equal(result[0].fields.abilities.value, '辨认药草');
    assert.equal(result[0].candidates[0].value, '勇敢');
    const next = mergeProfileUpdates(result, [{ ...update('speech', '古朴'), name: '学者' }], 50);
    assert.equal(next.length, 1);
    assert.equal(next[0].fields.speech.value, '古朴');
});

test('profile batch undo restores candidates and rejects conflicts with manual edits', () => {
    const before = { characters: { main: [] }, profiles: baseline() };
    const after = { ...before, profiles: mergeProfileUpdates(before.profiles, [update('personality', '冲动')], 40) };
    const undo = buildSummaryUndo(before, after);
    assert.deepEqual(applySummaryUndo(after, undo), before);
    const manual = structuredClone(after);
    manual.profiles[0].fields.personality.value = '手动修订';
    assert.equal(applySummaryUndo(manual, undo), null);
});

test('profile normalization is idempotent and ignores unsupported fields', () => {
    const result = normalizeProfiles([{ id: 'x', name: '甲', fields: { mood: '生气', personality: '冷静' } }, null, { name: '' }]);
    assert.equal(result.length, 1);
    assert.equal(result[0].fields.mood, undefined);
    assert.deepEqual(normalizeProfiles(result), result);
});

test('resident profile budget drops whole fields, not sentence fragments', () => {
    const profiles = baseline();
    profiles[0].fields.appearance.value = '外貌'.repeat(1500);
    const result = formatCharacterProfiles(profiles, { maxChars: 350 });
    assert.ok(result.text.length <= 350);
    assert.match(result.text, /编写万草图鉴/);
    assert.doesNotMatch(result.text, /外貌外貌/);
    assert.equal(result.omittedFields, 1);
    profiles[0].pinned = false;
    assert.equal(formatCharacterProfiles(profiles).text, '');
});

test('public character projection exposes profiles for manually added characters', () => {
    const result = projectStoryCharacters({ lastSummarizedMesId: -1, json: { profiles: baseline() } }, {
        throughMessageIndex: 10, currentMessageIndex: 10, name: '旅人',
    });
    assert.match(result[0].text, /谨慎，重视考据/);
    assert.equal(projectStoryCharacters({ lastSummarizedMesId: 10, json: { profiles: baseline() } }, {
        throughMessageIndex: 9, currentMessageIndex: 10, name: '旅人',
    }).length, 0);
});

test('injection modes are mutually exclusive and bounded by actual chat length', () => {
    assert.deepEqual(resolveSummaryInjection({}, 50, 39), { mode: 'auto', depth: 10, requestedDepth: 10 });
    assert.equal(resolveSummaryInjection({ injectionMode: 'fixed', injectionDepth: 4 }, 50, 39).depth, 4);
    assert.equal(resolveSummaryInjection({ injectionMode: 'fixed', injectionDepth: 999 }, 5, 1).depth, 5);
    assert.equal(resolveSummaryInjection({ injectionMode: 'fixed', injectionDepth: 4, forceInsertAtEnd: true }, 50, 39).depth, 0);
    assert.equal(resolveSummaryInjection({}, 1, 0).depth, 1);
    assert.equal(resolveSummaryInjection({ injectionMode: 'fixed', injectionDepth: 0 }, 5, 3).depth, 0);
    assert.equal(normalizeInjectionSettings({ injectionDepth: 'oops', profileCharBudget: -10 }).injectionDepth, 4);
    assert.equal(normalizeInjectionSettings({ profileCharBudget: 1e10 }).profileCharBudget, 32000);
});
