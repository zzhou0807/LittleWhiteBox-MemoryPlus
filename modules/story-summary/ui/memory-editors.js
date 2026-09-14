import { EVENT_MEMORY_ROLES, orderSummaryEvents } from '../data/events.js';
import { normalizeProfiles, PROFILE_FIELDS, resolveProfileCandidate } from '../data/character-profiles.js';

function element(tag, className = '', content = '') {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = content;
    return node;
}

function button(label, action, className = 'btn btn-sm') {
    const node = element('button', className, label);
    node.type = 'button';
    node.onclick = action;
    return node;
}

function input(className, placeholder, value = '', multiline = false) {
    const node = element(multiline ? 'textarea' : 'input', className);
    if (!multiline) node.type = 'text';
    else node.rows = 2;
    node.placeholder = placeholder;
    node.setAttribute('aria-label', placeholder);
    node.value = value;
    return node;
}

function checkbox(label, checked) {
    const wrapper = element('label', 'memory-check');
    const control = element('input');
    control.type = 'checkbox';
    control.checked = checked;
    wrapper.append(control, document.createTextNode(label));
    return { wrapper, control };
}

export function mountEventEditor(container, rawEvents = []) {
    const events = orderSummaryEvents(rawEvents);
    container.replaceChildren();
    const toolbar = element('div', 'memory-toolbar');
    const search = input('memory-search', '搜索标题、正文或人物');
    const status = element('span', 'memory-muted');
    status.setAttribute('aria-live', 'polite');
    const list = element('div', 'memory-event-list');
    const undoStack = [];
    let nextId = Math.max(0, ...events.map(event => Number(/^evt-(\d+)$/.exec(event.id)?.[1]) || 0));
    const undoButton = button('撤销操作', () => {
        undoStack.pop()?.();
        refresh();
    });
    const items = () => Array.from(list.children);
    const refresh = () => {
        const cards = items();
        cards.forEach((card, index) => {
            card.querySelector('.event-number').textContent = `${index + 1} / ${cards.length} · ${card.dataset.id}`;
            card.querySelector('.event-up').disabled = index === 0;
            card.querySelector('.event-down').disabled = index === cards.length - 1;
            const text = [...card.querySelectorAll('input, textarea')].map(control => control.value).join(' ').toLowerCase();
            card.hidden = !!search.value && !text.includes(search.value.trim().toLowerCase());
        });
        undoButton.disabled = !undoStack.length;
        status.textContent = `${cards.length} 条事件 · 保存后生效`;
    };
    const move = (card, reference) => {
        const oldNext = card.nextSibling;
        list.insertBefore(card, reference);
        undoStack.push(() => list.insertBefore(card, oldNext));
        refresh();
    };
    const add = reference => {
        search.value = '';
        const card = createCard({ id: `evt-${++nextId}` });
        list.insertBefore(card, reference);
        undoStack.push(() => card.remove());
        refresh();
        card.querySelector('.event-title').focus();
    };
    const createCard = event => {
        const card = element('div', 'struct-item event-item memory-event');
        card.dataset.id = event.id || `evt-${++nextId}`;
        const heading = element('div', 'memory-toolbar');
        const number = element('span', 'event-number memory-muted');
        const up = button('↑ 上移', () => move(card, card.previousSibling), 'btn btn-sm event-up');
        const down = button('↓ 下移', () => move(card, card.nextSibling?.nextSibling || null), 'btn btn-sm event-down');
        heading.append(number, up, down);
        const row = element('div', 'struct-row');
        row.append(input('event-title', '事件标题', event.title || ''), input('event-time', '时间标签', event.timeLabel || ''));
        const summary = input('event-summary', '事件经过与影响', event.summary || '', true);
        const participants = input('event-participants', '人物（顿号分隔）', (event.participants || []).join('、'));
        const roleLabel = element('label', 'event-memory-role-field', '记忆作用 ');
        const role = element('select', 'event-memory-role');
        role.setAttribute('aria-label', '记忆作用');
        ['', ...EVENT_MEMORY_ROLES].forEach(value => {
            const option = element('option', '', value || '未标注');
            option.value = value;
            role.append(option);
        });
        role.value = event.memoryRole || '';
        roleLabel.append(role);
        const actions = element('div', 'struct-actions');
        actions.append(
            button('＋ 在前插入', () => add(card)),
            button('＋ 在后插入', () => add(card.nextSibling)),
            button('删除', () => {
                const oldNext = card.nextSibling;
                card.remove();
                undoStack.push(() => list.insertBefore(card, oldNext));
                refresh();
            }, 'btn btn-sm btn-del'),
        );
        card.append(heading, row, summary, participants, roleLabel, actions);
        card.addEventListener('keydown', event => {
            if (!event.altKey) return;
            if (event.key === 'ArrowUp' && card.previousSibling) {
                event.preventDefault();
                move(card, card.previousSibling);
            } else if (event.key === 'ArrowDown' && card.nextSibling) {
                event.preventDefault();
                move(card, card.nextSibling.nextSibling);
            }
        });
        return card;
    };
    toolbar.append(search, button('＋ 开头插入', () => add(list.firstChild)), button('＋ 末尾追加', () => add(null)), undoButton, status);
    container.append(toolbar, element('p', 'memory-muted', '顺序与原文楼层分开保存。支持 Alt + ↑ / ↓；移动不会丢失未保存的输入。'), list);
    events.forEach(event => list.append(createCard(event)));
    search.oninput = refresh;
    refresh();
}

