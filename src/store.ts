// The forge's in-memory store: repositories, issues, pull requests, labels
// and comments, all backed by the git object store in gitcore.ts so the REST
// view and the git view are the same data.
import {
  GitStore,
  ZERO_OID,
  buildCommit,
  flattenTree,
  isAncestor,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  treeGetPath,
  treeListDir,
  treeSetPath,
  walkCommits,
  type GitObject,
} from './gitcore.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_EMAIL = 'adaiversen@users.noreply.github.com';

/** The trial's fixed "now": deterministic across live and replay runs. */
export function trialNowIso(): string {
  const now = process.env.MAKEFUN_TRIAL_NOW;
  if (now) {
    const d = new Date(now);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

export function trialNowSec(): number {
  const now = process.env.MAKEFUN_TRIAL_NOW;
  if (now) {
    const t = Date.parse(now);
    if (!Number.isNaN(t)) return Math.floor(t / 1000);
  }
  return Math.floor(Date.now() / 1000);
}

export function avatarUrl(login: string): string {
  return `https://avatars.githubusercontent.com/${login}`;
}

export function userJson(login: string): Record<string, unknown> {
  return {
    login,
    id: 1,
    node_id: 'U_kgDOAAA',
    avatar_url: avatarUrl(login),
    gravatar_id: '',
    url: `/api/v3/users/${login}`,
    html_url: `https://github.com/${login}`,
    type: 'User',
    site_admin: false,
  };
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  assignees: string[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: IssueComment[];
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  user: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  draft: boolean;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  pushedAt: string;
  git: GitStore;
  issues: Map<number, Issue>;
  issueSeq: number;
  labels: Map<string, Label>;
  prs: Map<number, PullRequest>;
  prSeq: number;
  /** Set once the first push lands: the default branch follows it. */
  defaultBranchSettled: boolean;
}

export class Forge {
  repos = new Map<string, Repo>();
  repoSeq = 0;
  issueIdSeq = 0;
  commentIdSeq = 0;
  prIdSeq = 0;
  requestSeq = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean, autoInit: boolean): Repo {
    this.repoSeq += 1;
    const repo: Repo = {
      id: this.repoSeq,
      name,
      owner,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdAt: trialNowIso(),
      updatedAt: trialNowIso(),
      pushedAt: trialNowIso(),
      git: new GitStore(),
      issues: new Map(),
      issueSeq: 0,
      labels: new Map(),
      prs: new Map(),
      prSeq: 0,
      defaultBranchSettled: false,
    };
    this.repos.set(this.key(owner, name), repo);
    if (autoInit) {
      const blob = repo.git.put('blob', Buffer.from(`# ${name}\n`, 'utf8'));
      const tree = repo.git.put('tree', Buffer.concat([
        Buffer.from(`100644 README.md\0`, 'utf8'),
        Buffer.from(blob, 'hex'),
      ]));
      const commit = repo.git.put(
        'commit',
        buildCommit(tree, [], `Initial commit`, VIEWER_LOGIN, VIEWER_EMAIL, trialNowSec()),
      );
      repo.git.setRef(`refs/heads/${repo.defaultBranch}`, commit);
      repo.defaultBranchSettled = true;
    }
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    return Array.from(this.repos.values()).filter((r) => r.owner === owner);
  }

  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq}`;
  }
}

// ---------------------------------------------------------------------------
// Serializers: GitHub-shaped JSON
// ---------------------------------------------------------------------------

export function repoNodeId(repo: Repo): string {
  return `R_${Buffer.from(`repo:${repo.owner}/${repo.name}`).toString('base64url')}`;
}

export function issueNodeId(repo: Repo, issue: Issue): string {
  return `I_${Buffer.from(`issue:${repo.owner}/${repo.name}:${issue.number}`).toString('base64url')}`;
}

export function prNodeId(repo: Repo, pr: PullRequest): string {
  return `PR_${Buffer.from(`pr:${repo.owner}/${repo.name}:${pr.number}`).toString('base64url')}`;
}

export function commentNodeId(repo: Repo, comment: IssueComment): string {
  return `IC_${Buffer.from(`comment:${repo.owner}/${repo.name}:${comment.id}`).toString('base64url')}`;
}

export function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.git.ref(`refs/heads/${branch}`);
}

export function repoJson(repo: Repo): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    node_id: repoNodeId(repo),
    name: repo.name,
    full_name: fullName,
    owner: userJson(repo.owner),
    private: repo.isPrivate,
    html_url: `https://github.com/${fullName}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${fullName}`,
    archive_url: `/api/v3/repos/${fullName}/{archive_format}{/ref}`,
    assignees_url: `/api/v3/repos/${fullName}/assignees{/user}`,
    blobs_url: `/api/v3/repos/${fullName}/git/blobs{/sha}`,
    branches_url: `/api/v3/repos/${fullName}/branches{/branch}`,
    clone_url: `https://github.com/${fullName}.git`,
    collaborators_url: `/api/v3/repos/${fullName}/collaborators{/collaborator}`,
    comments_url: `/api/v3/repos/${fullName}/comments{/number}`,
    commits_url: `/api/v3/repos/${fullName}/commits{/sha}`,
    compare_url: `/api/v3/repos/${fullName}/compare/{base}...{head}`,
    contents_url: `/api/v3/repos/${fullName}/contents/{+path}`,
    contributors_url: `/api/v3/repos/${fullName}/contributors`,
    deployments_url: `/api/v3/repos/${fullName}/deployments`,
    downloads_url: `/api/v3/repos/${fullName}/downloads`,
    events_url: `/api/v3/repos/${fullName}/events`,
    forks_url: `/api/v3/repos/${fullName}/forks`,
    git_commits_url: `/api/v3/repos/${fullName}/git/commits{/sha}`,
    git_refs_url: `/api/v3/repos/${fullName}/git/refs{/sha}`,
    git_tags_url: `/api/v3/repos/${fullName}/git/tags{/sha}`,
    git_url: `git://github.com/${fullName}.git`,
    issue_comment_url: `/api/v3/repos/${fullName}/issues/comments{/number}`,
    issue_events_url: `/api/v3/repos/${fullName}/issues/events{/number}`,
    issues_url: `/api/v3/repos/${fullName}/issues{/number}`,
    keys_url: `/api/v3/repos/${fullName}/keys{/key_id}`,
    labels_url: `/api/v3/repos/${fullName}/labels{/name}`,
    languages_url: `/api/v3/repos/${fullName}/languages`,
    merges_url: `/api/v3/repos/${fullName}/merges`,
    milestones_url: `/api/v3/repos/${fullName}/milestones{/number}`,
    notifications_url: `/api/v3/repos/${fullName}/notifications{?since,all,participating}`,
    pulls_url: `/api/v3/repos/${fullName}/pulls{/number}`,
    releases_url: `/api/v3/repos/${fullName}/releases{/id}`,
    ssh_url: `git@github.com:${fullName}.git`,
    stargazers_url: `/api/v3/repos/${fullName}/stargazers`,
    statuses_url: `/api/v3/repos/${fullName}/statuses/{sha}`,
    subscribers_url: `/api/v3/repos/${fullName}/subscribers`,
    subscription_url: `/api/v3/repos/${fullName}/subscription`,
    tags_url: `/api/v3/repos/${fullName}/tags`,
    teams_url: `/api/v3/repos/${fullName}/teams`,
    trees_url: `/api/v3/repos/${fullName}/git/trees{/sha}`,
    homepage: null,
    language: null,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    size: 0,
    default_branch: repo.defaultBranch,
    open_issues_count: Array.from(repo.issues.values()).filter((i) => i.state === 'open').length,
    is_template: false,
    topics: [],
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    pushed_at: repo.pushedAt,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    allow_rebase_merge: true,
    allow_squash_merge: true,
    allow_merge_commit: true,
    allow_forking: true,
    license: null,
    allow_auto_merge: false,
    delete_branch_on_merge: false,
    subscribers_count: 0,
    network_count: 0,
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return {
    id: 0,
    node_id: `LA_${Buffer.from(`label:${label.name}`).toString('base64url')}`,
    url: '',
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    id: issue.id,
    node_id: issueNodeId(repo, issue),
    url: `/api/v3/repos/${fullName}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${fullName}`,
    labels_url: `/api/v3/repos/${fullName}/issues/${issue.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${fullName}/issues/${issue.number}/comments`,
    events_url: `/api/v3/repos/${fullName}/issues/${issue.number}/events`,
    html_url: `https://github.com/${fullName}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userJson(issue.user),
    labels: issue.labels.map((n) => {
      const l = repo.labels.get(n);
      return l ? labelJson(l) : { name: n, color: 'ededed', description: '' };
    }),
    locked: false,
    assignee: issue.assignees.length > 0 ? userJson(issue.assignees[0]) : null,
    assignees: issue.assignees.map((a) => userJson(a)),
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    active_lock_reason: null,
    state_reason: issue.state === 'closed' ? 'completed' : null,
  };
}

export function commentJson(repo: Repo, issue: Issue, comment: IssueComment): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    id: comment.id,
    node_id: commentNodeId(repo, comment),
    url: `/api/v3/repos/${fullName}/issues/comments/${comment.id}`,
    html_url: `https://github.com/${fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(comment.user),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
  };
}

export function prHeadBaseJson(repo: Repo, pr: PullRequest): { head: Record<string, unknown>; base: Record<string, unknown> } {
  const headSha = branchTip(repo, pr.headRef) ?? ZERO_OID;
  const baseSha = branchTip(repo, pr.baseRef) ?? ZERO_OID;
  const mk = (ref: string, sha: string): Record<string, unknown> => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: userJson(repo.owner),
    repo: repoJson(repo),
  });
  return { head: mk(pr.headRef, headSha), base: mk(pr.baseRef, baseSha) };
}

