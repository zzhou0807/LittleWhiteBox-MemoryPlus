import assert from 'node:assert/strict';
import test from 'node:test';

import { isRelationFact, normalizeRelationPredicate, parseRelationTarget } from '../data/fact-predicates.js';

test('relation fact predicates share one canonical parser', () => {
    assert.equal(parseRelationTarget('对 林月 的看法'), '林月');
    assert.equal(parseRelationTarget('身体特征'), null);
    assert.equal(isRelationFact({ p: '对林月的态度' }), true);
    assert.equal(isRelationFact({ p: '所在地' }), false);
});

test('关系清洗与显示共同识别简繁体谓词和关系同义写法，保留原文姓名', () => {
    for (const predicate of ['对蘇晚的看法', '對 蘇晚 的看法', '對蘇晚的態度', '与蘇晚的关系', '與蘇晚的關係', '和蘇晚的关系', '跟蘇晚的關係']) {
        assert.equal(parseRelationTarget(predicate), '蘇晚');
        assert.equal(normalizeRelationPredicate(predicate), '对蘇晚的看法');
        assert.equal(isRelationFact({ p: predicate }), true);
    }
    for (const predicate of ['所在地', '关系', '身体特征', '对林月的承诺', '对的看法', '对  的看法']) {
        assert.equal(parseRelationTarget(predicate), null);
        assert.equal(normalizeRelationPredicate(predicate), null);
    }
});
