const shellEl = document.getElementById('shell');
const clockEl = document.getElementById('clock');
const metaEl = document.getElementById('meta');
const rangeLabel = document.getElementById('rangeLabel');
const chartEl = document.getElementById('chart');
const boardEl = document.getElementById('board');
const youWrap = document.getElementById('youWrap');
const youRow = document.getElementById('youRow');
const gapEl = document.getElementById('gap');
const statusEl = document.getElementById('status');

const STEPS = [1, 7, 14, 30];

let expanded = false;
let lastState = null;
let days = 1;

document.getElementById('refresh').addEventListener('click', (event) => {
  event.stopPropagation();
  statusEl.hidden = false;
  statusEl.textContent = 'refreshing';
  window.gitter.refresh();
});
document.getElementById('quit').addEventListener('click', (event) => {
  event.stopPropagation();
  window.gitter.quit();
});
document.getElementById('rangeUp').addEventListener('click', (event) => {
  event.stopPropagation();
  shiftDays(1);
});
document.getElementById('rangeDown').addEventListener('click', (event) => {
  event.stopPropagation();
  shiftDays(-1);
});

metaEl.addEventListener('click', (event) => {
  event.stopPropagation();
  toggleOpen();
});
boardEl.addEventListener('click', () => toggleOpen());
youWrap.addEventListener('click', () => toggleOpen());

function shiftDays(dir) {
  const idx = STEPS.indexOf(days);
  const at = idx >= 0 ? idx : 0;
  const next = STEPS[Math.min(STEPS.length - 1, Math.max(0, at + dir))];
  if (next === days) return;
  days = next;
  rangeLabel.textContent = `${days}d`;
  statusEl.hidden = false;
  statusEl.textContent = 'loading';
  window.gitter.setDays(days);
}

function toggleOpen() {
  if (!lastState?.board) return;
  expanded = !expanded;
  render(lastState);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function formatClock(iso) {
  const d = iso ? new Date(iso) : new Date();
  return d
    .toLocaleTimeString([], {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: '2-digit',
    })
    .toLowerCase();
}

function formatDate(isoDate) {
  if (!isoDate) return '';
  const d = new Date(`${isoDate}T12:00:00`);
  return d
    .toLocaleDateString([], {
      timeZone: 'America/New_York',
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    })
    .toLowerCase();
}

function weekday(isoDate) {
  if (!isoDate) return '';
  return new Date(`${isoDate}T12:00:00`)
    .toLocaleDateString([], { timeZone: 'America/New_York', weekday: 'short' })
    .toLowerCase();
}

function rowHtml(person, extraClass = '') {
  const podium = person.rank <= 3 ? `p${person.rank}` : '';
  return `
    <div class="row ${podium} ${extraClass}">
      <span class="rank">${person.rank}</span>
      <span class="name">${escapeHtml(person.handle || person.login)}</span>
      <span class="count">${person.commits}</span>
    </div>
  `;
}

function renderChart(board) {
  const series = board.series || [];
  const show = (board.days || 1) > 1 && series.length > 1;
  chartEl.hidden = !show;
  if (!show) {
    chartEl.innerHTML = '';
    return;
  }
  const max = Math.max(...series.map((d) => d.commits), 1);
  chartEl.innerHTML = series
    .map((day) => {
      const orgH = day.commits / max;
      const youH = day.commits ? day.you / day.commits : 0;
      const today = day.date === board.date ? 'is-today' : '';
      const title = `${weekday(day.date)} ${day.date.slice(5)} · ${day.commits}${
        day.you ? ` · you ${day.you}` : ''
      }`;
      return `<div class="bar ${today}" style="--h:${orgH}" title="${escapeHtml(title)}"><span class="you" style="--h:${youH}"></span></div>`;
    })
    .join('');
}

function fitWindow() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const rect = shellEl.getBoundingClientRect();
      window.gitter.resize(Math.ceil(rect.height + 8));
    });
  });
}

function render(state) {
  lastState = state;
  const { loading, error, board } = state || {};
  if (state?.days) days = state.days;
  window.__gitterDays = board?.days || days;
  rangeLabel.textContent = `${days}d`;
  document.getElementById('rangeDown').disabled = days <= STEPS[0];
  document.getElementById('rangeUp').disabled = days >= STEPS[STEPS.length - 1];
  clockEl.textContent = formatClock(board?.updatedAt);

  if (loading && !board) {
    shellEl.classList.remove('is-open');
    metaEl.textContent = 'listening for commits';
    chartEl.hidden = true;
    boardEl.innerHTML = '';
    youWrap.hidden = true;
    statusEl.classList.remove('is-error');
    statusEl.textContent = '';
    statusEl.hidden = true;
    fitWindow();
    return;
  }

  if (error && !board) {
    shellEl.classList.remove('is-open');
    metaEl.textContent = 'set GIT_ORG and gh auth';
    chartEl.hidden = true;
    boardEl.innerHTML = '';
    youWrap.hidden = true;
    statusEl.classList.add('is-error');
    statusEl.textContent = error;
    statusEl.hidden = false;
    fitWindow();
    return;
  }

  const youLogin = String(board.you.login || '').toLowerCase();
  const isYou = (person) =>
    String(person.login).toLowerCase() === youLogin;

  shellEl.classList.toggle('is-open', expanded);
  renderChart(board);

  const rows = expanded ? board.people || board.top : board.top;
  boardEl.innerHTML = rows
    .map((person) => rowHtml(person, isYou(person) ? 'is-you' : ''))
    .join('');

  if (expanded) {
    metaEl.textContent = `${board.org} · ${board.peopleCount} · close`;
  } else if ((board.days || 1) > 1) {
    metaEl.textContent = `${board.org} · ${board.commitCount}`;
  } else {
    metaEl.textContent = `${board.org} · ${formatDate(board.date)} · ${board.commitCount}`;
  }

  const showYou = !expanded && !board.onPodium;
  youWrap.hidden = !showYou;
  if (showYou) {
    youRow.innerHTML = rowHtml(board.you, 'is-you');
    if (board.you.commits === 0) {
      gapEl.textContent = 'no commits in this window';
    } else if (board.gapToPodium > 0) {
      gapEl.textContent = `${board.gapToPodium} behind 3rd`;
    } else {
      gapEl.textContent = 'tied with the podium';
    }
  }

  statusEl.classList.toggle('is-error', Boolean(error));
  const stale = board.days && board.days !== days;
  statusEl.textContent = error || (loading || stale ? 'loading' : '');
  statusEl.hidden = !statusEl.textContent;
  fitWindow();
}

window.gitter.onState(render);
window.gitter.getState().then(render);
