(() => {
  'use strict';

  const KEY = 'todo-app:v1';
  const BACKUP_KEY = 'todo-app:backup';
  const MAX_LEN = 100;
  const UNDO_MS = 5000;
  const CATEGORIES = { work: '업무', personal: '개인', study: '공부' };

  let state = { version: 1, filter: 'all', todos: [] };
  let editingId = null;
  let undo = null; // { todo, index, timer }
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
    filters: $('filters'),
    list: $('list'),
    empty: $('empty'),
    toast: $('toast'),
    toastMsg: $('toast-msg'),
    toastUndo: $('toast-undo'),
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
      (t.dueDate === undefined || t.dueDate === null || DATE_RE.test(t.dueDate));
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

  function addTodo(text, category, dueDate) {
    state.todos.push({
      id: newId(),
      text,
      category,
      dueDate: dueDate || null,
      done: false,
      createdAt: Date.now(),
      completedAt: null,
    });
    commit();
  }

  function toggleTodo(id) {
    const t = state.todos.find((x) => x.id === id);
    if (!t) return;
    t.done = !t.done;
    t.completedAt = t.done ? Date.now() : null;
    commit();
  }

  // dueDate: undefined면 그대로 두고, ''이면 마감일 제거
  function updateTodo(id, text, category, dueDate) {
    const t = state.todos.find((x) => x.id === id);
    if (!t) return;
    if (text) t.text = text;
    if (category in CATEGORIES) t.category = category;
    if (dueDate !== undefined) t.dueDate = DATE_RE.test(dueDate) ? dueDate : null;
    commit();
  }

  function deleteTodo(id) {
    const index = state.todos.findIndex((x) => x.id === id);
    if (index < 0) return;
    const [todo] = state.todos.splice(index, 1);
    if (editingId === id) editingId = null;
    clearUndo();
    undo = { todo, index, timer: setTimeout(hideToast, UNDO_MS) };
    commit();
    showToast(`"${truncate(todo.text, 20)}" 삭제됨`);
  }

  function restoreDeleted() {
    if (!undo) return;
    const { todo, index } = undo;
    clearUndo();
    hideToast();
    state.todos.splice(Math.min(index, state.todos.length), 0, todo);
    commit();
  }

  function setFilter(filter) {
    state.filter = filter;
    commit();
  }

  // ---------- 토스트 ----------

  function truncate(s, n) {
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function showToast(msg) {
    el.toastMsg.textContent = msg;
    el.toast.hidden = false;
  }

  function hideToast() {
    el.toast.hidden = true;
    if (undo) { clearTimeout(undo.timer); undo = null; }
  }

  function clearUndo() {
    if (undo) { clearTimeout(undo.timer); undo = null; }
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

      const finish = (saveIt) => {
        if (editingId !== t.id) return;
        editingId = null;
        if (saveIt) {
          updateTodo(t.id, input.value.trim(), select.value, due.value);
        } else {
          render();
        }
      };

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      for (const field of [select, due]) {
        field.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') { e.preventDefault(); finish(false); }
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

      li.append(input, select, due, actions);
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
    return li;
  }

  function startEdit(id) {
    editingId = id;
    render();
  }

  function renderList() {
    const visible = state.todos.filter((t) =>
      (state.filter === 'all' || t.category === state.filter) &&
      (!selectedDate || t.dueDate === selectedDate));

    el.list.textContent = '';
    for (const t of visible) el.list.appendChild(renderItem(t));

    if (visible.length === 0) {
      el.empty.hidden = false;
      el.empty.textContent = state.todos.length === 0
        ? '할 일을 추가해 보세요'
        : selectedDate
          ? '이 날짜에 마감인 항목이 없습니다'
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

    for (let i = 0; i < rows * 7; i++) {
      const d = new Date(view.y, view.m, 1 - startDay + i);
      const key = toKey(d.getFullYear(), d.getMonth(), d.getDate());
      const items = byDate.get(key) || [];
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
      cell.setAttribute('aria-label', items.length
        ? `${d.getMonth() + 1}월 ${d.getDate()}일, 마감 ${items.length}개 중 ${doneCount}개 완료`
        : `${d.getMonth() + 1}월 ${d.getDate()}일`);
      if (items.length) cell.title = `마감 ${items.length}개 (완료 ${doneCount})`;

      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = String(d.getDate());
      cell.appendChild(num);

      if (items.length) {
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
        cell.appendChild(dots);
      }

      // 넓은 화면에서는 점 대신 할 일 제목을 칩으로 보여준다 (CSS로 전환)
      if (items.length) {
        const chips = document.createElement('span');
        chips.className = 'chips';
        for (const t of items.slice(0, MAX_CHIPS)) {
          const chip = document.createElement('span');
          chip.className = `chip cat-${t.category}${t.done ? ' done' : ''}`;
          chip.textContent = t.text;
          chip.title = t.text;
          chips.appendChild(chip);
        }
        if (items.length > MAX_CHIPS) {
          const more = document.createElement('span');
          more.className = 'chip-more';
          more.textContent = `+${items.length - MAX_CHIPS}개 더`;
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
    el.dateFilterText.textContent = `${m}월 ${d}일 마감 항목만 보는 중`;
    el.dateFilter.hidden = false;
  }

  function render() {
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
    addTodo(text, el.category.value, el.due.value);
    el.text.value = '';
    el.due.value = '';
    el.text.focus();
  });

  el.toastUndo.addEventListener('click', restoreDeleted);
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