export function renderProfilesPanel(container, rawProfiles) {
    const profiles = normalizeProfiles(rawProfiles);
    container.replaceChildren();
    if (!profiles.length) {
        container.append(element('p', 'empty', '还没有基础档案。可手动补录早期设定；后续总结也会提取有依据的人物信息。不会把关系变化当成人设。'));
        return;
    }
    for (const profile of profiles) {
        const card = element('details', 'memory-profile-preview');
        card.open = profile === profiles[0];
        const summary = element('summary', '', profile.name);
        summary.append(element('span', 'memory-badge', `${profile.pinned ? '常驻' : '不注入'}${profile.candidates.length ? ` · ${profile.candidates.length} 待审` : ''}`));
        card.append(summary);
        let hasFields = false;
        for (const [key, label] of Object.entries(PROFILE_FIELDS)) {
            if (!profile.fields[key].value) continue;
            hasFields = true;
            const line = element('p', 'memory-profile-line');
            line.append(element('strong', '', `${label}${profile.fields[key].locked ? ' · 已锁定' : ''}`), element('span', '', profile.fields[key].value));
            card.append(line);
        }
        if (!hasFields) card.append(element('p', 'memory-muted', '空白档案：请补充确定的设定，不需要填写未知信息。'));
        container.append(card);
    }
}