export function prJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  const { head, base } = prHeadBaseJson(repo, pr);
  return {
    id: pr.id,
    node_id: prNodeId(repo, pr),
    url: `/api/v3/repos/${fullName}/pulls/${pr.number}`,
    html_url: `https://github.com/${fullName}/pull/${pr.number}`,
    diff_url: `https://github.com/${fullName}/pull/${pr.number}.diff`,
    patch_url: `https://github.com/${fullName}/pull/${pr.number}.patch`,
    issue_url: `/api/v3/repos/${fullName}/issues/${pr.number}`,
    number: pr.number,
    state: pr.state,
    locked: false,
    title: pr.title,
    body: pr.body,
    user: userJson(pr.user),
    labels: [],
    milestone: null,
    created_at: pr.createdAt,
    updated_at: pr.updatedAt,
    closed_at: pr.closedAt,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    head,
    base,
    _links: {
      self: { href: `/api/v3/repos/${fullName}/pulls/${pr.number}` },
      html: { href: `https://github.com/${fullName}/pull/${pr.number}` },
      issue: { href: `/api/v3/repos/${fullName}/issues/${pr.number}` },
      comments: { href: `/api/v3/repos/${fullName}/issues/${pr.number}/comments` },
      review_comments: { href: `/api/v3/repos/${fullName}/pulls/${pr.number}/comments` },
      review_comment: { href: `/api/v3/repos/${fullName}/pulls/comments{/number}` },
      commits: { href: `/api/v3/repos/${fullName}/pulls/${pr.number}/commits` },
      statuses: { href: `/api/v3/repos/${fullName}/statuses/${(head.sha as string) ?? ''}` },
    },
    author_association: 'OWNER',
    auto_merge: null,
    active_lock_reason: null,
    draft: pr.draft,
    merged: pr.merged,
    mergeable: prMergeable(repo, pr),
    mergeable_state: prMergeable(repo, pr) ? 'clean' : 'dirty',
    merged_by: pr.merged ? userJson(repo.owner) : null,
    comments: 0,
    review_comments: 0,
    maintainer_can_modify: false,
    commits: prCommits(repo, pr).length,
    additions: prFiles(repo, pr).reduce((n, f) => n + f.additions, 0),
    deletions: prFiles(repo, pr).reduce((n, f) => n + f.deletions, 0),
    changed_files: prFiles(repo, pr).length,
  };
}

