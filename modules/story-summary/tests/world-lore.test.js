import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test, { beforeEach } from 'node:test';
import { parseHTML } from 'linkedom';
import { normalizeInjectionSettings } from '../data/injection-settings.js';
import { applySummaryUndo, buildSummaryUndo } from '../data/summary-undo.js';
import {
    formatWorldLore, mergeLoreUpdates, normalizeLore, reconcileLoreAliases, resolveLoreCandidate, stampEditedLore,
} from '../data/world-lore.js';
import { mountLoreEditor, renderLorePanel } from '../ui/memory-editors.js';

let container;
beforeEach(() => {
    const { document, window } = parseHTML('<html><body><div id="editor"></div></body></html>');
    globalThis.document = document;
    if (!globalThis.crypto) globalThis.crypto = webcrypto;
    // linkedom 的 select 只有 getter，且 option.selected 会回写 select，直接在 setter 里
    // 同步 selected 会递归互相清空。测试里改用独立状态记录，专注验证读写行为。
    if (!Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set) {
        const values = new WeakMap();
        Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
            configurable: true,
            get() { return values.has(this) ? values.get(this) : ''; },
            set(value) { values.set(this, value); },
        });
    }
    container = document.getElementById('editor');
});

const click = (root, text) => {
    const target = [...root.querySelectorAll('button')].find(button => button.textContent === text);
    assert.ok(target, `missing button: ${text}`);
    target.click();
};

const baseline = () => normalizeLore([{
    id: 'lore-1', name: '药谷', category: 'city', fields: {
        overview: { value: '夹在山脊之间、常年起雾的谷地', evidence: '设定卡', locked: true },
        rules: { value: '雾气会放大气味', locked: true },
    },
}]);
const update = (field, value, evidence = '本批原文中的明确依据', name = '药谷') => ({ name, fields: { [field]: { value, evidence } } });

test('lore fields fill from evidence, stay locked, and conflicts become review items', () => {
    const before = baseline();
    const filled = mergeLoreUpdates(before, [update('details', '谷口立着一座废弃哨塔')], 30);
    assert.equal(filled[0].fields.details.value, '谷口立着一座废弃哨塔');
    assert.equal(filled[0].fields.details.locked, true);
    assert.equal(filled[0].history.at(-1).action, 'automatic');

    const conflicting = mergeLoreUpdates(filled, [update('rules', '雾气会让人忘记来路')], 40);
    assert.equal(conflicting[0].fields.rules.value, '雾气会放大气味');
    assert.equal(conflicting[0].candidates[0].value, '雾气会让人忘记来路');
    assert.equal(conflicting[0].candidates[0].sourceFloor, 40);
    assert.deepEqual(before, baseline());

    const repeated = mergeLoreUpdates(conflicting, [update('rules', '雾气会让人忘记来路')], 50);
    assert.equal(repeated[0].candidates.length, 1);
});

test('missing or evidence-less lore updates never clear or overwrite a setting', () => {
    const before = baseline();
    assert.deepEqual(mergeLoreUpdates(before, [], 40), before);
    assert.deepEqual(mergeLoreUpdates(before, [update('rules', ''), update('rules', '不同说法', '')], 40), before);
    assert.deepEqual(mergeLoreUpdates(before, [{ name: '', fields: { rules: { value: '匿名设定', evidence: '依据' } } }], 40), before);
});

test('explicitly unlocked lore fields may update and retain the previous value in history', () => {
    const entries = baseline();
    entries[0].fields.rules.locked = false;
    const result = mergeLoreUpdates(entries, [update('rules', '雾气会放大气味，但雨中会减弱')], 40);
    assert.equal(result[0].fields.rules.value, '雾气会放大气味，但雨中会减弱');
    assert.equal(result[0].history[0].previous, '雾气会放大气味');
});

