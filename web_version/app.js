(() => {
  'use strict';

  const KEY = 'todo-app:v1';
  const BACKUP_KEY = 'todo-app:backup';
  const MAX_LEN = 100;
  const CATEGORIES = { work: '업무', personal: '개인', study: '공부' };

  let state = { version: 1, filter: 'all', todos: [] };
  let editingId = null;
  const expandedTracks = new Set(); // 추적 패널을 펼친 항목 id (저장하지 않음)
  let selectedDate = null; // 달력에서 고른 날짜 'YYYY-MM-DD' (저장하지 않음)
  const now0 = new Date();
  let view = { y: now0.getFullYear(), m: now0.getMonth() };
  const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
  const MAX_CHIPS = 3;

  const $ = (id) => document.getElementById(id);
  const el = {
    today: $('today'),
    warning: $('storage-warning'),
    summary: $('summary'),
    bar: $('bar'),
    barFill: $('bar-fill'),
    catStats: $('cat-stats'),
    form: $('add-form'),
    text: $('add-text'),
    category: $('add-category'),
    due: $('add-due'),
    study: $('add-study'),
    amount: $('add-amount'),
    unit: $('add-unit'),
    filters: $('filters'),
    list: $('list'),
    empty: $('empty'),
    dateFilter: $('date-filter'),
    dateFilterText: $('date-filter-text'),
    dateFilterClear: $('date-filter-clear'),
    calTitle: $('cal-title'),
    calGrid: $('cal-grid'),
    calPrev: $('cal-prev'),
    calNext: $('cal-next'),
    calToday: $('cal-today'),
  };

  // ---------- 저장 / 불러오기 ----------

  function newId() {
    return (crypto.randomUUID && crypto.randomUUID()) ||
      Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  function isValidTodo(t) {
    return t && typeof t.id === 'string' && typeof t.text === 'string' &&
      t.text.length > 0 && t.category in CATEGORIES && typeof t.done === 'boolean' &&
      (t.dueDate === undefined || t.dueDate === null || DATE_RE.test(t.dueDate)) &&
      (t.amount === undefined || t.amount === null || (Number.isFinite(t.amount) && t.amount > 0)) &&
      (t.studied === undefined || (Number.isFinite(t.studied) && t.studied >= 0)) &&
      (t.unit === undefined || typeof t.unit === 'string') &&
      (t.log === undefined || Array.isArray(t.log)) &&
      (t.targets === undefined || (t.targets !== null && typeof t.targets === 'object'));
  }

  // ---------- 공부량 ----------

  const fmt = (n) => String(Math.round(n * 10) / 10);

  // study: { amount, unit, studied } (문자열 입력 가능). 공부량이 없으면 해제한다.
  function applyStudy(t, study) {
    const amount = parseFloat(study.amount);
    if (amount > 0) {
      const studied = parseFloat(study.studied);
      t.amount = amount;
      t.unit = String(study.unit || '').trim().slice(0, 6) || '쪽';
      t.studied = Math.min(amount, studied > 0 ? studied : 0);
    } else {
      t.amount = null;
      t.studied = 0;
    }
    t.dayStart = null; // 오늘 시작 기준을 다시 잡는다
  }

  // 날짜가 바뀌었거나 새로 생긴 공부 항목은 "오늘 시작 시점의 공부량"을 기록한다.
  function ensureStudyDays() {
    const today = todayKey();
    let changed = false;
    for (const t of state.todos) {
      if (t.amount && (!t.dayStart || t.dayStart.date !== today)) {
        t.dayStart = { date: today, studied: t.studied || 0 };
        // 추적용: 그날의 목표를 하루 시작 시점에 고정해 둔다
        const plan = studyPlan(t);
        if (plan.kind === 'ok') {
          if (!t.targets) t.targets = {};
          t.targets[today] = plan.target;
        }
        changed = true;
      }
    }
    if (changed) save();
  }

  // 오늘부터 마감일까지(양 끝 포함)의 날짜 키와 그날 목표. 해당 없으면 keys가 비어 있다.
  function studySpan(t) {
    const none = { keys: [], plan: null };
    if (t.category !== 'study' || !t.amount || t.done || !t.dueDate) return none;
    const plan = studyPlan(t);
    if (plan.kind !== 'ok') return none;
    const n = new Date();
    const keys = [];
    for (let k = 0; k < plan.days; k++) {
      const d = new Date(n.getFullYear(), n.getMonth(), n.getDate() + k);
      keys.push(toKey(d.getFullYear(), d.getMonth(), d.getDate()));
    }
    return { keys, plan };
  }

  // 오늘 시작 시점의 남은 양을 (오늘 포함) 마감일까지의 일수로 나눈다.
  function studyPlan(t) {
    const studied = t.studied || 0;
    const remaining = Math.max(0, t.amount - studied);
    if (remaining === 0) return { kind: 'finished', remaining };
    if (!t.dueDate) return { kind: 'nodue', remaining };
    const left = daysUntil(t.dueDate);
    if (left < 0) return { kind: 'overdue', remaining, late: -left };
    const start = t.dayStart ? t.dayStart.studied : studied;
    const days = left + 1;
    const target = Math.ceil((Math.max(0, t.amount - start) / days) * 10) / 10;
    return { kind: 'ok', remaining, days, target, doneToday: Math.max(0, studied - start) };
  }

  // 'YYYY-MM-DD'를 오늘 기준 남은 일수로 변환 (지났으면 음수)
  function daysUntil(dueDate) {
    const [y, m, d] = dueDate.split('-').map(Number);
    const due = new Date(y, m - 1, d);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((due - today) / 86400000);
  }

  function load() {
    let raw = null;
    try {
      raw = localStorage.getItem(KEY);
    } catch (e) {
      showStorageWarning();
      return;
    }
    if (raw === null) return;
    try {
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.todos)) throw new Error('bad shape');
      state.todos = data.todos.filter(isValidTodo);
      state.filter = data.filter === 'all' || data.filter in CATEGORIES ? data.filter : 'all';
    } catch (e) {
      try { localStorage.setItem(BACKUP_KEY, raw); } catch (_) { /* 무시 */ }
      state = { version: 1, filter: 'all', todos: [] };
    }
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      el.warning.hidden = true;
    } catch (e) {
      showStorageWarning();
    }
  }

  function showStorageWarning() {
    el.warning.hidden = false;
  }

  // ---------- 상태 변경 (변경 → 저장 → 렌더) ----------

  function commit() {
    save();
    render();
  }

  function addTodo(text, category, dueDate, study) {
    const todo = {
      id: newId(),
      text,
      category,
      dueDate: dueDate || null,
      done: false,
      createdAt: Date.now(),
      completedAt: null,
    };
    if (category === 'study' && study) applyStudy(todo, study);
    state.todos.push(todo);
    commit();
  }

  function recordStudy(id, delta) {
    const t = state.todos.find((x) => x.id === id);
    if (!t || !t.amount) return;
    const before = t.studied || 0;
    t.studied = Math.min(t.amount, Math.max(0, before + delta));
    const applied = t.studied - before;
    if (applied !== 0) {
      if (!t.log) t.log = [];
      t.log.push({ date: todayKey(), amount: applied, at: Date.now() });
      if (t.log.length > 500) t.log.splice(0, t.log.length - 500);
    }
    commit();
  }

  // 추적: 날짜별 목표(하루 시작 시점 고정)와 실제 기록
  function trackRows(t) {
    const actual = {};
    for (const e of t.log || []) {
      if (e && typeof e.date === 'string' && Number.isFinite(e.amount)) {
        actual[e.date] = (actual[e.date] || 0) + e.amount;
      }
    }
    const today = todayKey();
    const dates = new Set([...Object.keys(actual), ...Object.keys(t.targets || {})]);
    if (!t.done && t.amount) dates.add(today);
    return [...dates].sort().map((date) => ({
      date,
      target: t.targets && Number.isFinite(t.targets[date]) ? t.targets[date] : null,
      actual: Math.max(0, actual[date] || 0),
      isToday: date === today,
    }));
  }

  function trackSummary(rows) {
    const past = rows.filter((r) => !r.isToday && r.target !== null);
    const achieved = past.filter((r) => r.actual >= r.target).length;
    let streak = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (r.target === null) break;
      if (r.actual >= r.target) streak++;
      else if (!r.isToday) break;
    }
    return { days: past.length, achieved, streak };
  }

  function toggleTodo(id) {
    const t = state.todos.find((x) => x.id === id);
    if (!t) return;
    t.done = !t.done;
    t.completedAt = t.done ? Date.now() : null;
    commit();
  }

  // dueDate: undefined면 그대로 두고, ''이면 마감일 제거
  // study: undefined면 공부량은 그대로 둔다
  function updateTodo(id, text, category, dueDate, study) {
    const t = state.todos.find((x) => x.id === id);
    if (!t) return;
    if (text) t.text = text;
    if (category in CATEGORIES) t.category = category;
    if (dueDate !== undefined) t.dueDate = DATE_RE.test(dueDate) ? dueDate : null;
    if (study) applyStudy(t, study);
    commit();
  }

  function deleteTodo(id) {
    const index = state.todos.findIndex((x) => x.id === id);
    if (index < 0) return;
    state.todos.splice(index, 1);
    if (editingId === id) editingId = null;
    commit();
  }

  function setFilter(filter) {
    state.filter = filter;
    commit();
  }

  // ---------- 렌더링 ----------

  function percent(done, total) {
    return total === 0 ? 0 : Math.round((done / total) * 100);
  }

  function renderDashboard() {
    const total = state.todos.length;
    const done = state.todos.filter((t) => t.done).length;
    const pct = percent(done, total);

    el.summary.textContent = total === 0
      ? '할 일을 추가해 보세요'
      : `${done}/${total} 완료 (${pct}%)`;
    el.barFill.style.width = pct + '%';
    el.bar.setAttribute('aria-valuenow', String(pct));

    el.catStats.textContent = '';
    for (const key of Object.keys(CATEGORIES)) {
      const items = state.todos.filter((t) => t.category === key);
      const d = items.filter((t) => t.done).length;
      const p = percent(d, items.length);

      const li = document.createElement('li');
      li.className = `cat-stat cat-${key}`;

      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = CATEGORIES[key];

      const mini = document.createElement('div');
      mini.className = 'mini-bar';
      const fill = document.createElement('div');
      fill.className = 'mini-fill';
      fill.style.width = p + '%';
      mini.appendChild(fill);

      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = `${d}/${items.length}`;

      li.append(badge, mini, count);
      el.catStats.appendChild(li);
    }
  }

  function renderFilters() {
    el.filters.textContent = '';
    const tabs = [['all', '전체'], ...Object.entries(CATEGORIES)];
    for (const [key, label] of tabs) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.setAttribute('aria-pressed', String(state.filter === key));
      b.addEventListener('click', () => setFilter(key));
      el.filters.appendChild(b);
    }
  }

  function makeButton(label, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  function renderItem(t) {
    const li = document.createElement('li');
    li.className = `item cat-${t.category}${t.done ? ' done' : ''}`;

    if (editingId === t.id) {
      li.classList.add('editing');

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'edit-text';
      input.maxLength = MAX_LEN;
      input.value = t.text;
      input.setAttribute('aria-label', '할 일 수정');

      const select = document.createElement('select');
      select.setAttribute('aria-label', '카테고리');
      for (const [key, label] of Object.entries(CATEGORIES)) {
        const o = document.createElement('option');
        o.value = key;
        o.textContent = label;
        o.selected = key === t.category;
        select.appendChild(o);
      }

      const due = document.createElement('input');
      due.type = 'date';
      due.value = t.dueDate || '';
      due.setAttribute('aria-label', '마감일 (선택)');

      const study = document.createElement('div');
      study.className = 'study-fields';
      const amount = numberInput('총 공부량', t.amount);
      const unit = document.createElement('input');
      unit.type = 'text';
      unit.className = 'unit';
      unit.maxLength = 6;
      unit.value = t.unit || '쪽';
      unit.setAttribute('list', 'unit-list');
      unit.setAttribute('aria-label', '단위');
      const studied = numberInput('지금까지 한 양', t.amount ? t.studied : 0);
      study.append(amount, unit, studied);
      const syncStudy = () => { study.hidden = select.value !== 'study'; };
      select.addEventListener('change', syncStudy);
      syncStudy();

      const finish = (saveIt) => {
        if (editingId !== t.id) return;
        editingId = null;
        if (saveIt) {
          updateTodo(
            t.id, input.value.trim(), select.value, due.value,
            select.value === 'study'
              ? { amount: amount.value, unit: unit.value, studied: studied.value }
              : undefined,
          );
        } else {
          render();
        }
      };

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      for (const field of [select, due, amount, unit, studied]) {
        field.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') { e.preventDefault(); finish(false); }
          else if (e.key === 'Enter' && field !== select) { e.preventDefault(); finish(true); }
        });
      }
      li.addEventListener('focusout', (e) => {
        if (!li.contains(e.relatedTarget)) finish(true);
      });

      const actions = document.createElement('div');
      actions.className = 'actions';
      actions.append(
        makeButton('저장', () => finish(true)),
        makeButton('취소', () => finish(false)),
      );

      li.append(input, select, due, actions, study);
      queueMicrotask(() => { input.focus(); input.select(); });
      return li;
    }

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = t.done;
    check.setAttribute('aria-label', `${t.text} 완료`);
    check.addEventListener('change', () => toggleTodo(t.id));

    const text = document.createElement('span');
    text.className = 'text';
    text.textContent = t.text;
    text.addEventListener('dblclick', () => startEdit(t.id));

    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'badge';
    badge.textContent = CATEGORIES[t.category];
    badge.title = '클릭하면 카테고리가 바뀝니다';
    badge.addEventListener('click', () => {
      const keys = Object.keys(CATEGORIES);
      const next = keys[(keys.indexOf(t.category) + 1) % keys.length];
      updateTodo(t.id, '', next);
    });

    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(
      makeButton('수정', () => startEdit(t.id)),
      makeButton('삭제', () => deleteTodo(t.id)),
    );

    li.append(check, text);

    if (t.dueDate) {
      const days = daysUntil(t.dueDate);
      const due = document.createElement('button');
      due.type = 'button';
      due.className = 'due';
      let label;
      if (days < 0) label = `D+${-days} 지연`;
      else if (days === 0) label = '오늘 마감';
      else label = `D-${days}`;
      due.textContent = `${t.dueDate.slice(5).replace('-', '/')} · ${label}`;
      if (!t.done && days < 0) due.classList.add('overdue');
      else if (!t.done && days === 0) due.classList.add('today');
      due.title = `마감일 ${t.dueDate} · 클릭하면 달력에서 선택`;
      due.addEventListener('click', () => selectDate(t.dueDate, false));
      li.append(due);
    }

    li.append(badge, actions);

    if (t.category === 'study' && t.amount) {
      li.classList.add('has-study');
      li.append(renderStudy(t));
    }
    return li;
  }

  function numberInput(label, value) {
    const i = document.createElement('input');
    i.type = 'number';
    i.min = '0';
    i.step = 'any';
    i.placeholder = label;
    i.setAttribute('aria-label', label);
    i.value = value ? String(value) : '';
    return i;
  }

  function renderStudy(t) {
    const unit = t.unit || '쪽';
    const studied = t.studied || 0;
    const plan = studyPlan(t);

    const box = document.createElement('div');
    box.className = 'study';

    const amountText = document.createElement('span');
    amountText.className = 'study-amount';
    amountText.textContent = `공부량 ${fmt(studied)} / ${fmt(t.amount)}${unit}`;

    const mini = document.createElement('div');
    mini.className = 'mini-bar';
    const fill = document.createElement('div');
    fill.className = 'mini-fill';
    fill.style.width = percent(studied, t.amount) + '%';
    mini.appendChild(fill);

    box.append(amountText, mini);

    const planEl = document.createElement('span');
    planEl.className = 'study-plan';
    if (plan.kind === 'finished') {
      planEl.textContent = '공부량을 모두 채웠어요';
      planEl.classList.add('achieved');
    } else if (t.done) {
      planEl.textContent = `남은 ${fmt(plan.remaining)}${unit}`;
    } else if (plan.kind === 'nodue') {
      planEl.textContent = '마감일을 정하면 하루 분량을 나눠 드려요';
    } else if (plan.kind === 'overdue') {
      planEl.textContent = `마감이 ${plan.late}일 지났어요 · 남은 ${fmt(plan.remaining)}${unit}`;
      planEl.classList.add('late');
    } else {
      const reached = plan.doneToday >= plan.target;
      planEl.textContent =
        `오늘 목표 ${fmt(plan.target)}${unit} · 오늘 ${fmt(plan.doneToday)}${unit} 완료` +
        ` · 오늘 포함 ${plan.days}일 남음${reached ? ' · 달성' : ''}`;
      if (reached) planEl.classList.add('achieved');
    }
    box.appendChild(planEl);

    const rec = document.createElement('div');
    rec.className = 'study-record';
    if (!t.done && plan.kind !== 'finished') {
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.step = 'any';
      inp.placeholder = `한 양(${unit})`;
      inp.setAttribute('aria-label', '공부한 양 기록');
      const submit = () => {
        const v = parseFloat(inp.value);
        if (Number.isFinite(v) && v !== 0) recordStudy(t.id, v);
      };
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
      });
      rec.append(inp, makeButton('기록', submit));
    }

    const open = expandedTracks.has(t.id);
    const trackBtn = makeButton(open ? '추적 닫기' : '추적', () => {
      if (expandedTracks.has(t.id)) expandedTracks.delete(t.id);
      else expandedTracks.add(t.id);
      render();
    });
    trackBtn.className = 'track-btn';
    trackBtn.setAttribute('aria-expanded', String(open));
    rec.appendChild(trackBtn);
    box.appendChild(rec);

    if (open) box.appendChild(renderTrack(t));
    return box;
  }

  function renderTrack(t) {
    const unit = t.unit || '쪽';
    const rows = trackRows(t);
    const wrap = document.createElement('div');
    wrap.className = 'track';

    if (rows.length === 0) {
      const p = document.createElement('p');
      p.className = 'track-empty';
      p.textContent = '아직 기록이 없어요. 공부한 양을 기록하면 날짜별로 쌓입니다.';
      wrap.appendChild(p);
      return wrap;
    }

    const s = trackSummary(rows);
    const summary = document.createElement('p');
    summary.className = 'track-summary';
    summary.textContent =
      `누적 ${fmt(t.studied || 0)}/${fmt(t.amount)}${unit} · 지난 ${s.days}일 중 ${s.achieved}일 달성 · 연속 ${s.streak}일`;
    wrap.appendChild(summary);

    for (const r of rows) {
      const [, m, d] = r.date.split('-').map(Number);
      const row = document.createElement('div');
      row.className = 'track-row' + (r.isToday ? ' today' : '');

      const date = document.createElement('span');
      date.textContent = `${m}/${d}${r.isToday ? ' (오늘)' : ''}`;

      const target = document.createElement('span');
      target.textContent = r.target === null ? '목표 -' : `목표 ${fmt(r.target)}${unit}`;

      const actual = document.createElement('span');
      actual.textContent = `실제 ${fmt(r.actual)}${unit}`;

      const barWrap = document.createElement('div');
      barWrap.className = 'bar-wrap';
      const fill = document.createElement('div');
      fill.style.width = (r.target ? Math.min(100, percent(r.actual, r.target)) : (r.actual ? 100 : 0)) + '%';
      barWrap.appendChild(fill);

      const status = document.createElement('span');
      status.className = 'status';
      if (r.target === null) {
        status.textContent = r.actual ? '기록' : '-';
      } else if (r.actual >= r.target) {
        status.textContent = '달성';
        status.classList.add('ok');
      } else if (r.isToday) {
        status.textContent = '진행 중';
        status.classList.add('wip');
      } else {
        status.textContent = '미달';
        status.classList.add('miss');
      }

      row.append(date, target, actual, barWrap, status);
      wrap.appendChild(row);
    }
    return wrap;
  }

  function startEdit(id) {
    editingId = id;
    render();
  }

  function renderList() {
    const visible = state.todos.filter((t) =>
      (state.filter === 'all' || t.category === state.filter) &&
      (!selectedDate || t.dueDate === selectedDate || studySpan(t).keys.includes(selectedDate)));

    el.list.textContent = '';
    for (const t of visible) el.list.appendChild(renderItem(t));

    if (visible.length === 0) {
      el.empty.hidden = false;
      el.empty.textContent = state.todos.length === 0
        ? '할 일을 추가해 보세요'
        : selectedDate
          ? '이 날짜에 일정이 없습니다'
          : `${CATEGORIES[state.filter]} 항목이 없습니다`;
    } else {
      el.empty.hidden = true;
    }
  }

  // ---------- 달력 ----------

  function toKey(y, m, d) {
    return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  function todayKey() {
    const n = new Date();
    return toKey(n.getFullYear(), n.getMonth(), n.getDate());
  }

  function selectDate(key, focusCell) {
    if (selectedDate === key) {
      selectedDate = null;
      if (el.due.value === key) el.due.value = '';
    } else {
      selectedDate = key;
      el.due.value = key;
      const [y, m] = key.split('-').map(Number);
      view = { y, m: m - 1 };
    }
    render();
    if (focusCell) {
      const cell = el.calGrid.querySelector(`[data-key="${key}"]`);
      if (cell) cell.focus();
    }
  }

  function moveMonth(delta) {
    const d = new Date(view.y, view.m + delta, 1);
    view = { y: d.getFullYear(), m: d.getMonth() };
    renderCalendar();
  }

  function renderCalendar() {
    el.calTitle.textContent = `${view.y}년 ${view.m + 1}월`;
    el.calGrid.textContent = '';

    for (const w of WEEKDAYS) {
      const h = document.createElement('div');
      h.className = 'cal-wd';
      h.textContent = w;
      el.calGrid.appendChild(h);
    }

    const startDay = new Date(view.y, view.m, 1).getDay();
    const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
    const rows = Math.ceil((startDay + daysInMonth) / 7);
    const today = todayKey();

    const byDate = new Map();
    for (const t of state.todos) {
      if (!t.dueDate) continue;
      if (!byDate.has(t.dueDate)) byDate.set(t.dueDate, []);
      byDate.get(t.dueDate).push(t);
    }

    // 공부량: 오늘부터 마감일 전날까지 매일 같은 목표 분량이 이어진다 (마감일에는 마감 칩에 합친다)
    const quotaByDate = new Map();
    for (const t of state.todos) {
      const sp = studySpan(t);
      for (const k of sp.keys.slice(0, -1)) {
        if (!quotaByDate.has(k)) quotaByDate.set(k, []);
        quotaByDate.get(k).push({ t, plan: sp.plan });
      }
    }

    for (let i = 0; i < rows * 7; i++) {
      const d = new Date(view.y, view.m, 1 - startDay + i);
      const key = toKey(d.getFullYear(), d.getMonth(), d.getDate());
      const items = byDate.get(key) || [];
      const quota = quotaByDate.get(key) || [];
      const doneCount = items.filter((t) => t.done).length;

      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cal-day';
      cell.dataset.key = key;
      if (d.getMonth() !== view.m) cell.classList.add('other');
      if (key === today) cell.classList.add('today');
      if (key === selectedDate) cell.classList.add('selected');
      if (key < today && items.some((t) => !t.done)) cell.classList.add('overdue');
      cell.setAttribute('aria-pressed', String(key === selectedDate));
      const quotaNote = quota.length ? `, 공부 목표 ${quota.length}개` : '';
      cell.setAttribute('aria-label', items.length
        ? `${d.getMonth() + 1}월 ${d.getDate()}일, 마감 ${items.length}개 중 ${doneCount}개 완료${quotaNote}`
        : `${d.getMonth() + 1}월 ${d.getDate()}일${quotaNote}`);
      if (items.length || quota.length) {
        cell.title = [
          items.length ? `마감 ${items.length}개 (완료 ${doneCount})` : '',
          quota.length ? `공부 목표 ${quota.length}개` : '',
        ].filter(Boolean).join(' · ');
      }

      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = String(d.getDate());
      cell.appendChild(num);

      if (items.length || quota.length) {
        const dots = document.createElement('span');
        dots.className = 'dots';
        for (const cat of Object.keys(CATEGORIES)) {
          const inCat = items.filter((t) => t.category === cat);
          if (!inCat.length) continue;
          const dot = document.createElement('span');
          dot.className = `dot cat-${cat}`;
          if (inCat.every((t) => t.done)) dot.classList.add('dim');
          dots.appendChild(dot);
        }
        if (quota.length && !items.some((t) => t.category === 'study')) {
          const dot = document.createElement('span');
          dot.className = 'dot cat-study quota';
          dots.appendChild(dot);
        }
        cell.appendChild(dots);
      }

      // 넓은 화면에서는 점 대신 제목을 칩으로 보여준다 (CSS로 전환)
      const entries = [];
      for (const t of items) {
        const sp = studySpan(t);
        const label = sp.plan ? `${t.text} · ${fmt(sp.plan.target)}${t.unit || '쪽'}` : t.text;
        entries.push({ t, label, title: label, quota: false });
      }
      for (const q of quota) {
        const amountText = `${fmt(q.plan.target)}${q.t.unit || '쪽'}`;
        entries.push({
          t: q.t,
          label: `${q.t.text} ${amountText}`,
          title: `${q.t.text}: 하루 ${amountText}`,
          quota: true,
        });
      }
      if (entries.length) {
        const chips = document.createElement('span');
        chips.className = 'chips';
        for (const e of entries.slice(0, MAX_CHIPS)) {
          const chip = document.createElement('span');
          chip.className = `chip cat-${e.t.category}${e.t.done ? ' done' : ''}${e.quota ? ' quota' : ''}`;
          chip.textContent = e.label;
          chip.title = e.title;
          chips.appendChild(chip);
        }
        if (entries.length > MAX_CHIPS) {
          const more = document.createElement('span');
          more.className = 'chip-more';
          more.textContent = `+${entries.length - MAX_CHIPS}개 더`;
          chips.appendChild(more);
        }
        cell.appendChild(chips);
      }

      cell.addEventListener('click', () => selectDate(key, true));
      el.calGrid.appendChild(cell);
    }
  }

  function renderDateFilter() {
    if (!selectedDate) {
      el.dateFilter.hidden = true;
      return;
    }
    const [, m, d] = selectedDate.split('-').map(Number);
    el.dateFilterText.textContent = `${m}월 ${d}일 일정(마감·공부 목표)만 보는 중`;
    el.dateFilter.hidden = false;
  }

  function render() {
    ensureStudyDays();
    renderDashboard();
    renderFilters();
    renderDateFilter();
    renderList();
    renderCalendar();
  }

  // ---------- 이벤트 ----------

  el.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = el.text.value.trim();
    if (!text) return;
    addTodo(text, el.category.value, el.due.value, {
      amount: el.amount.value,
      unit: el.unit.value,
      studied: 0,
    });
    el.text.value = '';
    el.due.value = '';
    el.amount.value = '';
    el.text.focus();
  });

  el.category.addEventListener('change', () => {
    el.study.hidden = el.category.value !== 'study';
  });
  el.calPrev.addEventListener('click', () => moveMonth(-1));
  el.calNext.addEventListener('click', () => moveMonth(1));
  el.calToday.addEventListener('click', () => {
    const n = new Date();
    view = { y: n.getFullYear(), m: n.getMonth() };
    renderCalendar();
  });
  el.dateFilterClear.addEventListener('click', () => selectDate(selectedDate, false));

  // ---------- 시작 ----------

  el.today.textContent = new Date().toLocaleDateString('ko-KR', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long',
  });
  load();
  render();
})();