// ---------------------------------------------------------------------------
// Issues / labels / comments
// ---------------------------------------------------------------------------

export function createIssue(
  forge: Forge,
  repo: Repo,
  title: string,
  body: string,
  labels: string[],
  user: string,
): Issue {
  repo.issueSeq += 1;
  forge.issueIdSeq += 1;
  const now = trialNowIso();
  const issue: Issue = {
    id: forge.issueIdSeq,
    number: repo.issueSeq,
    title,
    body,
    state: 'open',
    labels: [...labels],
    user,
    assignees: [],
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    comments: [],
  };
  repo.issues.set(issue.number, issue);
  return issue;
}

export function addIssueComment(forge: Forge, issue: Issue, body: string, user: string): IssueComment {
  forge.commentIdSeq += 1;
  const now = trialNowIso();
  const comment: IssueComment = { id: forge.commentIdSeq, body, user, createdAt: now, updatedAt: now };
  issue.comments.push(comment);
  return comment;
}

// ---------------------------------------------------------------------------
// Pull requests: files diff, mergeability, squash merge
// ---------------------------------------------------------------------------

export interface PrFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  patch: string;
}

function diffLines(oldText: string, newText: string): { additions: number; deletions: number; patch: string } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  // Strip a single trailing empty element produced by a final newline.
  if (a.length > 0 && a[a.length - 1] === '') a.pop();
  if (b.length > 0 && b[b.length - 1] === '') b.pop();
  if (a.length > 4000 || b.length > 4000) {
    // Too large for LCS: count the whole file as changed.
    return { additions: b.length, deletions: a.length, patch: '' };
  }
  // LCS dynamic programming, then backtrack to a hunk list.
  const n = a.length;
  const m = b.length;
  const dp: number[][] = [];
  for (let i = 0; i <= n; i += 1) dp.push(new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let additions = 0;
  let deletions = 0;
  const ops: Array<{ kind: ' ' | '-' | '+'; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: '-', text: a[i] });
      deletions += 1;
      i += 1;
    } else {
      ops.push({ kind: '+', text: b[j] });
      additions += 1;
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: '-', text: a[i] });
    deletions += 1;
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: '+', text: b[j] });
    additions += 1;
    j += 1;
  }
  // One hunk covering the whole file (files in this forge are small).
  let patch = '';
  if (additions > 0 || deletions > 0) {
    patch = `@@ -1,${n} +1,${m} @@\n${ops.map((o) => `${o.kind}${o.text}`).join('\n')}\n`;
  }
  return { additions, deletions, patch };
}

