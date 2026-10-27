import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const semver = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))('semver');
const REPO = 'https://github.com/YAQMC/YAQMC';
const escapeText = (value) =>
  value
    .replace(/[\r\n\t]/gu, ' ')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/[\\`*_{}[\]()#+!|]/gu, '\\$&');

export function generateReleaseCommits({ cwd, commit, tag, published, limit = 60_000 }) {
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error('release commit must be a full Git SHA');
  const current = tag.replace(/^v/u, '');
  if (semver.valid(current) !== current.split('+')[0] || tag !== `v${current}`)
    throw new Error('release tag must be strict SemVer');
  const git = (args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['cat-file', '-e', `${commit}^{commit}`]);
  const candidates = published
    .flat()
    .filter((r) => !r.draft && typeof r.tag_name === 'string')
    .map((r) => ({
      tag: r.tag_name,
      version: r.tag_name.slice(1),
      prerelease: r.prerelease === true,
    }))
    .filter(
      (r) =>
        semver.valid(r.version) === r.version.split('+')[0] &&
        r.tag === `v${r.version}` &&
        semver.lt(r.version, current),
    )
    .sort((a, b) => semver.rcompare(a.version, b.version));
  const isPre = !!semver.prerelease(current);
  const sameLine = (value) =>
    value.split('-')[0].split('+')[0] === current.split('-')[0].split('+')[0];
  const ordered = isPre
    ? [
        ...candidates.filter((r) => semver.prerelease(r.version) && sameLine(r.version)),
        ...candidates.filter((r) => !r.prerelease && !semver.prerelease(r.version)),
      ]
    : candidates.filter((r) => !r.prerelease && !semver.prerelease(r.version));
  let base;
  for (const candidate of ordered) {
    git(['rev-parse', '--verify', `refs/tags/${candidate.tag}^{commit}`]);
    if (
      spawnSync('git', ['merge-base', '--is-ancestor', `refs/tags/${candidate.tag}`, commit], {
        cwd,
      }).status === 0
    ) {
      base = candidate.tag;
      break;
    }
  }
  const range = base ? `${base}..${commit}` : commit;
  const log = git(['log', '--reverse', '--format=%H%x00%s%x00', range]);
  const parts = log.split('\0');
  const entries = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const sha = parts[i].trim();
    if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error('invalid Git log output');
    entries.push(`- [${sha.slice(0, 12)}](${REPO}/commit/${sha}) ${escapeText(parts[i + 1])}`);
  }
  const compare = base
    ? `${REPO}/compare/${encodeURIComponent(base)}...${encodeURIComponent(tag)}`
    : `${REPO}/commits/${commit}`;
  const heading = `# YAQMC ${tag}\n\n[Commits](${compare})\n\n`;
  const full = `${heading}${entries.join('\n')}\n`;
  if (Buffer.byteLength(full) <= limit) return { body: full, full, truncated: false, base };
  const suffix = `\n\n提交列表已截断 / Commit list truncated. [完整列表 / Full list](${REPO}/releases/download/${encodeURIComponent(tag)}/COMMITS.md)\n`;
  let body = heading;
  for (const entry of entries) {
    if (Buffer.byteLength(body + entry + suffix) > limit) break;
    body += `${entry}\n`;
  }
  return { body: body + suffix, full, truncated: true, base };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = Object.fromEntries(
    process.argv.slice(2).reduce((pairs, value, index, all) => {
      if (index % 2 === 0) pairs.push([value.replace(/^--/u, ''), all[index + 1]]);
      return pairs;
    }, []),
  );
  const result = generateReleaseCommits({
    cwd: process.cwd(),
    commit: args.commit,
    tag: args.tag,
    published: JSON.parse(readFileSync(args.published, 'utf8')),
  });
  const notes = path.join(args.to, 'RELEASE-NOTES.md');
  if (existsSync(notes)) copyFileSync(notes, path.join(args.to, 'DOWNLOADS.md'));
  writeFileSync(notes, result.body);
  if (result.truncated) writeFileSync(path.join(args.to, 'COMMITS.md'), result.full);
}