test('accepting and rejecting staged lore candidates is logged and duplicate advice is suppressed', () => {
    const proposed = mergeLoreUpdates(baseline(), [update('rules', '雾气会让人忘记来路')], 40);
    const accepted = resolveLoreCandidate(proposed[0], 0, true);
    assert.equal(accepted.fields.rules.value, '雾气会让人忘记来路');
    assert.equal(accepted.fields.rules.locked, true);
    assert.equal(accepted.candidates.length, 0);
    assert.equal(proposed[0].candidates.length, 1);
    const rejected = resolveLoreCandidate(proposed[0], 0, false);
    assert.equal(rejected.fields.rules.value, '雾气会放大气味');
    assert.equal(mergeLoreUpdates([rejected], [update('rules', '雾气会让人忘记来路')], 60)[0].candidates.length, 0);
});

test('manual lore saves preserve provenance and log the changed value', () => {
    const before = baseline();
    const edited = structuredClone(before);
    edited[0].category = 'magic';
    edited[0].fields.notes.value = '采药人习惯把湿布面罩挂在谷口';
    const result = stampEditedLore(before, edited, 50);
    assert.equal(result[0].category, 'magic');
    assert.equal(result[0].fields.overview.evidence, '设定卡');
    assert.equal(result[0].fields.notes.sourceFloor, 50);
    assert.equal(result[0].history.at(-1).previous, '');
});

test('duplicate settings merge by name or alias and keep the first description', () => {
    const before = baseline();
    before.push(normalizeLore([{
        id: 'lore-2', name: '雾谷', aliases: ['药谷'], category: 'custom', fields: { details: '采药人聚集的谷地', overview: '另一段描述' },
    }])[0]);
    const result = reconcileLoreAliases(before);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'lore-1');
    assert.equal(result[0].category, 'city');
    assert.deepEqual(result[0].aliases, ['雾谷']);
    assert.equal(result[0].fields.details.value, '采药人聚集的谷地');
    assert.equal(result[0].candidates[0].value, '另一段描述');
    const next = mergeLoreUpdates(result, [update('notes', '入口有哨塔', '依据', '雾谷')], 50);
    assert.equal(next.length, 1);
    assert.equal(next[0].fields.notes.value, '入口有哨塔');
});

test('resident lore budget drops whole fields and non-resident settings are not injected', () => {
    const entries = normalizeLore([{
        id: 'lore-1', name: '药谷', category: 'city', fields: {
            overview: { value: '常年起雾的谷地', evidence: '设定卡' },
            details: { value: '细节'.repeat(400), evidence: '设定卡' },
        },
    }]);
    const result = formatWorldLore(entries, { maxChars: 400 });
    assert.match(result.text, /【世界观设定｜固定设定】/);
    assert.match(result.text, /\[城市与地点\] 药谷/);
    assert.match(result.text, /常年起雾的谷地/);
    assert.doesNotMatch(result.text, /细节细节/);
    assert.equal(result.omittedFields, 1);
    assert.ok(result.text.length <= 400);
    entries[0].pinned = false;
    assert.equal(formatWorldLore(entries).text, '');
});

test('lore budget setting clamps to safe bounds and defaults to 4000', () => {
    assert.equal(normalizeInjectionSettings({}).loreCharBudget, 4000);
    assert.equal(normalizeInjectionSettings({ loreCharBudget: 200 }).loreCharBudget, 1000);
    assert.equal(normalizeInjectionSettings({ loreCharBudget: 99999 }).loreCharBudget, 32000);
    assert.equal(normalizeInjectionSettings({ loreCharBudget: '2500' }).loreCharBudget, 2500);
});

test('batch undo restores staged lore candidates and rejects conflicts with manual edits', () => {
    const before = { characters: { main: [] }, lore: baseline() };
    const after = { ...before, lore: mergeLoreUpdates(before.lore, [update('rules', '雾气会让人忘记来路')], 40) };
    const undo = buildSummaryUndo(before, after);
    assert.ok(undo.loreChanges);
    assert.deepEqual(applySummaryUndo(after, undo), before);
    const manual = structuredClone(after);
    manual.lore[0].fields.rules.value = '手动修订';
    assert.equal(applySummaryUndo(manual, undo), null);
});