export function mountProfileEditor(container, rawProfiles, knownNames = []) {
    container.replaceChildren();
    const toolbar = element('div', 'memory-toolbar');
    const search = input('memory-search', '按角色名或别名搜索');
    const cards = element('div', 'memory-profile-list');
    const states = new Map();
    const refresh = () => {
        for (const card of cards.children) {
            card.hidden = ![card.querySelector('.profile-name').value, card.querySelector('.profile-aliases').value]
                .join(' ').toLowerCase().includes(search.value.toLowerCase().trim());
        }
    };
    function readCard(card) {
        const profile = structuredClone(states.get(card));
        profile.name = card.querySelector('.profile-name').value.trim();
        profile.aliases = card.querySelector('.profile-aliases').value.split(/[,、，]/).map(name => name.trim()).filter(Boolean);
        profile.pinned = card.querySelector('.profile-pinned').checked;
        for (const key of Object.keys(PROFILE_FIELDS)) {
            profile.fields[key].value = card.querySelector(`[data-field="${key}"] textarea`).value.trim();
            profile.fields[key].locked = card.querySelector(`[data-field="${key}"] input`).checked;
        }
        return profile;
    }
    function createCard(rawProfile) {
        const profile = normalizeProfiles([rawProfile])[0];
        const card = element('details', 'struct-item memory-profile-editor');
        card.open = true;
        states.set(card, profile);
        const heading = element('summary', '', profile.name);
        const name = input('profile-name', '角色名（必填）', profile.name);
        name.maxLength = 160;
        name.oninput = () => { heading.textContent = name.value || '未命名角色'; };
        const aliases = input('profile-aliases', '别名（顿号分隔）', profile.aliases.join('、'));
        const pinned = checkbox('常驻注入（不依赖向量召回）', profile.pinned);
        pinned.control.className = 'profile-pinned';
        const row = element('div', 'struct-row');
        row.append(name, aliases);
        const content = element('div', 'memory-profile-body');
        content.append(row, pinned.wrapper);
        for (const [key, label] of Object.entries(PROFILE_FIELDS)) {
            const field = profile.fields[key];
            const group = element('div', 'memory-profile-field');
            group.dataset.field = key;
            const fieldHead = element('div', 'memory-toolbar');
            const lock = checkbox('锁定', field.locked);
            lock.control.setAttribute('aria-label', `${label}锁定`);
            fieldHead.append(element('strong', '', label), lock.wrapper);
            const value = input('', `${label}：仅填写有依据的稳定信息`, field.value, true);
            value.maxLength = 4000;
            group.append(fieldHead, value);
            if (field.evidence) group.append(element('small', 'memory-muted', `依据${field.sourceFloor == null ? '' : ` #${field.sourceFloor}`}：${field.evidence}`));
            content.append(group);
        }
        if (profile.candidates.length) {
            const review = element('section', 'memory-candidates');
            review.append(element('h3', '', `待审核更新 · ${profile.candidates.length}`), element('p', 'memory-muted', '锁定字段未被覆盖。接受后保存才会替换底稿；拒绝相同建议后不再重复提出。'));
            profile.candidates.forEach((candidate, index) => {
                const item = element('div', 'memory-candidate');
                item.append(
                    element('strong', '', PROFILE_FIELDS[candidate.field]),
                    element('p', 'memory-before', `当前：${profile.fields[candidate.field].value || '未填写'}`),
                    element('p', 'memory-after', `建议：${candidate.value}`),
                    element('p', 'memory-muted', `依据${candidate.sourceFloor == null ? '' : ` #${candidate.sourceFloor}`}：${candidate.evidence || '未提供'}`),
                );
                const resolve = accept => {
                    const edited = readCard(card);
                    if (!edited.name) {
                        name.reportValidity?.();
                        name.focus();
                        return;
                    }
                    const next = resolveProfileCandidate(edited, index, accept);
                    const replacement = createCard(next);
                    card.replaceWith(replacement);
                    states.delete(card);
                };
                item.append(button('接受并锁定', () => resolve(true)), button('拒绝建议', () => resolve(false)));
                review.append(item);
            });
            content.append(review);
        }
        const history = element('details', 'memory-history');
        history.append(element('summary', '', `修改记录 · ${profile.history.length}（保留最近 200 条）`));
        const actionLabels = { manual: '手动编辑', accepted: '已接受', rejected: '已拒绝', automatic: '自动补充' };
        [...profile.history].reverse().forEach(entry => {
            history.append(element('p', '', `${actionLabels[entry.action]} · ${PROFILE_FIELDS[entry.field]}${entry.sourceFloor == null ? '' : ` · #${entry.sourceFloor}`}\n${entry.previous || '空白'} → ${entry.value || '空白'}\n${entry.evidence}`));
        });
        content.append(history, button('删除档案', () => {
            const previousNext = card.nextSibling;
            card.remove();
            const undo = button(`恢复「${profile.name}」`, () => {
                cards.insertBefore(card, previousNext?.parentNode === cards ? previousNext : null);
                undo.remove();
                refresh();
            });
            toolbar.append(undo);
        }, 'btn btn-sm btn-del'));
        card.append(heading, content);
        return card;
    }
    const add = name => {
        const id = `person-${globalThis.crypto.randomUUID()}`;
        const card = createCard({ id, name, fields: {} });
        cards.append(card);
        search.value = '';
        refresh();
        card.querySelector('.profile-name').focus();
    };
    const existingProfiles = normalizeProfiles(rawProfiles);
    toolbar.append(search, button('＋ 新建人物', () => add('新角色')), button('补齐主要人物空白档案', () => {
        const names = new Set([...cards.children].map(card => readCard(card).name.toLowerCase()));
        for (const name of knownNames) {
            if (!name || names.has(name.toLowerCase())) continue;
            add(name);
            names.add(name.toLowerCase());
        }
    }));
    container.append(toolbar, cards);
    existingProfiles.forEach((profile, index) => {
        const card = createCard(profile);
        card.open = index === 0;
        cards.append(card);
    });
    search.oninput = refresh;
    return {
        read() {
            const result = [...cards.children].map(readCard);
            const names = new Set();
            for (const profile of result) {
                if (!profile.name) throw new Error('角色名不能为空');
                if (names.has(profile.name.toLowerCase())) throw new Error(`重复角色名：${profile.name}`);
                names.add(profile.name.toLowerCase());
            }
            return normalizeProfiles(result);
        },
    };
}
