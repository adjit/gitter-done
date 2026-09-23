const fs = require('fs');
const { execFileSync } = require('child_process');
const { parseGitOrg } = require('./parseOrg');

const COMMIT_ACCEPT = 'application/vnd.github.cloak-preview+json';
const TZ = process.env.GIT_TZ || 'America/New_York';

const PR_COMMITS_QUERY = `
query($q: String!, $after: String) {
  search(query: $q, type: ISSUE, first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        commits(first: 100) {
          nodes {
            commit {
              oid
              authoredDate
              committedDate
              author { name email user { login } }
            }
          }
        }
      }
    }
  }
}
`;

const REFS_QUERY = `
query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    refs(refPrefix: "refs/heads/", first: 50, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        target { ... on Commit { committedDate } }
      }
    }
  }
}
`;

function ymdInZone(date, tz = TZ) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function hourInZone(date, tz = TZ) {
  return Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      hourCycle: 'h23',
    }).format(date)
  );
}

function addUtcDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function overlappingUtcDates(estYmd) {
  return [addUtcDays(estYmd, -1), estYmd, addUtcDays(estYmd, 1)];
}

function listEstDays(endYmd, count) {
  const days = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    days.push(addUtcDays(endYmd, -i));
  }
  return days;
}

function clampDays(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  return Math.min(30, Math.max(1, Math.round(n)));
}

function commitEstDay(item) {
  const iso = item.commit?.author?.date || item.commit?.committer?.date;
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return ymdInZone(d);
}

function inEstRange(iso, startYmd, endYmd) {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const ymd = ymdInZone(d);
  return ymd >= startYmd && ymd <= endYmd;
}

function startOfDayUtc(ymd, tz = TZ) {
  const [y, m, d] = ymd.split('-').map(Number);
  for (let h = 2; h <= 7; h += 1) {
    const guess = new Date(Date.UTC(y, m - 1, d, h, 0, 0));
    if (ymdInZone(guess, tz) === ymd && hourInZone(guess, tz) === 0) {
      return guess;
    }
  }
  return new Date(Date.UTC(y, m - 1, d, 4, 0, 0));
}

function inEstDay(iso, todayEst) {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return ymdInZone(d) === todayEst;
}

function getToken(host) {
  const envToken =
    process.env.GH_TOKEN ||
    process.env.GITHUB_TOKEN ||
    process.env.GH_ENTERPRISE_TOKEN;
  if (envToken) return envToken.trim();

  try {
    const ghBin =
      process.platform === 'win32' &&
      fs.existsSync('C:\\Program Files\\GitHub CLI\\gh.exe')
        ? 'C:\\Program Files\\GitHub CLI\\gh.exe'
        : 'gh';
    const out = execFileSync(ghBin, ['auth', 'token', '--hostname', host], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    });
    const token = out.trim();
    if (!token) throw new Error('empty token');
    return token;
  } catch {
    throw new Error(
      `No token for ${host}. Run: gh auth login --hostname ${host}`
    );
  }
}

async function api(host, token, apiPath, accept) {
  const url = `https://${host}/api/v3/${apiPath}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: accept || 'application/vnd.github+json',
      'User-Agent': 'gitter-done',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${apiPath}: ${text.slice(0, 240)}`);
  }
  return res.json();
}

async function graphql(host, token, query, variables) {
  const res = await fetch(`https://${host}/api/graphql`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'gitter-done',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) {
    const msg = json.errors?.[0]?.message || `${res.status} graphql`;
    throw new Error(msg);
  }
  return json.data;
}

