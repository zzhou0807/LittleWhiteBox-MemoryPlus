import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test, { beforeEach } from 'node:test';
import { parseHTML } from 'linkedom';
import { mountEventEditor, mountProfileEditor, renderProfilesPanel } from '../ui/memory-editors.js';
import { mergeProfileUpdates, normalizeProfiles } from '../data/character-profiles.js';

let container;
beforeEach(() => {
    const { document, window } = parseHTML('<html><body><div id="editor"></div></body></html>');
    globalThis.document = document;
    if (!globalThis.crypto) globalThis.crypto = webcrypto;
    const descriptor = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value');
    if (!descriptor?.set) Object.defineProperty(window.HTMLSelectElement.prototype, 'value', {
        configurable: true,
        get() { return [...this.options].find(option => option.selected)?.value || ''; },
        set(value) { for (const option of this.options) option.selected = option.value === value; },
    });
    container = document.getElementById('editor');
});

const click = (root, text) => {
    const target = [...root.querySelectorAll('button')].find(button => button.textContent === text);
    assert.ok(target, `missing button: ${text}`);
    target.click();
};
const ids = () => [...container.querySelectorAll('.event-item')].map(card => card.dataset.id);

test('insert in the middle, reorder, and undo without losing unsaved text', () => {
    mountEventEditor(container, [{ id: 'evt-1', title: '出发' }, { id: 'evt-2', title: '抵达' }]);
    const first = container.querySelector('.event-item');
    first.querySelector('.event-title').value = '修改但未保存';
    click(first, '＋ 在后插入');
    assert.deepEqual(ids(), ['evt-1', 'evt-3', 'evt-2']);
    const added = container.querySelector('[data-id="evt-3"]');
    added.querySelector('.event-title').value = '途中休息';
    click(added, '↓ 下移');
    assert.deepEqual(ids(), ['evt-1', 'evt-2', 'evt-3']);
    click(container, '撤销操作');
    assert.deepEqual(ids(), ['evt-1', 'evt-3', 'evt-2']);
    assert.equal(added.querySelector('.event-title').value, '途中休息');
    assert.equal(first.querySelector('.event-title').value, '修改但未保存');
    click(added, '删除');
    click(container, '撤销操作');
    assert.equal(container.querySelector('[data-id="evt-3"] .event-title').value, '途中休息');
});

test('an empty timeline can insert at either end and deleted IDs are not reused during editing', () => {
    mountEventEditor(container, []);
    click(container, '＋ 开头插入');
    click(container.querySelector('.event-item'), '删除');
    click(container, '＋ 末尾追加');
    assert.deepEqual(ids(), ['evt-2']);
});

test('event search preserves hidden records and does not mutate stored events', () => {
    const original = [{ id: 'evt-1', title: '出发' }, { id: 'evt-2', title: '抵达' }];
    mountEventEditor(container, original);
    const search = container.querySelector('.memory-search');
    search.value = '抵达';
    search.oninput();
    assert.equal(container.querySelector('[data-id="evt-1"]').hidden, true);
    assert.equal(ids().length, 2);
    assert.equal(original[0].title, '出发');
});

test('profile review preserves unsaved fields and cancellation leaves the baseline intact', () => {
    const original = mergeProfileUpdates(normalizeProfiles([{
        id: 'p1', name: '旅人', fields: { personality: '谨慎' },
    }]), [{ name: '旅人', fields: { personality: { value: '谨慎且勇敢', evidence: '直面危险' } } }], 20);
    const editor = mountProfileEditor(container, original);
    container.querySelector('[data-field="motivation"] textarea').value = '编写图鉴';
    click(container, '接受并锁定');
    const result = editor.read();
    assert.equal(result[0].fields.motivation.value, '编写图鉴');
    assert.equal(result[0].fields.personality.value, '谨慎且勇敢');
    assert.equal(result[0].candidates.length, 0);
    assert.equal(original[0].fields.personality.value, '谨慎');
    assert.equal(original[0].candidates.length, 1);
});

test('profile editor rejects duplicate names and can undo removal', () => {
    const editor = mountProfileEditor(container, normalizeProfiles([{ id: 'p1', name: '甲' }]), ['甲', '乙']);
    click(container, '补齐主要人物空白档案');
    assert.equal(editor.read().length, 2);
    const cards = [...container.querySelectorAll('.memory-profile-editor')];
    cards[1].querySelector('.profile-name').value = '甲';
    assert.throws(() => editor.read(), /重复角色名/);
    cards[1].querySelector('.profile-name').value = '乙';
    click(cards[0], '删除档案');
    assert.equal(editor.read().length, 1);
    click(container, '恢复「甲」');
    assert.equal(editor.read().length, 2);
});

test('新建人物与补齐在没有 window.crypto 的明文 http 页面依然可用', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
    try {
        const editor = mountProfileEditor(container, normalizeProfiles([{ id: 'p1', name: '甲' }]), ['甲', '乙']);
        click(container, '＋ 新建人物');
        click(container, '补齐主要人物空白档案');
        assert.deepEqual(editor.read().map(profile => profile.name), ['甲', '新角色', '乙']);
        assert.equal(container.querySelector('.memory-editor-status').classList.contains('error'), false);
    } finally {
        if (original) Object.defineProperty(globalThis, 'crypto', original);
        else delete globalThis.crypto;
    }
});

test('补齐没有可用人物名时给出提示，而不是静默无反应', () => {
    mountProfileEditor(container, [], []);
    click(container, '补齐主要人物空白档案');
    assert.match(container.querySelector('.memory-editor-status').textContent, /暂时没有可用的人物名/);
});

test('untrusted profile and event text never becomes executable markup', () => {
    const malicious = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    renderProfilesPanel(container, [{ name: malicious, fields: { personality: malicious } }]);
    assert.equal(container.querySelector('script, img'), null);
    assert.match(container.textContent, /onerror/);
    mountProfileEditor(container, [{ name: malicious, fields: { personality: malicious } }]);
    assert.equal(container.querySelector('script, img'), null);
    mountEventEditor(container, [{ id: 'evt-1', title: malicious, summary: malicious }]);
    assert.equal(container.querySelector('script, img'), null);
});