export function prFiles(repo: Repo, pr: PullRequest): PrFile[] {
  const headTip = branchTip(repo, pr.headRef);
  const baseTip = branchTip(repo, pr.baseRef);
  if (!headTip || !baseTip) return [];
  const headCommit = repo.git.get(headTip);
  const baseCommit = repo.git.get(baseTip);
  if (!headCommit || !baseCommit) return [];
  const headTree = parseCommit(headCommit.data).tree;
  const baseTree = parseCommit(baseCommit.data).tree;
  const headFlat = flattenTree(repo.git, headTree);
  const baseFlat = flattenTree(repo.git, baseTree);
  const names = new Set<string>([...headFlat.keys(), ...baseFlat.keys()]);
  const out: PrFile[] = [];
  for (const name of Array.from(names).sort()) {
    const h = headFlat.get(name);
    const b = baseFlat.get(name);
    if (h && !b) {
      const obj = repo.git.get(h.oid);
      const text = obj ? obj.data.toString('utf8') : '';
      const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      out.push({ filename: name, status: 'added', additions: lines, deletions: 0, changes: lines, patch: '' });
    } else if (!h && b) {
      const obj = repo.git.get(b.oid);
      const text = obj ? obj.data.toString('utf8') : '';
      const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      out.push({ filename: name, status: 'removed', additions: 0, deletions: lines, changes: lines, patch: '' });
    } else if (h && b && h.oid !== b.oid) {
      const oldObj = repo.git.get(b.oid);
      const newObj = repo.git.get(h.oid);
      const d = diffLines(oldObj ? oldObj.data.toString('utf8') : '', newObj ? newObj.data.toString('utf8') : '');
      out.push({ filename: name, status: 'modified', additions: d.additions, deletions: d.deletions, changes: d.additions + d.deletions, patch: d.patch });
    }
  }
  return out;
}

