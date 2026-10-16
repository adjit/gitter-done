const fs = require('fs');
const os = require('os');
const path = require('path');

function defaultStatsCachePath() {
  return (
    process.env.GITTER_STATS_CACHE ||
    path.join(os.homedir(), '.gitter-done', 'commit-stats.json')
  );
}

function emptyCache() {
  return { version: 1, stats: {}, people: {} };
}

function loadStatsCache(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object') return emptyCache();
    return {
      version: 1,
      stats: data.stats && typeof data.stats === 'object' ? data.stats : {},
      people: data.people && typeof data.people === 'object' ? data.people : {},
      org: data.org,
      date: data.date,
    };
  } catch {
    return emptyCache();
  }
}

function saveStatsCache(file, cache) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cache)}\n`);
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.copyFileSync(tmp, file);
    fs.unlinkSync(tmp);
  }
}

function repoFromCommit(item) {
  if (item?.repository?.full_name) return item.repository.full_name;
  if (item?.repo) return item.repo;
  const api = String(item?.url || '').match(
    /\/repos\/([^/]+\/[^/]+)\/commits\//
  );
  if (api) return api[1];
  const html = String(item?.html_url || '').match(
    /[/:]([^/]+\/[^/]+)\/commit[s]?\//
  );
  if (html) return html[1];
  return null;
}

function fingerprint(shas) {
  return [...shas].sort().join(' ');
}

function isMergeCommit(item) {
  return Array.isArray(item?.parents) && item.parents.length > 1;
}

function personCacheKey(todayEst, login) {
  return `${todayEst}:${String(login || '').toLowerCase()}`;
}

function sumCachedStats(entries, stats) {
  let additions = 0;
  let deletions = 0;
  let maxDate = '';
  let hit = 0;
  for (const entry of entries) {
    const st = stats[entry.sha];
    if (!st) continue;
    hit += 1;
    additions += Number(st.additions) || 0;
    deletions += Number(st.deletions) || 0;
    if (entry.date && entry.date > maxDate) maxDate = entry.date;
  }
  return { additions, deletions, maxDate, hit };
}

function planLineFetches(entries, prev, stats) {
  const shas = entries.map((e) => e.sha);
  const fp = fingerprint(shas);
  if (prev && prev.fp === fp) {
    return { fp, shas, fetch: [], skip: true };
  }

  const prevShas = new Set(prev?.shas || []);
  const lastMax = prev?.maxDate || '';
  const fetch = [];
  const merges = [];

  for (const entry of entries) {
    if (!entry?.sha) continue;
    if (stats[entry.sha]) continue;
    if (entry.merge) {
      merges.push(entry);
      continue;
    }
    if (!entry.repo) continue;
    if (!prev) {
      fetch.push(entry);
      continue;
    }
    const newer = Boolean(lastMax && entry.date && entry.date > lastMax);
    const unknown = !prevShas.has(entry.sha);
    if (newer || unknown) fetch.push(entry);
  }

  return { fp, shas, fetch, merges, skip: false, lastMax };
}

function visiblePeople(people, youLogin) {
  const out = [];
  const seen = new Set();
  for (const person of people.slice(0, 3)) {
    const key = String(person.login || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(person);
  }
  const youKey = String(youLogin || '').toLowerCase();
  if (youKey && !seen.has(youKey)) {
    const you = people.find(
      (p) => String(p.login || '').toLowerCase() === youKey
    );
    if (you) out.push(you);
  }
  return out;
}

function prunePersonKeys(cache, todayEst) {
  const prefix = `${todayEst}:`;
  for (const key of Object.keys(cache.people)) {
    if (!key.startsWith(prefix)) delete cache.people[key];
  }
}

async function hydrateVisibleLines({
  host,
  token,
  api,
  mapPool,
  org,
  todayEst,
  people,
  youLogin,
  cachePath,
}) {
  const file = cachePath || defaultStatsCachePath();
  const cache = loadStatsCache(file);
  prunePersonKeys(cache, todayEst);
  cache.org = org;
  cache.date = todayEst;

  let saveChain = Promise.resolve();
  const persist = () => {
    saveChain = saveChain.then(() => saveStatsCache(file, cache)).catch(() => {});
    return saveChain;
  };

  const visible = visiblePeople(people, youLogin);
  for (const person of visible) {
    const entries = person.commitEntries || [];
    const key = personCacheKey(todayEst, person.login);
    const prev = cache.people[key];
    const plan = planLineFetches(entries, prev, cache.stats);

    if (plan.skip) {
      person.additions = prev.additions;
      person.deletions = prev.deletions;
      if (person.additions == null) {
        const summed = sumCachedStats(entries, cache.stats);
        person.additions = summed.additions;
        person.deletions = summed.deletions;
      }
      continue;
    }

    for (const entry of plan.merges || []) {
      cache.stats[entry.sha] = {
        additions: 0,
        deletions: 0,
        merge: true,
        repo: entry.repo || null,
        date: entry.date || '',
      };
    }
    if (plan.merges?.length) await persist();

    await mapPool(plan.fetch, 4, async (entry) => {
      try {
        const detail = await api(
          host,
          token,
          `repos/${entry.repo}/commits/${entry.sha}`
        );
        const merge = isMergeCommit(detail);
        cache.stats[entry.sha] = {
          additions: merge ? 0 : Number(detail.stats?.additions) || 0,
          deletions: merge ? 0 : Number(detail.stats?.deletions) || 0,
          merge,
          repo: entry.repo,
          date: entry.date || '',
        };
        await persist();
      } catch {
        // leave uncached for the next poll
      }
    });

    const summed = sumCachedStats(entries, cache.stats);
    person.additions = summed.additions;
    person.deletions = summed.deletions;
    cache.people[key] = {
      fp: plan.fp,
      shas: plan.shas,
      additions: summed.additions,
      deletions: summed.deletions,
      maxDate: summed.maxDate,
      updatedAt: new Date().toISOString(),
    };
    await persist();
  }

  await saveChain;
}

module.exports = {
  defaultStatsCachePath,
  fingerprint,
  hydrateVisibleLines,
  isMergeCommit,
  loadStatsCache,
  planLineFetches,
  repoFromCommit,
  saveStatsCache,
  visiblePeople,
};
