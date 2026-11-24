/**
 * Keeps the takeover announcement on a community pull request in line with
 * its `maintainer takeover` label (`.github/workflows/pr-policy.yml`, on
 * every event the policy check runs on).
 *
 * Label on: one comment tells the author that the maintainer who added the
 * label finishes the PR, and the PR is assigned to that maintainer. Label
 * off: the comment is removed. Only people with triage access can label, so
 * whoever added it is a maintainer.
 *
 * Reads the author from the `pull_request_target` payload at
 * `GITHUB_EVENT_PATH` and the labels, timeline, and comments live.
 * `--dry-run` prints what it would do and changes nothing.
 */

import { readFileSync } from 'node:fs';
import { announceTakeover, labeledBy, livePullRequest, takeoverAnnouncement, withdrawTakeover } from './github.ts';
import { TAKEOVER_LABEL, isCommunity, payloadAuthor, takeoverChange } from './rules.ts';

interface Payload {
  pull_request: Parameters<typeof payloadAuthor>[0] & { number: number; state: string };
}

const dryRun = process.argv.includes('--dry-run');
const eventPath = process.env.GITHUB_EVENT_PATH;
if (!eventPath) {
  process.stderr.write('GITHUB_EVENT_PATH is required\n');
  process.exit(2);
}
const pr = (JSON.parse(readFileSync(eventPath, 'utf8')) as Payload).pull_request;

const author = payloadAuthor(pr);
if (pr.state !== 'open' || !isCommunity(author)) {
  console.log(`#${pr.number}: not an open community PR, skipping`);
  process.exit(0);
}

const { labels } = await livePullRequest(pr.number);
const existing = await takeoverAnnouncement(pr.number);
const change = takeoverChange({
  labels,
  author: author.login,
  maintainer: await labeledBy(pr.number, TAKEOVER_LABEL),
  announced: existing?.body,
});

if (change === undefined) {
  console.log(`#${pr.number}: the takeover announcement matches the label`);
} else if (change === 'withdraw') {
  console.log(`#${pr.number}: takeover withdrawn${dryRun ? ' (dry run)' : ''}`);
  if (!dryRun && existing !== undefined) await withdrawTakeover(existing);
} else {
  console.log(`#${pr.number}: ${change.maintainer} takes over from ${author.login}${dryRun ? ' (dry run)' : ''}\n${change.announce}`);
  if (!dryRun) await announceTakeover(pr.number, change.maintainer, change.announce, existing);
}