async function searchPages(host, token, path, accept) {
  const items = [];
  for (let page = 1; page <= 10; page += 1) {
    const sep = path.includes('?') ? '&' : '?';
    const data = await api(
      host,
      token,
      `${path}${sep}per_page=100&page=${page}`,
      accept
    );
    const batch = data.items || [];
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

async function searchRange(host, token, pathPrefix, query, accept) {
  return searchPages(
    host,
    token,
    `${pathPrefix}?q=${encodeURIComponent(query)}`,
    accept
  );
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i]);
    }
  }
  const n = Math.min(limit, Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

function isBot(login, name) {
  const l = String(login || '').toLowerCase();
  const n = String(name || '').toLowerCase();
  if (!l && !n) return true;
  return (
    l.includes('[bot]') ||
    l.endsWith('-bot') ||
    l === 'dependabot' ||
    l.startsWith('gha@') ||
    l.includes('github-actions') ||
    n.includes('github action') ||
    l === 'grafana' ||
    n === 'grafana'
  );
}

function displayHandle(login, name) {
  if (login && !String(login).includes('@')) return login;
  if (
    name &&
    !String(name).includes('@') &&
    !String(name).toLowerCase().includes('github action')
  ) {
    return name;
  }
  if (login && String(login).includes('@')) return String(login).split('@')[0];
  return login || name;
}

function resolveKey(map, login, name) {
  const handle = String(displayHandle(login, name) || '').toLowerCase();
  const isEmail = String(login || '').includes('@');
  if (!isEmail) {
    const loginKey = String(login).toLowerCase();
    for (const [existingKey, person] of map) {
      if (
        existingKey.includes('@') &&
        String(person.handle).toLowerCase() === loginKey
      ) {
        person.login = login;
        map.set(loginKey, person);
        map.delete(existingKey);
        return loginKey;
      }
    }
    return loginKey;
  }
  for (const [existingKey, person] of map) {
    if (
      existingKey === handle ||
      String(person.handle).toLowerCase() === handle ||
      String(person.login).toLowerCase() === handle
    ) {
      return existingKey;
    }
  }
  return String(login).toLowerCase();
}

function addPerson(map, { login, name, avatar, commits, prs }) {
  if (!login || isBot(login, name)) return;
  const key = resolveKey(map, login, name);
  const handle = displayHandle(login, name);
  const prev = map.get(key) || {
    login,
    handle,
    name: name || login,
    avatar: avatar || '',
    commits: 0,
    prs: 0,
  };
  prev.commits += commits || 0;
  prev.prs += prs || 0;
  if (name) prev.name = name;
  if (avatar) prev.avatar = avatar;
  if (login && !String(login).includes('@')) prev.login = login;
  prev.handle = displayHandle(prev.login, prev.name);
  map.set(key, prev);
}

function ingestRestCommit(bySha, item) {
  const sha = item.sha;
  if (!sha || bySha.has(sha)) return;
  bySha.set(sha, item);
}

function ingestGraphqlCommit(bySha, commit) {
  const sha = commit?.oid;
  if (!sha || bySha.has(sha)) return;
  bySha.set(sha, {
    sha,
    author: commit.author?.user || null,
    commit: {
      author: {
        name: commit.author?.name || commit.author?.email,
        email: commit.author?.email,
        date: commit.authoredDate,
      },
      committer: { date: commit.committedDate },
    },
  });
}

async function fetchPrCommits(host, token, org, from, to) {
  const bySha = new Map();
  let after = null;
  for (let page = 0; page < 10; page += 1) {
    const data = await graphql(host, token, PR_COMMITS_QUERY, {
      q: `org:${org} type:pr updated:${from}..${to}`,
      after,
    });
    const search = data.search;
    for (const node of search.nodes || []) {
      for (const edge of node.commits?.nodes || []) {
        ingestGraphqlCommit(bySha, edge.commit);
      }
    }
    if (!search.pageInfo?.hasNextPage) break;
    after = search.pageInfo.endCursor;
  }
  return bySha;
}

async function listRepoCommitsSince(host, token, fullName, sinceIso, sha, maxPages = 5) {
  const items = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const path =
      `repos/${fullName}/commits?since=${encodeURIComponent(sinceIso)}` +
      `&per_page=100&page=${page}&sha=${encodeURIComponent(sha)}`;
    let batch;
    try {
      batch = await api(host, token, path);
    } catch (err) {
      if (String(err.message).startsWith('404')) break;
      throw err;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

async function recentBranchNames(host, token, repo, sinceIso) {
  const names = [];
  const [owner, name] = repo.full_name.split('/');
  let after = null;
  for (let page = 0; page < 6; page += 1) {
    let data;
    try {
      data = await graphql(host, token, REFS_QUERY, {
        owner,
        name,
        after,
      });
    } catch {
      break;
    }
    const refs = data.repository?.refs;
    if (!refs) break;
    for (const node of refs.nodes || []) {
      if (!node?.name || !node.target?.committedDate) continue;
      if (new Date(node.target.committedDate) >= new Date(sinceIso)) {
        names.push(node.name);
      }
    }
    if (!refs.pageInfo?.hasNextPage) break;
    after = refs.pageInfo.endCursor;
  }
  return names;
}

async function fetchHotRepoCommits(host, token, org, sinceIso, maxPages = 5) {
  const repos = [];
  for (let page = 1; page <= 4; page += 1) {
    const batch = await api(
      host,
      token,
      `orgs/${encodeURIComponent(org)}/repos?sort=pushed&direction=desc&per_page=100&page=${page}`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    let older = false;
    for (const repo of batch) {
      if (new Date(repo.pushed_at) >= new Date(sinceIso)) repos.push(repo);
      else {
        older = true;
        break;
      }
    }
    if (older || batch.length < 100) break;
  }

  const bySha = new Map();
  await mapPool(repos, 5, async (repo) => {
    const branches = new Set([repo.default_branch || 'main']);
    if (repo.default_branch !== 'develop') branches.add('develop');
    const hottest = repos.slice(0, 5);
    if (hottest.includes(repo)) {
      const extra = await recentBranchNames(host, token, repo, sinceIso);
      for (const name of extra) branches.add(name);
    }
    for (const sha of branches) {
      const batch = await listRepoCommitsSince(
        host,
        token,
        repo.full_name,
        sinceIso,
        sha,
        maxPages
      );
      for (const item of batch) ingestRestCommit(bySha, item);
    }
  });
  return bySha;
}

async function fetchBoard({ gitOrg, now, days } = {}) {
  const { host, org } = parseGitOrg(
    gitOrg || process.env.GIT_ORG,
    process.env.GH_HOST
  );
  const token = getToken(host);
  const dayCount = clampDays(days);
  const todayEst = ymdInZone(now || new Date());
  const startEst = addUtcDays(todayEst, 1 - dayCount);
  const from = overlappingUtcDates(startEst)[0];
  const to = overlappingUtcDates(todayEst)[2];
  const sinceIso = startOfDayUtc(startEst).toISOString();
  const commitPages = dayCount > 1 ? 10 : 5;

  const [user, byCommitter, byAuthor, prsRaw, prCommits, hotCommits] =
    await Promise.all([
      api(host, token, 'user'),
      searchRange(
        host,
        token,
        'search/commits',
        `org:${org} committer-date:${from}..${to}`,
        COMMIT_ACCEPT
      ),
      searchRange(
        host,
        token,
        'search/commits',
        `org:${org} author-date:${from}..${to}`,
        COMMIT_ACCEPT
      ),
      searchRange(
        host,
        token,
        'search/issues',
        `org:${org} type:pr created:${from}..${to}`
      ),
      fetchPrCommits(host, token, org, from, to),
      fetchHotRepoCommits(host, token, org, sinceIso, commitPages),
    ]);

  const commitsBySha = new Map();
  for (const item of [...byCommitter, ...byAuthor]) {
    ingestRestCommit(commitsBySha, item);
  }
  for (const [sha, item] of prCommits) ingestRestCommit(commitsBySha, item);
  for (const [sha, item] of hotCommits) ingestRestCommit(commitsBySha, item);

  const commits = [...commitsBySha.values()].filter((item) => {
    const authorDate = item.commit?.author?.date;
    const committerDate = item.commit?.committer?.date;
    return (
      inEstRange(authorDate, startEst, todayEst) ||
      inEstRange(committerDate, startEst, todayEst)
    );
  });

  const prs = prsRaw.filter(
    (item) =>
      item.pull_request && inEstRange(item.created_at, startEst, todayEst)
  );

  const map = new Map();
  for (const item of commits) {
    const login =
      item.author?.login ||
      item.commit?.author?.email ||
      item.commit?.author?.name;
    addPerson(map, {
      login,
      name: item.commit?.author?.name || login,
      avatar: item.author?.avatar_url || '',
      commits: 1,
    });
  }
  for (const item of prs) {
    addPerson(map, {
      login: item.user?.login,
      name: item.user?.login,
      avatar: item.user?.avatar_url || '',
      prs: 1,
    });
  }

  const people = [...map.values()]
    .sort((a, b) => {
      if (b.commits !== a.commits) return b.commits - a.commits;
      if (b.prs !== a.prs) return b.prs - a.prs;
      return String(a.handle || a.login).localeCompare(
        String(b.handle || b.login)
      );
    })
    .map((person, i) => ({ ...person, rank: i + 1 }));

  const youLogin = String(user.login || '').toLowerCase();
  const youIndex = people.findIndex(
    (p) => String(p.login).toLowerCase() === youLogin
  );
  const you =
    youIndex >= 0
      ? { ...people[youIndex] }
      : {
          login: user.login,
          handle: user.login,
          name: user.name || user.login,
          avatar: user.avatar_url || '',
          commits: 0,
          prs: 0,
          rank: people.length + 1,
        };

  const top = people.slice(0, 3);
  const third = people[2];
  const gapToPodium =
    you.rank <= 3 ? 0 : Math.max(0, (third ? third.commits : 0) - you.commits);

  const dayList = listEstDays(todayEst, dayCount);
  const buckets = new Map(
    dayList.map((date) => [date, { date, commits: 0, you: 0 }])
  );
  for (const item of commits) {
    const day = commitEstDay(item);
    const bucket = day && buckets.get(day);
    if (!bucket) continue;
    bucket.commits += 1;
    const login = String(
      item.author?.login ||
        item.commit?.author?.email ||
        item.commit?.author?.name ||
        ''
    ).toLowerCase();
    if (login && login === youLogin) bucket.you += 1;
  }

  return {
    host,
    org,
    tz: TZ,
    days: dayCount,
    start: startEst,
    date: todayEst,
    you,
    top,
    people,
    peopleCount: people.length,
    commitCount: commits.length,
    prCount: prs.length,
    series: dayList.map((date) => buckets.get(date)),
    gapToPodium,
    onPodium: you.rank <= 3,
    updatedAt: new Date().toISOString(),
  };
}

module.exports = { fetchBoard, parseGitOrg, ymdInZone, clampDays };