/** Commits on the head branch that are not on the base branch, oldest first. */
export function prCommits(repo: Repo, pr: PullRequest): string[] {
  const headTip = branchTip(repo, pr.headRef);
  const baseTip = branchTip(repo, pr.baseRef);
  if (!headTip || !baseTip) return [];
  const baseSet = new Set(walkCommits(repo.git, baseTip));
  const all = walkCommits(repo.git, headTip);
  return all.filter((c) => !baseSet.has(c)).reverse();
}

/**
 * A pull request is mergeable when a three-way merge of base tip, head tip
 * and their merge-base has no file changed on both sides to different content.
 */
export function prMergeable(repo: Repo, pr: PullRequest): boolean {
  if (pr.state !== 'open') return false;
  const headTip = branchTip(repo, pr.headRef);
  const baseTip = branchTip(repo, pr.baseRef);
  if (!headTip || !baseTip) return false;
  if (headTip === baseTip) return true;
  const base = mergeBase(repo.git, baseTip, headTip);
  if (!base) return true; // Unrelated histories: a squash merge still applies.
  const baseObj = repo.git.get(base);
  if (!baseObj) return true;
  const baseTree = flattenTree(repo.git, parseCommit(baseObj.data).tree);
  const headObj = repo.git.get(headTip);
  const tipObj = repo.git.get(baseTip);
  if (!headObj || !tipObj) return false;
  const headTree = flattenTree(repo.git, parseCommit(headObj.data).tree);
  const tipTree = flattenTree(repo.git, parseCommit(tipObj.data).tree);
  const names = new Set<string>([...baseTree.keys(), ...headTree.keys(), ...tipTree.keys()]);
  for (const name of names) {
    const b = baseTree.get(name)?.oid;
    const h = headTree.get(name)?.oid;
    const t = tipTree.get(name)?.oid;
    const headChanged = h !== b;
    const baseChanged = t !== b;
    if (headChanged && baseChanged && h !== t) return false;
  }
  return true;
}

/** Squash-merge a pull request onto its base branch; returns the new commit. */
export function mergePullRequest(
  forge: Forge,
  repo: Repo,
  pr: PullRequest,
  message?: string,
): { sha: string } | { error: string } {
  if (pr.state !== 'open') return { error: 'Pull request is already closed' };
  if (!prMergeable(repo, pr)) return { error: 'Merge conflict' };
  const headTip = branchTip(repo, pr.headRef);
  const baseTip = branchTip(repo, pr.baseRef);
  if (!headTip || !baseTip) return { error: 'Branch not found' };
  const headCommit = repo.git.get(headTip);
  if (!headCommit) return { error: 'Head commit not found' };
  const tree = parseCommit(headCommit.data).tree;
  const title = message ?? `${pr.title} (#${pr.number})`;
  const commitData = buildCommit(tree, [baseTip], title, VIEWER_LOGIN, VIEWER_EMAIL, trialNowSec());
  const sha = repo.git.put('commit', commitData);
  repo.git.setRef(`refs/heads/${pr.baseRef}`, sha);
  const now = trialNowIso();
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = now;
  pr.closedAt = now;
  pr.updatedAt = now;
  pr.mergeCommitSha = sha;
  repo.updatedAt = now;
  repo.pushedAt = now;
  void forge;
  return { sha };
}

// ---------------------------------------------------------------------------
// Contents API: file reads/writes as real git commits on the branch
// ---------------------------------------------------------------------------

export interface ContentsEntry {
  type: 'file' | 'dir';
  name: string;
  path: string;
  sha: string;
  size: number;
  content?: string;
  encoding?: string;
}

export function getContents(repo: Repo, ref: string, path: string): ContentsEntry[] | ContentsEntry | null {
  const tip = branchTip(repo, ref) ?? repo.git.ref(`refs/tags/${ref}`);
  if (!tip) return null;
  const commit = repo.git.get(tip);
  if (!commit || commit.type !== 'commit') return null;
  const tree = parseCommit(commit.data).tree;
  const parts = path === '' ? [] : path.split('/').filter((p) => p !== '');
  if (parts.length === 0) {
    const entries = treeListDir(repo.git, tree, []) ?? [];
    return entries.map((e) => dirEntry(repo, e, ''));
  }
  const hit = treeGetPath(repo.git, tree, parts);
  if (!hit) return null;
  if (hit.mode === '40000') {
    const entries = treeListDir(repo.git, tree, parts) ?? [];
    return entries.map((e) => dirEntry(repo, e, path));
  }
  const obj = repo.git.get(hit.oid);
  if (!obj) return null;
  return {
    type: 'file',
    name: parts[parts.length - 1],
    path,
    sha: hit.oid,
    size: obj.data.length,
    content: obj.data.toString('base64'),
    encoding: 'base64',
  };
}

