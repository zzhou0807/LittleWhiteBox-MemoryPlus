import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PROFILE_UPDATE_PROMPT } from '../data/character-profiles.js';
import { LORE_UPDATE_PROMPT } from '../data/world-lore.js';

// config.js 依赖酒馆运行时的 ../../../../../../extensions.js，不能在 Node 里直接 import，
// 因此这里以源码文本方式校验模板装配结果。
const configSource = readFileSync(fileURLToPath(new URL('../data/config.js', import.meta.url)), 'utf8');
const formatPromptStart = configSource.indexOf('export const DEFAULT_SUMMARY_USER_JSON_FORMAT_PROMPT');
const formatPromptEnd = configSource.indexOf('export const DEFAULT_SUMMARY_ASSISTANT_CHECK_PROMPT');
const formatPromptTemplate = configSource.slice(formatPromptStart, formatPromptEnd);

const countOccurrences = (haystack, needle) => haystack.split(needle).length - 1;

test('档案与世界观增量指令内联进 JSON 格式提示，且只出现一次', () => {
    assert.ok(formatPromptStart > 0 && formatPromptEnd > formatPromptStart);
    assert.ok(PROFILE_UPDATE_PROMPT.trim().length > 0);
    assert.ok(LORE_UPDATE_PROMPT.trim().length > 0);

    assert.equal(countOccurrences(formatPromptTemplate, '${PROFILE_UPDATE_PROMPT}'), 1);
    assert.equal(countOccurrences(formatPromptTemplate, '${LORE_UPDATE_PROMPT}'), 1);

    const outputFormatAt = formatPromptTemplate.indexOf('## Output Format');
    assert.ok(outputFormatAt > 0, 'JSON 格式提示应保留 Output Format 段');
    assert.ok(formatPromptTemplate.indexOf('${PROFILE_UPDATE_PROMPT}') < outputFormatAt, 'profileUpdates 指令应排在输出格式之前');
    assert.ok(formatPromptTemplate.indexOf('${LORE_UPDATE_PROMPT}') < outputFormatAt, 'loreUpdates 指令应排在输出格式之前');

    assert.match(formatPromptTemplate, /"profileUpdates"\s*:\s*\[/);
    assert.match(formatPromptTemplate, /"loreUpdates"\s*:\s*\[/);
    assert.match(formatPromptTemplate, /profileUpdates 与 loreUpdates 每批都要检查一遍/);

    assert.match(configSource, /import \{ PROFILE_UPDATE_PROMPT \} from '\.\/character-profiles\.js';/);
    assert.match(configSource, /import \{ LORE_UPDATE_PROMPT \} from '\.\/world-lore\.js';/);
});
