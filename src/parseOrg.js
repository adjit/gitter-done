function parseGitOrg(raw, ghHost) {
  if (!raw || !String(raw).trim()) {
    throw new Error('Set GIT_ORG, e.g. GIT_ORG=git.bruin.com/bruin');
  }

  const s = String(raw)
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
  const parts = s.split('/').filter(Boolean);

  if (parts.length >= 2 && parts[0].includes('.')) {
    return { host: parts[0], org: parts[1] };
  }

  if (parts.length === 1) {
    return { host: ghHost || process.env.GH_HOST || 'github.com', org: parts[0] };
  }

  throw new Error(
    `Could not parse GIT_ORG="${raw}". Use host/org, e.g. git.bruin.com/bruin`
  );
}

module.exports = { parseGitOrg };
