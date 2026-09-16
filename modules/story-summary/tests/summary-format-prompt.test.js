import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { parse } from 'acorn';
import { PROFILE_UPDATE_PROMPT } from '../data/character-profiles.js';
import { LORE_UPDATE_PROMPT } from '../data/world-lore.js';
import { EVENT_MEMORY_ROLES } from '../data/events.js';

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

test('实际模型消息同时包含关系、人物档案与世界观规则，并要求补建有证据的初次关系', () => {
    const configTree = parse(configSource, { ecmaVersion: 'latest', sourceType: 'module' });
    const declarations = configTree.body
        .filter(node => node.type === 'ExportNamedDeclaration'
            && node.declaration?.type === 'VariableDeclaration'
            && node.declaration.declarations[0].id.name.startsWith('DEFAULT_SUMMARY_'))
        .map(node => configSource.slice(node.declaration.start, node.declaration.end));
    const llmSource = readFileSync(new URL('../generate/llm.js', import.meta.url), 'utf8');
    const llmTree = parse(llmSource, { ecmaVersion: 'latest', sourceType: 'module' });
    const names = ['buildSummaryMessages', 'formatFactsForLLM', 'b64UrlEncode'];
    const functions = llmTree.body.map(node => node.type === 'ExportNamedDeclaration' ? node.declaration : node)
        .filter(node => node?.type === 'FunctionDeclaration' && names.includes(node.id.name));
    assert.equal(functions.length, names.length);
    const context = vm.createContext({ PROFILE_UPDATE_PROMPT, LORE_UPDATE_PROMPT, EVENT_MEMORY_ROLES, TextEncoder, btoa });
    vm.runInContext([...declarations, ...functions.map(node => llmSource.slice(node.start, node.end))].join('\n'), context);
    const messages = context.buildSummaryMessages(
        '【已记录人物关系】暂无；【已记录事件】曾互相帮助', [],
        '新内容', '21-25楼', 3, 2,
    );
    const format = messages.bottomMessages[0].content;
    assert.match(format, /人物关系提取（每批必查）/);
    assert.match(format, /"relationship_scan"/);
    assert.match(format, /不把角色名单两两连线/);
    assert.match(format, /"p": "对角色乙的看法"/);
    assert.match(format, /"isState": true, "trend": "投缘"/);
    assert.ok(format.includes(PROFILE_UPDATE_PROMPT));
    assert.ok(format.includes(LORE_UPDATE_PROMPT));
    assert.match(messages.topMessages[3].content, /【已记录人物关系】暂无/);
});
