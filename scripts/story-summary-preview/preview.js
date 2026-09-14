import { mergeProfileUpdates, normalizeProfiles, stampEditedProfiles } from '../../modules/story-summary/data/character-profiles.js';
import { stampEditedSummaryEvents } from '../../modules/story-summary/data/events.js';

const frame = document.getElementById('preview');
const status = document.getElementById('status');
let config = { trigger: { enabled: false, injectionMode: 'auto', injectionDepth: 4, profileCharBudget: 8000, role: 'system' }, vector: { enabled: false } };
const summary = {
    chatId: 'local-fiction-fixture',
    lastSummarizedMesId: 29,
    keywords: [{ text: '旅途', weight: '核心' }, { text: '植物志', weight: '重要' }],
    events: [
        { id: 'evt-1', title: '离开故乡', timeLabel: '初夏', summary: '林舟带着未完成的植物志，离开山村。', participants: ['林舟'], memoryRole: '具体经历', _addedAt: 9 },
        { id: 'evt-2', title: '结伴同行', timeLabel: '三日后', summary: '林舟与向导青岚约定互相帮助，一同翻越山岭。', participants: ['林舟', '青岚'], causedBy: ['evt-1'], memoryRole: '约定承诺', _addedAt: 19 },
        { id: 'evt-3', title: '抵达药谷', timeLabel: '月末', summary: '两人抵达药谷，决定先调查未知的药草。', participants: ['林舟', '青岚'], memoryRole: '信息揭示', _addedAt: 29 },
    ],
    characters: { main: [{ name: '林舟' }, { name: '青岚' }], relationships: [{ from: '林舟', to: '青岚', label: '信任的同伴', trend: '投缘' }] },
    arcs: [{ name: '林舟', trajectory: '从独行到学习合作', progress: 0.35, moments: [{ text: '第一次主动向同伴求助' }] }],
    facts: [{ id: 'f-1', s: '林舟', p: '所在地', o: '药谷', since: 29 }],
    profiles: mergeProfileUpdates(normalizeProfiles([
        { id: 'person-1', name: '林舟', fields: {
            background: { value: '出身山村的年轻药草学徒。', evidence: '虚构测试设定' },
            personality: { value: '谨慎、好奇，遇到结论习惯先核对证据。', evidence: '虚构测试设定' },
            values: '不以他人的安危交换研究成果。',
            motivation: '完成一本记录各地药草的植物志。',
            speech: '说话温和，经常引用师父的笔记。',
        } },
        { id: 'person-2', name: '青岚', fields: { background: '熟悉山路的向导。', personality: '爽快务实，重视承诺。' } },
    ]), [{ name: '林舟', fields: { personality: { value: '冲动好胜，不再核对任何证据。', evidence: '一次争执后着急出发（用于测试拦截，不能当作稳定人设）' } } }], 29),
};

function send(type, payload = {}) {
    frame.contentWindow.postMessage({ source: 'LittleWhiteBox', type, ...payload }, location.origin);
}

function publish() {
    send('LOAD_PANEL_CONFIG', { config });
    send('CHAT_SUMMARY_STATE', { state: { effectiveEnabled: true, consumable: true } });
    send('SUMMARY_FULL_DATA', { payload: summary });
    send('SUMMARY_BASE_DATA', { stats: { eventsCount: summary.events.length, summarizedUpTo: summary.lastSummarizedMesId + 1, pendingFloors: 8, hiddenCount: 0 }, hideSummarized: false, keepVisibleCount: 6, vectorEnabled: false });
}

window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.source !== 'LittleWhiteBox-StoryFrame') return;
    const data = event.data;
    if (data.type === 'FRAME_READY') publish();
    else if (data.type === 'REQUEST_PANEL_CONFIG') send('LOAD_PANEL_CONFIG', { config });
    else if (data.type === 'SAVE_PANEL_CONFIG') {
        config = data.config;
        send('PANEL_CONFIG_SAVE_RESULT', { requestId: data.requestId, success: true, config });
        status.textContent = '测试配置已保存到本页内存；没有修改任何酒馆设置。';
    } else if (data.type === 'UPDATE_SECTION') {
        if (data.section === 'profiles') summary.profiles = stampEditedProfiles(summary.profiles, data.data, 37);
        else if (data.section === 'events') summary.events = stampEditedSummaryEvents(summary.events, data.data, 37);
        else summary[data.section] = data.data;
        send('SUMMARY_FULL_DATA', { payload: summary });
        status.textContent = `已保存到测试内存：${data.section}；可重开面板核对。`;
    } else if (data.type === 'REQUEST_GENERATE') {
        send('GENERATION_STATE', { isGenerating: false });
        status.textContent = '已拦截模型请求。此沙盒不会连接任何 API。';
    }
});

document.getElementById('reopen').onclick = () => { frame.src = '../../modules/story-summary/story-summary.html'; };
document.getElementById('viewport').onclick = () => document.body.classList.toggle('narrow');
document.getElementById('simulate').onclick = () => {
    summary.profiles = mergeProfileUpdates(summary.profiles, [{
        name: '林舟', fields: {
            personality: { value: '冲动好胜，不再核对任何证据。', evidence: '测试：再次提出相同变化' },
            abilities: { value: '擅长辨认常见药草；不认识的品种需要查证。', evidence: '测试：新的明确能力描述' },
        },
    }], 39);
    publish();
    status.textContent = '模拟完成：锁定性格不变，空白能力字段补充，相同待审建议不重复。';
};
frame.src = '../../modules/story-summary/story-summary.html';
