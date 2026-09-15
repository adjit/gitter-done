const shellEl = document.getElementById('shell');
const clockEl = document.getElementById('clock');
const metaEl = document.getElementById('meta');
const boardEl = document.getElementById('board');
const youWrap = document.getElementById('youWrap');
const youRow = document.getElementById('youRow');
const gapEl = document.getElementById('gap');
const statusEl = document.getElementById('status');

let expanded = false;
let lastState = null;

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

metaEl.addEventListener('click', (event) => {
  event.stopPropagation();
  toggleOpen();
});
boardEl.addEventListener('click', () => toggleOpen());
youWrap.addEventListener('click', () => toggleOpen());

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

function fitWindow() {
  requestAnimationFrame(() => {
    const rect = shellEl.getBoundingClientRect();
    window.gitter.resize(Math.ceil(rect.height + 8));
  });
}

function render(state) {
  lastState = state;
  const { loading, error, board } = state || {};
  clockEl.textContent = formatClock(board?.updatedAt);

  if (loading && !board) {
    shellEl.classList.remove('is-open');
    metaEl.textContent = 'listening for commits';
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

  const rows = expanded ? board.people || board.top : board.top;
  boardEl.innerHTML = rows
    .map((person) => rowHtml(person, isYou(person) ? 'is-you' : ''))
    .join('');

  const more = Math.max(0, (board.peopleCount || 0) - 3);
  if (expanded) {
    metaEl.textContent = `${board.org} · ${formatDate(board.date)} est · ${board.peopleCount} · close`;
  } else {
    metaEl.textContent = `${board.org} · ${formatDate(board.date)} est · ${board.commitCount} · ${more} more`;
  }

  const showYou = !expanded && !board.onPodium;
  youWrap.hidden = !showYou;
  if (showYou) {
    youRow.innerHTML = rowHtml(board.you, 'is-you');
    if (board.you.commits === 0) {
      gapEl.textContent = 'no commits yet today';
    } else if (board.gapToPodium > 0) {
      gapEl.textContent = `${board.gapToPodium} behind 3rd`;
    } else {
      gapEl.textContent = 'tied with the podium';
    }
  }

  statusEl.classList.toggle('is-error', Boolean(error));
  statusEl.textContent = error || (loading ? 'refreshing' : '');
  statusEl.hidden = !statusEl.textContent;
  fitWindow();
}

window.gitter.onState(render);
window.gitter.getState().then(render);
