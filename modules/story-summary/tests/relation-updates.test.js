import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeFacts } from '../generate/fact-updates.js';
import { canonicalizeIncrementalSummaryData } from '../data/character-aliases.js';

test('简繁体关系输出归一为有向核心事实，不生成没有依据的反向关系', () => {
    const parsed = { factUpdates: [
        { s: '蘇晚', p: '與顧衡的關係', o: '因归还失物而信任', trend: '投緣' },
        { s: '顧衡', p: '對林月的態度', o: '提防其勒索', trend: '厭惡', isState: false },
    ] };
    sanitizeFacts(parsed);
    assert.deepEqual(parsed.factUpdates, [
        { s: '蘇晚', p: '对顧衡的看法', o: '因归还失物而信任', trend: '投缘', isState: true },
        { s: '顧衡', p: '对林月的看法', o: '提防其勒索', trend: '厌恶', isState: true },
    ]);
});

test('兼容旧式 relationships，不因输出位置不同而静默丢失关系', () => {
    const relation = { from: '蘇晚', to: '顧衡', label: '相信其归还失物的承诺', trend: '親密' };
    for (const parsed of [
        { relationshipUpdates: [relation] },
        { relationships: [relation] },
        { characters: { relationships: [relation] } },
    ]) {
        sanitizeFacts(parsed);
        assert.deepEqual(parsed.factUpdates, [
            { s: '蘇晚', p: '对顧衡的看法', o: relation.label, trend: '亲密', isState: true },
        ]);
    }
});

test('重复格式只产生一条关系，正式 factUpdates 优先且清洗可重复执行', () => {
    const parsed = {
        relationships: [{ from: '蘇晚', to: '顧衡', label: '旧描述', trend: '陌生' }],
        factUpdates: [{ s: '蘇晚', p: '与顧衡的关系', o: '相信其承诺', trend: '投缘' }],
    };
    sanitizeFacts(parsed);
    const once = structuredClone(parsed.factUpdates);
    sanitizeFacts(parsed);
    assert.deepEqual(parsed.factUpdates, once);
    assert.equal(once.length, 1);
    assert.equal(once[0].o, '相信其承诺');
});

test('有角色无关系证据时不造关系，损坏输出被安全忽略', () => {
    for (const parsed of [
        { newCharacters: ['蘇晚', '顧衡'], events: [{ participants: ['蘇晚', '顧衡'] }] },
        { relationships: [null, {}, { from: '蘇晚', to: '顧衡' }, { from: '蘇晚', to: '蘇晚', label: '同名' }] },
        { relationshipUpdates: {}, characters: { relationships: 'error' }, factUpdates: [null, {}, { s: {}, p: '位置', o: '城门' }] },
    ]) {
        sanitizeFacts(parsed);
        assert.deepEqual(parsed.factUpdates, []);
    }
});

test('普通事实、零值、删除与非法趋势不会被误当成关系或清空为新关系', () => {
    const parsed = { factUpdates: [
        { s: '蘇晚', p: '当前位置', o: '城门' },
        { s: '蘇晚', p: '金币', o: 0 },
        { s: '蘇晚', p: '對顧衡的看法', retracted: true },
        { s: '顧衡', p: '对林月的看法', o: '不信其承诺', trend: '随意生成的等级' },
        { s: '蘇晚', p: '身份', o: {} },
    ] };
    sanitizeFacts(parsed);
    assert.deepEqual(parsed.factUpdates, [
        { s: '蘇晚', p: '位置', o: '城门', isState: false },
        { s: '蘇晚', p: '金币', o: '0', isState: false },
        { s: '蘇晚', p: '对顧衡的看法', retracted: true },
        { s: '顧衡', p: '对林月的看法', o: '不信其承诺', isState: true },
    ]);
});

test('关系目标的繁体谓词和旧称呼仍会参与别名归一', () => {
    const parsed = { relationships: [{ from: '蘇晚', to: '道長', label: '信任医术', trend: '投緣' }] };
    sanitizeFacts(parsed);
    const result = canonicalizeIncrementalSummaryData(parsed, [{ from: '道長', to: '李玄清' }]);
    assert.equal(result.factUpdates[0].p, '对李玄清的看法');
    assert.equal(result.factUpdates[0].s, '蘇晚');
});