test('世界观编辑器在明文 http 页面依然可用，并能保存类别与常驻开关', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
    try {
        const editor = mountLoreEditor(container, baseline());
        click(container, '＋ 新建设定');
        const cards = [...container.querySelectorAll('.memory-profile-editor')];
        assert.equal(cards.length, 2);
        cards[1].querySelector('.lore-name').value = '清醒草';
        cards[1].querySelector('.lore-category').value = 'potion';
        cards[1].querySelector('[data-field="details"] textarea').value = '嚼碎后半个时辰内不受迷雾影响';
        cards[1].querySelector('.lore-pinned').checked = false;
        const added = editor.read().find(entry => entry.name === '清醒草');
        assert.equal(added.category, 'potion');
        assert.equal(added.pinned, false);
        assert.equal(added.fields.details.value, '嚼碎后半个时辰内不受迷雾影响');
        assert.equal(container.querySelector('.memory-editor-status').classList.contains('error'), false);
    } finally {
        if (original) Object.defineProperty(globalThis, 'crypto', original);
        else delete globalThis.crypto;
    }
});

test('世界观编辑器拒绝空名称与重复名称，删除后可恢复', () => {
    const editor = mountLoreEditor(container, baseline());
    click(container, '＋ 新建设定');
    const cards = [...container.querySelectorAll('.memory-profile-editor')];
    cards[1].querySelector('.lore-name').value = '';
    assert.throws(() => editor.read(), /设定名称不能为空/);
    cards[1].querySelector('.lore-name').value = '药谷';
    assert.throws(() => editor.read(), /重复设定名称/);
    cards[1].querySelector('.lore-name').value = '清醒草';
    click(cards[1], '删除设定');
    assert.equal(editor.read().length, 1);
    click(container, '恢复「新设定」');
    assert.equal(editor.read().length, 2);
});

test('审核建议时保留未保存的输入，取消不会改动已保存设定', () => {
    const original = mergeLoreUpdates(baseline(), [update('rules', '雾气会让人忘记来路', '#13 传闻')], 20);
    const editor = mountLoreEditor(container, original);
    container.querySelector('[data-field="notes"] textarea').value = '谷口有废弃哨塔';
    click(container, '接受并锁定');
    const result = editor.read();
    assert.equal(result[0].fields.notes.value, '谷口有废弃哨塔');
    assert.equal(result[0].fields.rules.value, '雾气会让人忘记来路');
    assert.equal(result[0].candidates.length, 0);
    assert.equal(original[0].fields.rules.value, '雾气会放大气味');
    assert.equal(original[0].candidates.length, 1);
});

test('搜索只隐藏不匹配的设定条目，不会删除数据', () => {
    const editor = mountLoreEditor(container, normalizeLore([{ id: 'lore-1', name: '药谷' }, { id: 'lore-2', name: '清醒草' }]));
    const search = container.querySelector('.memory-search');
    search.value = '清醒草';
    search.oninput();
    const cards = [...container.querySelectorAll('.memory-profile-editor')];
    assert.equal(cards[0].hidden, true);
    assert.equal(cards[1].hidden, false);
    assert.equal(editor.read().length, 2);
});

test('untrusted lore text never becomes executable markup', () => {
    const malicious = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    renderLorePanel(container, [{ name: malicious, category: 'city', fields: { details: malicious } }]);
    assert.equal(container.querySelector('script, img'), null);
    assert.match(container.textContent, /onerror/);
    mountLoreEditor(container, [{ name: malicious, fields: { details: malicious } }]);
    assert.equal(container.querySelector('script, img'), null);
});