function dirEntry(repo: Repo, e: { mode: string; name: string; oid: string }, parent: string): ContentsEntry {
  const path = parent === '' ? e.name : `${parent}/${e.name}`;
  if (e.mode === '40000') {
    return { type: 'dir', name: e.name, path, sha: e.oid, size: 0 };
  }
  const obj = repo.git.get(e.oid);
  return { type: 'file', name: e.name, path, sha: e.oid, size: obj ? obj.data.length : 0 };
}

export interface ContentsWriteResult {
  sha: string;
  created: boolean;
}

/** Write (create or update) one file as a new commit on `branch`. */
export function putContents(
  repo: Repo,
  branch: string,
  path: string,
  contentB64: string,
  message: string,
): ContentsWriteResult {
  const data = Buffer.from(contentB64, 'base64');
  const blob = repo.git.put('blob', data);
  const tip = branchTip(repo, branch);
  let tree = '';
  const parents: string[] = [];
  let created = true;
  if (tip) {
    const commit = repo.git.get(tip);
    if (commit && commit.type === 'commit') {
      tree = parseCommit(commit.data).tree;
      parents.push(tip);
      const existing = treeGetPath(repo.git, tree, path.split('/'));
      created = !existing;
    }
  }
  const newTree = treeSetPath(repo.git, tree, path.split('/'), blob, '100644');
  const commitData = buildCommit(newTree, parents, message, VIEWER_LOGIN, VIEWER_EMAIL, trialNowSec());
  const sha = repo.git.put('commit', commitData);
  repo.git.setRef(`refs/heads/${branch}`, sha);
  if (!repo.defaultBranchSettled) {
    repo.defaultBranch = branch;
    repo.defaultBranchSettled = true;
  }
  const now = trialNowIso();
  repo.updatedAt = now;
  repo.pushedAt = now;
  return { sha, created };
}

/** Delete one file as a new commit on `branch`; false when the file is absent. */
export function deleteContents(repo: Repo, branch: string, path: string, message: string): { sha: string } | null {
  const tip = branchTip(repo, branch);
  if (!tip) return null;
  const commit = repo.git.get(tip);
  if (!commit || commit.type !== 'commit') return null;
  const tree = parseCommit(commit.data).tree;
  const existing = treeGetPath(repo.git, tree, path.split('/'));
  if (!existing) return null;
  const newTree = treeSetPath(repo.git, tree, path.split('/'), null, '100644');
  const commitData = buildCommit(newTree, [tip], message, VIEWER_LOGIN, VIEWER_EMAIL, trialNowSec());
  const sha = repo.git.put('commit', commitData);
  repo.git.setRef(`refs/heads/${branch}`, sha);
  const now = trialNowIso();
  repo.updatedAt = now;
  repo.pushedAt = now;
  return { sha };
}

export function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const obj = repo.git.get(sha);
  if (!obj || obj.type !== 'commit') return null;
  const info = parseCommit(obj.data);
  return {
    sha,
    node_id: `C_${Buffer.from(`commit:${sha}`).toString('base64url')}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${sha}`,
    commit: {
      message: info.message,
      author: { name: VIEWER_LOGIN, email: VIEWER_EMAIL, date: trialNowIso() },
      committer: { name: VIEWER_LOGIN, email: VIEWER_EMAIL, date: trialNowIso() },
      tree: { sha: info.tree, url: '' },
    },
    author: userJson(VIEWER_LOGIN),
    committer: userJson(VIEWER_LOGIN),
    parents: info.parents.map((p) => ({ sha: p, url: '', html_url: '' })),
  };
}

export type { GitObject };
