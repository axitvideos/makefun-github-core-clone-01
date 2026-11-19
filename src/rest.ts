// GitHub REST v3 under /api/v3: repositories, branches, commits, contents,
// issues, comments, labels and pull requests.
import {
  Forge,
  VIEWER_LOGIN,
  addIssueComment,
  branchTip,
  commitJson,
  createIssue,
  deleteContents,
  getContents,
  issueJson,
  commentJson,
  labelJson,
  mergePullRequest,
  prCommits,
  prFiles,
  prJson,
  prMergeable,
  putContents,
  repoJson,
  trialNowIso,
  userJson,
  type Issue,
  type Label,
  type PullRequest,
  type Repo,
} from './store.ts';
import { ZERO_OID, isAncestor, parseCommit, walkCommits } from './gitcore.ts';

export interface RestContext {
  forge: Forge;
  method: string;
  /** Path segments after /api/v3, URL-decoded. */
  segments: string[];
  query: URLSearchParams;
  /** Parsed JSON body, or undefined when there is none. */
  body: unknown;
  /** The request's absolute base (http://host) for Link headers. */
  base: string;
  /** The full path+query as requested, for Link headers. */
  rawPath: string;
}

export interface RestResult {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
}

const err = (status: number, message: string): RestResult => ({ status, json: { message } });

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/** Paginate a list; returns the page and a Link header value (or null). */
function paginate<T>(
  items: T[],
  ctx: RestContext,
): { page: T[]; link: string | null } {
  const perPageRaw = parseInt(ctx.query.get('per_page') ?? '30', 10);
  const perPage = Number.isNaN(perPageRaw) ? 30 : Math.min(100, Math.max(1, perPageRaw));
  const pageRaw = parseInt(ctx.query.get('page') ?? '1', 10);
  const page = Number.isNaN(pageRaw) ? 1 : Math.max(1, pageRaw);
  const total = items.length;
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const urlFor = (p: number): string => {
    const q = new URLSearchParams(ctx.query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `${ctx.base}${ctx.rawPath.split('?')[0]}?${q.toString()}`;
  };
  const links: string[] = [];
  if (page < lastPage) links.push(`<${urlFor(page + 1)}>; rel="next"`, `<${urlFor(lastPage)}>; rel="last"`);
  if (page > 1) links.push(`<${urlFor(1)}>; rel="first"`, `<${urlFor(page - 1)}>; rel="prev"`);
  return { page: slice, link: links.length > 0 ? links.join(', ') : null };
}

function withLink(result: RestResult, link: string | null): RestResult {
  if (link) result.headers = { ...(result.headers ?? {}), link };
  return result;
}

/** Resolve /repos/{owner}/{repo} from segments; 404 when foreign or missing. */
function lookupRepo(forge: Forge, segments: string[]): { repo: Repo } | RestResult {
  const owner = segments[1];
  const name = segments[2];
  if (owner !== VIEWER_LOGIN) return err(404, 'Not Found');
  const repo = forge.getRepo(owner, name);
  if (!repo) return err(404, 'Not Found');
  return { repo };
}

function sortIssues(issues: Issue[], sort: string, direction: string): Issue[] {
  const dir = direction === 'asc' ? 1 : -1;
  const arr = [...issues];
  if (sort === 'comments') {
    arr.sort((a, b) => dir * (a.comments.length - b.comments.length) || dir * (a.number - b.number));
  } else if (sort === 'updated') {
    arr.sort((a, b) => dir * (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.number - b.number));
  } else {
    // created (default): timestamps may tie, so numbers break ties.
    arr.sort((a, b) => dir * (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.number - b.number));
  }
  return arr;
}

export function handleRest(ctx: RestContext): RestResult | null {
  const { forge, method, segments } = ctx;
  const [first, second] = segments;

  // API root.
  if (segments.length === 0 || (segments.length === 1 && segments[0] === '')) {
    if (method !== 'GET') return err(404, 'Not Found');
    return {
      status: 200,
      json: {
        current_user_url: '/api/v3/user',
        current_user_authorizations_html_url: 'https://github.com/settings/applications',
        authorizations_url: '/api/v3/authorizations',
        code_search_url: '/api/v3/search/code?q={query}{&page,per_page,sort,order}',
        commit_search_url: '/api/v3/search/commits?q={query}{&page,per_page,sort,order}',
        emails_url: '/api/v3/user/emails',
        emojis_url: '/api/v3/emojis',
        events_url: '/api/v3/events',
        feeds_url: '/api/v3/feeds',
        followers_url: '/api/v3/users/{user}/followers',
        following_url: '/api/v3/users/{user}/following{/other_user}',
        gists_url: '/api/v3/gists{/gist_id}',
        hub_url: 'https://api.github.com/hub',
        issue_search_url: '/api/v3/search/issues?q={query}{&page,per_page,sort,order}',
        issues_url: '/api/v3/issues',
        keys_url: '/api/v3/user/keys',
        label_search_url: '/api/v3/search/labels?q={query}&repository_id={repository_id}{&page,per_page}',
        notifications_url: '/api/v3/notifications{?since,all,participating}',
        organization_url: '/api/v3/orgs/{org}',
        public_gists_url: '/api/v3/gists/public',
        rate_limit_url: '/api/v3/rate_limit',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        repository_search_url: '/api/v3/search/repositories?q={query}{&page,per_page,sort,order}',
        current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
        starred_url: '/api/v3/user/starred{/owner}{/repo}',
        starred_gists_url: '/api/v3/gists/starred',
        topic_search_url: '/api/v3/search/topics?q={query}{&page,per_page}',
        user_url: '/api/v3/users/{user}',
        user_organizations_url: '/api/v3/user/orgs',
        user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
        user_search_url: '/api/v3/search/users?q={query}{&page,per_page,sort,order}',
      },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }

  if (first === 'meta' && method === 'GET') {
    return {
      status: 200,
      json: {
        verifiable_password_authentication: true,
        installed_version: '1.0.0',
        github_enterprise: false,
        hook_ip_ranges: [],
        git_ip_ranges: [],
        importers: [],
      },
    };
  }

  if (first === 'rate_limit' && method === 'GET') {
    const reset = Math.floor(Date.now() / 1000) + 3600;
    return {
      status: 200,
      json: {
        resources: {
          core: { limit: 5000, remaining: 4999, reset, used: 1 },
          search: { limit: 30, remaining: 30, reset, used: 0 },
          graphql: { limit: 5000, remaining: 5000, reset, used: 0 },
        },
        rate: { limit: 5000, remaining: 4999, reset, used: 1 },
      },
    };
  }

  if (first === 'user' && segments.length === 1 && method === 'GET') {
    return { status: 200, json: { ...userJson(VIEWER_LOGIN), name: VIEWER_LOGIN, email: null, public_repos: forge.listRepos(VIEWER_LOGIN).length, followers: 0, following: 0, created_at: '2026-01-01T00:00:00Z', updated_at: trialNowIso() } };
  }

  if (first === 'user' && second === 'repos') {
    if (method === 'GET') {
      const repos = forge.listRepos(VIEWER_LOGIN).sort((a, b) => a.id - b.id);
      const { page, link } = paginate(repos.map((r) => repoJson(r)), ctx);
      return withLink({ status: 200, json: page }, link);
    }
    if (method === 'POST') {
      if (!isObj(ctx.body)) return err(400, 'Problems parsing JSON');
      const name = str(ctx.body.name).trim();
      if (name === '') {
        return { status: 422, json: { message: 'Validation Failed', errors: [{ resource: 'Repository', field: 'name', code: 'missing_field' }] } };
      }
      if (forge.getRepo(VIEWER_LOGIN, name)) {
        return { status: 422, json: { message: 'Validation Failed', errors: [{ resource: 'Repository', field: 'name', code: 'custom', message: 'name already exists on this account' }] } };
      }
      const repo = forge.createRepo(
        VIEWER_LOGIN,
        name,
        str(ctx.body.description),
        ctx.body.private === true,
        ctx.body.auto_init === true,
      );
      return { status: 201, json: repoJson(repo) };
    }
    return err(404, 'Not Found');
  }

  if (first === 'users' && segments.length === 2 && method === 'GET') {
    if (segments[1] !== VIEWER_LOGIN) return err(404, 'Not Found');
    return { status: 200, json: userJson(VIEWER_LOGIN) };
  }

  if (first === 'search' && second === 'issues' && method === 'GET') {
    const q = ctx.query.get('q') ?? '';
    const repoMatch = /repo:([^\s]+)/.exec(q);
    let pool: Issue[] = [];
    let owner = '';
    if (repoMatch) {
      const [o, n] = repoMatch[1].split('/');
      owner = o ?? '';
      const repo = forge.getRepo(o ?? '', n ?? '');
      if (repo) pool = Array.from(repo.issues.values());
    } else {
      for (const r of forge.listRepos(VIEWER_LOGIN)) pool.push(...r.issues.values());
    }
    const stateMatch = /state:(open|closed)/.exec(q);
    if (stateMatch) pool = pool.filter((i) => i.state === stateMatch[1]);
    const terms = q.replace(/repo:[^\s]+/g, '').replace(/state:[^\s]+/g, '').trim().toLowerCase();
    if (terms !== '') {
      pool = pool.filter((i) => `${i.title} ${i.body}`.toLowerCase().includes(terms));
    }
    pool.sort((a, b) => b.number - a.number);
    const items = pool.map((i) => {
      const repo = repoMatch ? forge.getRepo(owner, repoMatch[1].split('/')[1] ?? '') : undefined;
      return repo ? issueJson(repo, i) : issueJson(forge.listRepos(VIEWER_LOGIN)[0], i);
    });
    const { page, link } = paginate(items, ctx);
    return withLink({ status: 200, json: { total_count: items.length, incomplete_results: false, items: page } }, link);
  }

  if (first === 'repos' && segments.length >= 3) {
    return handleRepoRoute(ctx);
  }

  return null;
}

function handleRepoRoute(ctx: RestContext): RestResult {
  const { forge, method, segments } = ctx;
  const found = lookupRepo(forge, segments);
  if ('status' in found) return found;
  const repo = found.repo;
  const rest = segments.slice(3);

  // /repos/{owner}/{repo} itself.
  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, json: repoJson(repo) };
    if (method === 'PATCH') {
      if (!isObj(ctx.body)) return err(400, 'Problems parsing JSON');
      if (typeof ctx.body.description === 'string') repo.description = ctx.body.description;
      if (typeof ctx.body.default_branch === 'string' && branchTip(repo, ctx.body.default_branch)) {
        repo.defaultBranch = ctx.body.default_branch;
      }
      if (typeof ctx.body.name === 'string' && ctx.body.name.trim() !== '' && ctx.body.name !== repo.name) {
        const oldKey = forge.key(repo.owner, repo.name);
        repo.name = ctx.body.name.trim();
        forge.repos.delete(oldKey);
        forge.repos.set(forge.key(repo.owner, repo.name), repo);
      }
      if (typeof ctx.body.private === 'boolean') repo.isPrivate = ctx.body.private;
      repo.updatedAt = trialNowIso();
      return { status: 200, json: repoJson(repo) };
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo.owner, repo.name);
      return { status: 204, json: null };
    }
    return err(404, 'Not Found');
  }

  const [sub, ...tail] = rest;

  if (sub === 'branches') {
    if (method === 'GET' && tail.length === 0) {
      const branches = Array.from(repo.git.refs.keys())
        .filter((r) => r.startsWith('refs/heads/'))
        .map((r) => r.slice('refs/heads/'.length))
        .sort();
      const items = branches.map((b) => ({
        name: b,
        commit: { sha: branchTip(repo, b) ?? ZERO_OID, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${branchTip(repo, b) ?? ''}` },
        protected: false,
      }));
      const { page, link } = paginate(items, ctx);
      return withLink({ status: 200, json: page }, link);
    }
    if (method === 'GET' && tail.length === 1) {
      const branch = decodeURIComponent(tail[0]);
      const tip = branchTip(repo, branch);
      if (!tip) return err(404, 'Not Found');
      return {
        status: 200,
        json: {
          name: branch,
          commit: { sha: tip, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${tip}` },
          protected: false,
          protection: { enabled: false },
        },
      };
    }
    return err(404, 'Not Found');
  }

  if (sub === 'commits') {
    if (method === 'GET' && tail.length === 0) {
      const ref = ctx.query.get('sha') ?? repo.defaultBranch;
      const tip = branchTip(repo, ref) ?? repo.git.ref(`refs/tags/${ref}`);
      if (!tip) return { status: 200, json: [] };
      const shas = walkCommits(repo.git, tip);
      const items = shas.map((s) => commitJson(repo, s)).filter((c): c is Record<string, unknown> => c !== null);
      const { page, link } = paginate(items, ctx);
      return withLink({ status: 200, json: page }, link);
    }
    if (method === 'GET' && tail.length === 1) {
      const sha = decodeURIComponent(tail[0]);
      const obj = commitJson(repo, sha);
      if (!obj) return err(404, 'Not Found');
      return { status: 200, json: obj };
    }
    return err(404, 'Not Found');
  }

  if (sub === 'contents') {
    const path = tail.map((t) => decodeURIComponent(t)).join('/');
    const ref = ctx.query.get('ref') ?? repo.defaultBranch;
    if (method === 'GET') {
      const found2 = getContents(repo, ref, path);
      if (found2 === null) return err(404, 'Not Found');
      if (Array.isArray(found2)) {
        return { status: 200, json: found2.map((e) => contentsEntryJson(repo, e)) };
      }
      return { status: 200, json: contentsEntryJson(repo, found2) };
    }
    if (method === 'PUT') {
      if (!isObj(ctx.body)) return err(400, 'Problems parsing JSON');
      const content = str(ctx.body.content);
      if (content === '') return { status: 422, json: { message: 'Validation Failed', errors: [{ resource: 'Contents', field: 'content', code: 'missing_field' }] } };
      const branch = str(ctx.body.branch, repo.defaultBranch) || repo.defaultBranch;
      const sha = typeof ctx.body.sha === 'string' ? ctx.body.sha : undefined;
      if (sha !== undefined) {
        const current = getContents(repo, branch, path);
        if (current && !Array.isArray(current) && current.sha !== sha) {
          return err(409, 'sha does not match the current file');
        }
        if (current && !Array.isArray(current) && current.sha === sha) {
          // Update.
        } else if (!current) {
          return err(409, 'sha does not match the current file');
        }
      } else {
        const current = getContents(repo, branch, path);
        if (current && !Array.isArray(current)) return err(409, 'sha is required to update a file');
      }
      const message = str(ctx.body.message, `Update ${path}`);
      const { sha: commitSha, created } = putContents(repo, branch, path, content, message);
      const entry = getContents(repo, branch, path);
      return {
        status: created ? 201 : 200,
        json: {
          content: entry && !Array.isArray(entry) ? contentsEntryJson(repo, entry) : null,
          commit: { sha: commitSha, message, author: { name: VIEWER_LOGIN, email: 'adaiversen@users.noreply.github.com', date: trialNowIso() }, committer: { name: VIEWER_LOGIN, email: 'adaiversen@users.noreply.github.com', date: trialNowIso() } },
        },
      };
    }
    if (method === 'DELETE') {
      if (!isObj(ctx.body)) return err(400, 'Problems parsing JSON');
      const branch = str(ctx.body.branch, repo.defaultBranch) || repo.defaultBranch;
      const sha = typeof ctx.body.sha === 'string' ? ctx.body.sha : undefined;
      const current = getContents(repo, branch, path);
      if (!current || Array.isArray(current)) return err(404, 'Not Found');
      if (sha !== undefined && current.sha !== sha) return err(409, 'sha does not match the current file');
      const message = str(ctx.body.message, `Delete ${path}`);
      const result = deleteContents(repo, branch, path, message);
      if (!result) return err(404, 'Not Found');
      return { status: 200, json: { content: null, commit: { sha: result.sha, message } } };
    }
    return err(404, 'Not Found');
  }

  if (sub === 'readme' && method === 'GET') {
    const ref = ctx.query.get('ref') ?? repo.defaultBranch;
    for (const candidate of ['README.md', 'README', 'readme.md']) {
      const found2 = getContents(repo, ref, candidate);
      if (found2 && !Array.isArray(found2)) return { status: 200, json: contentsEntryJson(repo, found2) };
    }
    return err(404, 'Not Found');
  }

  if (sub === 'labels') {
    if (method === 'GET' && tail.length === 0) {
      const { page, link } = paginate(Array.from(repo.labels.values()).map((l) => labelJson(l)), ctx);
      return withLink({ status: 200, json: page }, link);
    }
    if (method === 'POST' && tail.length === 0) {
      if (!isObj(ctx.body)) return err(400, 'Problems parsing JSON');
      const name = str(ctx.body.name).trim();
      if (name === '') return { status: 422, json: { message: 'Validation Failed', errors: [{ resource: 'Label', field: 'name', code: 'missing_field' }] } };
      if (repo.labels.has(name)) return { status: 422, json: { message: 'Validation Failed', errors: [{ resource: 'Label', field: 'name', code: 'custom', message: 'already_exists' }] } };
      const label: Label = { name, color: str(ctx.body.color, 'ededed').replace(/^#/, ''), description: str(ctx.body.description) };
      repo.labels.set(name, label);
      return { status: 201, json: labelJson(label) };
    }
    if (tail.length === 1) {
      const name = decodeURIComponent(tail[0]);
      const label = repo.labels.get(name);
      if (method === 'GET') {
        if (!label) return err(404, 'Not Found');
        return { status: 200, json: labelJson(label) };
      }
      if (method === 'PATCH') {
        if (!label) return err(404, 'Not Found');
        if (!isObj(ctx.body)) return err(400, 'Problems parsing JSON');
        if (typeof ctx.body.color === 'string') label.color = ctx.body.color.replace(/^#/, '');
        if (typeof ctx.body.description === 'string') label.description = ctx.body.description;
        if (typeof ctx.body.name === 'string' && ctx.body.name.trim() !== '' && ctx.body.name !== name) {
          repo.labels.delete(name);
          label.name = ctx.body.name.trim();
          repo.labels.set(label.name, label);
        }
        return { status: 200, json: labelJson(label) };
      }
      if (method === 'DELETE') {
        if (!label) return err(404, 'Not Found');
        repo.labels.delete(name);
        return { status: 204, json: null };
      }
    }
    return err(404, 'Not Found');
  }

  if (sub === 'issues') {
    return handleIssues(ctx, repo, tail);
  }

  if (sub === 'pulls') {
    return handlePulls(ctx, repo, tail);
  }

  if (sub === 'git' && tail.length >= 1 && tail[0] === 'refs') {
    // /git/refs and /git/refs/{ref...}
    // POST creates a reference (branch or tag) at a commit the store holds.
    if (method === 'POST' && tail.length === 1) {
      if (!isObj(ctx.body)) return err(400, 'Problems parsing JSON');
      const ref = str(ctx.body.ref).trim();
      const sha = str(ctx.body.sha).trim();
      if (ref === '' || sha === '') {
        return { status: 422, json: { message: 'Validation Failed', errors: [{ resource: 'Reference', field: 'ref', code: 'missing_field' }] } };
      }
      if (!/^refs\//.test(ref)) {
        return { status: 422, json: { message: 'Validation Failed', errors: [{ resource: 'Reference', field: 'ref', code: 'invalid', message: 'ref must start with refs/' }] } };
      }
      if (!repo.git.has(sha)) {
        return { status: 422, json: { message: 'Validation Failed', errors: [{ resource: 'Reference', field: 'sha', code: 'invalid', message: `No commit found for SHA: ${sha}` }] } };
      }
      if (repo.git.ref(ref)) {
        return { status: 422, json: { message: 'Validation Failed', errors: [{ resource: 'Reference', field: 'ref', code: 'custom', message: 'Reference already exists' }] } };
      }
      repo.git.setRef(ref, sha);
      return {
        status: 201,
        json: {
          ref,
          node_id: `REF_${Buffer.from(`ref:${ref}`).toString('base64url')}`,
          url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref}`,
          object: { sha, type: 'commit', url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` },
        },
      };
    }
    // PATCH updates a reference (optionally forcing a non-fast-forward).
    if (method === 'PATCH' && tail.length > 1) {
      if (!isObj(ctx.body)) return err(400, 'Problems parsing JSON');
      const refPath = `refs/${tail.slice(1).map((t) => decodeURIComponent(t)).join('/')}`;
      const current = repo.git.ref(refPath);
      if (!current) return err(404, 'Not Found');
      const sha = str(ctx.body.sha).trim();
      if (sha === '' || !repo.git.has(sha)) {
        return { status: 422, json: { message: 'Validation Failed', errors: [{ resource: 'Reference', field: 'sha', code: 'invalid' }] } };
      }
      const force = ctx.body.force === true;
      if (!force && !isAncestor(repo.git, current, sha)) {
        return { status: 422, json: { message: 'Validation Failed', errors: [{ resource: 'Reference', field: 'sha', code: 'custom', message: 'Update is not a fast forward' }] } };
      }
      repo.git.setRef(refPath, sha);
      return {
        status: 200,
        json: {
          ref: refPath,
          node_id: `REF_${Buffer.from(`ref:${refPath}`).toString('base64url')}`,
          url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${refPath}`,
          object: { sha, type: 'commit', url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` },
        },
      };
    }
    // DELETE removes a reference.
    if (method === 'DELETE' && tail.length > 1) {
      const refPath = `refs/${tail.slice(1).map((t) => decodeURIComponent(t)).join('/')}`;
      if (!repo.git.ref(refPath)) return err(404, 'Not Found');
      repo.git.deleteRef(refPath);
      return { status: 204, json: null };
    }
    if (method !== 'GET') return err(404, 'Not Found');
    const refRest = tail.slice(1).map((t) => decodeURIComponent(t)).join('/');
    const refPath = refRest === '' ? '' : `refs/${refRest}`;
    if (refPath === '') {
      const items = Array.from(repo.git.refs.entries()).map(([name, oid]) => ({
        ref: name,
        node_id: `REF_${Buffer.from(`ref:${name}`).toString('base64url')}`,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${name}`,
        object: { sha: oid, type: 'commit', url: '' },
      }));
      return { status: 200, json: items };
    }
    const oid = repo.git.ref(refPath);
    if (!oid) return err(404, 'Not Found');
    return {
      status: 200,
      json: {
        ref: refPath,
        node_id: `REF_${Buffer.from(`ref:${refPath}`).toString('base64url')}`,
        url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${refPath}`,
        object: { sha: oid, type: 'commit', url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${oid}` },
      },
    };
  }

  if (sub === 'git' && tail.length >= 1 && tail[0] === 'ref') {
    if (method !== 'GET') return err(404, 'Not Found');
    const refPath = `refs/${tail.slice(1).map((t) => decodeURIComponent(t)).join('/')}`;
    const oid = repo.git.ref(refPath);
    if (!oid) return err(404, 'Not Found');
    return { status: 200, json: { ref: refPath, object: { sha: oid, type: 'commit' } } };
  }

  if (sub === 'compare' && method === 'GET' && tail.length === 1) {
    const range = decodeURIComponent(tail[0]);
    const m = /^(.+)\.\.\.(.+)$/.exec(range);
    if (!m) return err(404, 'Not Found');
    const baseTip = branchTip(repo, m[1]) ?? repo.git.ref(`refs/tags/${m[1]}`);
    const headTip = branchTip(repo, m[2]) ?? repo.git.ref(`refs/tags/${m[2]}`);
    if (!baseTip || !headTip) return err(404, 'Not Found');
    const baseSet = new Set(walkCommits(repo.git, baseTip));
    const headCommits = walkCommits(repo.git, headTip).filter((c) => !baseSet.has(c));
    const headSet = new Set(walkCommits(repo.git, headTip));
    const behind = walkCommits(repo.git, baseTip).filter((c) => !headSet.has(c));
    const files = diffTreesForCompare(repo, baseTip, headTip);
    const status = headCommits.length === 0 && behind.length === 0 ? 'identical' : headCommits.length > 0 && behind.length === 0 ? 'ahead' : behind.length > 0 && headCommits.length === 0 ? 'behind' : 'diverged';
    return {
      status: 200,
      json: {
        url: '',
        html_url: '',
        permalink_url: '',
        base_commit: commitJson(repo, baseTip),
        merge_base_commit: null,
        status,
        ahead_by: headCommits.length,
        behind_by: behind.length,
        total_commits: headCommits.length,
        commits: headCommits.map((c) => commitJson(repo, c)),
        files,
      },
    };
  }

  return err(404, 'Not Found');
}

function diffTreesForCompare(repo: Repo, baseTip: string, headTip: string): Array<Record<string, unknown>> {
  const baseCommit = repo.git.get(baseTip);
  const headCommit = repo.git.get(headTip);
  if (!baseCommit || !headCommit) return [];
  const baseTree = flattenTreeLocal(repo, parseCommit(baseCommit.data).tree);
  const headTree = flattenTreeLocal(repo, parseCommit(headCommit.data).tree);
  const names = new Set<string>([...baseTree.keys(), ...headTree.keys()]);
  const out: Array<Record<string, unknown>> = [];
  for (const name of Array.from(names).sort()) {
    const b = baseTree.get(name);
    const h = headTree.get(name);
    if (h && !b) out.push({ sha: h.oid, filename: name, status: 'added', additions: 1, deletions: 0, changes: 1 });
    else if (!h && b) out.push({ sha: b.oid, filename: name, status: 'removed', additions: 0, deletions: 1, changes: 1 });
    else if (h && b && h.oid !== b.oid) out.push({ sha: h.oid, filename: name, status: 'modified', additions: 1, deletions: 1, changes: 2 });
  }
  return out;
}

function flattenTreeLocal(repo: Repo, treeOid: string): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const obj = repo.git.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    if (e.mode === '40000') {
      for (const [p, v] of flattenTreeLocal(repo, e.oid)) out.set(`${e.name}/${p}`, v);
    } else {
      out.set(e.name, { mode: e.mode, oid: e.oid });
    }
  }
  return out;
}

function contentsEntryJson(repo: Repo, e: { type: 'file' | 'dir'; name: string; path: string; sha: string; size: number; content?: string; encoding?: string }): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  const base = {
    type: e.type,
    name: e.name,
    path: e.path,
    sha: e.sha,
    size: e.size,
    url: `/api/v3/repos/${fullName}/contents/${e.path}`,
    html_url: `https://github.com/${fullName}/blob/${repo.defaultBranch}/${e.path}`,
    git_url: `/api/v3/repos/${fullName}/git/blobs/${e.sha}`,
    download_url: e.type === 'file' ? `https://raw.githubusercontent.com/${fullName}/${repo.defaultBranch}/${e.path}` : null,
    _links: { self: `/api/v3/repos/${fullName}/contents/${e.path}`, git: `/api/v3/repos/${fullName}/git/blobs/${e.sha}`, html: `https://github.com/${fullName}/blob/${repo.defaultBranch}/${e.path}` },
  };
  if (e.type === 'file') return { ...base, content: e.content ?? '', encoding: e.encoding ?? 'base64' };
  return base;
}

function handleIssues(ctx: RestContext, repo: Repo, tail: string[]): RestResult {
  const { forge, method } = ctx;
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const labelsParam = ctx.query.get('labels');
      let issues = Array.from(repo.issues.values());
      if (state !== 'all') issues = issues.filter((i) => i.state === state);
      if (labelsParam) {
        const wanted = labelsParam.split(',').map((s) => s.trim()).filter(Boolean);
        issues = issues.filter((i) => wanted.every((w) => i.labels.includes(w)));
      }
      issues = sortIssues(issues, ctx.query.get('sort') ?? 'created', ctx.query.get('direction') ?? 'desc');
      const { page, link } = paginate(issues.map((i) => issueJson(repo, i)), ctx);
      return withLink({ status: 200, json: page }, link);
    }
    if (method === 'POST') {
      if (!isObj(ctx.body)) return err(400, 'Problems parsing JSON');
      const title = str(ctx.body.title).trim();
      if (title === '') {
        return { status: 422, json: { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'title', code: 'missing_field' }] } };
      }
      const rawLabels = Array.isArray(ctx.body.labels) ? ctx.body.labels : [];
      const labels: string[] = [];
      for (const l of rawLabels) {
        const name = typeof l === 'string' ? l : isObj(l) ? str(l.name) : '';
        if (name === '') continue;
        if (!repo.labels.has(name)) {
          return { status: 422, json: { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'labels', code: 'invalid', message: `Label '${name}' does not exist` }] } };
        }
        labels.push(name);
      }
      const issue = createIssue(forge, repo, title, str(ctx.body.body), labels, VIEWER_LOGIN);
      return { status: 201, json: issueJson(repo, issue) };
    }
    return err(404, 'Not Found');
  }

  if (tail.length === 1 && tail[0] === 'comments' && method === 'GET') {
    const all: Array<Record<string, unknown>> = [];
    for (const issue of Array.from(repo.issues.values()).sort((a, b) => a.number - b.number)) {
      for (const c of issue.comments) all.push(commentJson(repo, issue, c));
    }
    const { page, link } = paginate(all, ctx);
    return withLink({ status: 200, json: page }, link);
  }

  const number = parseInt(tail[0], 10);
  if (Number.isNaN(number)) return err(404, 'Not Found');
  const issue = repo.issues.get(number);
  if (tail.length === 1) {
    if (!issue) return err(404, 'Not Found');
    if (method === 'GET') return { status: 200, json: issueJson(repo, issue) };
    if (method === 'PATCH') {
      if (!isObj(ctx.body)) return err(400, 'Problems parsing JSON');
      if (typeof ctx.body.title === 'string') issue.title = ctx.body.title;
      if (typeof ctx.body.body === 'string') issue.body = ctx.body.body;
      if (Array.isArray(ctx.body.labels)) {
        const labels: string[] = [];
        for (const l of ctx.body.labels) {
          const name = typeof l === 'string' ? l : isObj(l) ? str(l.name) : '';
          if (name === '') continue;
          if (!repo.labels.has(name)) {
            return { status: 422, json: { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'labels', code: 'invalid' }] } };
          }
          labels.push(name);
        }
        issue.labels = labels;
      }
      if (typeof ctx.body.state === 'string' && (ctx.body.state === 'open' || ctx.body.state === 'closed')) {
        issue.state = ctx.body.state;
        issue.closedAt = ctx.body.state === 'closed' ? trialNowIso() : null;
      }
      issue.updatedAt = trialNowIso();
      return { status: 200, json: issueJson(repo, issue) };
    }
    return err(404, 'Not Found');
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    if (!issue) return err(404, 'Not Found');
    if (method === 'GET') {
      const { page, link } = paginate(issue.comments.map((c) => commentJson(repo, issue, c)), ctx);
      return withLink({ status: 200, json: page }, link);
    }
    if (method === 'POST') {
      if (!isObj(ctx.body)) return err(400, 'Problems parsing JSON');
      const body = str(ctx.body.body).trim();
      if (body === '') return { status: 422, json: { message: 'Validation Failed', errors: [{ resource: 'IssueComment', field: 'body', code: 'missing_field' }] } };
      const comment = addIssueComment(forge, issue, body, VIEWER_LOGIN);
      return { status: 201, json: commentJson(repo, issue, comment) };
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

function handlePulls(ctx: RestContext, repo: Repo, tail: string[]): RestResult {
  const { forge, method } = ctx;
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let prs = Array.from(repo.prs.values());
      if (state !== 'all') prs = prs.filter((p) => p.state === state);
      prs.sort((a, b) => b.number - a.number);
      const { page, link } = paginate(prs.map((p) => prJson(repo, p)), ctx);
      return withLink({ status: 200, json: page }, link);
    }
    if (method === 'POST') {
      if (!isObj(ctx.body)) return err(400, 'Problems parsing JSON');
      const title = str(ctx.body.title).trim();
      if (title === '') {
        return { status: 422, json: { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'title', code: 'missing_field' }] } };
      }
      const headRaw = str(ctx.body.head).trim();
      const baseRaw = str(ctx.body.base, repo.defaultBranch).trim() || repo.defaultBranch;
      const head = headRaw.includes(':') ? headRaw.split(':').slice(1).join(':') : headRaw;
      const base = baseRaw.includes(':') ? baseRaw.split(':').slice(1).join(':') : baseRaw;
      if (!branchTip(repo, head)) {
        return { status: 422, json: { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid', message: `Head branch '${head}' does not exist` }] } };
      }
      if (!branchTip(repo, base)) {
        return { status: 422, json: { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'base', code: 'invalid', message: `Base branch '${base}' does not exist` }] } };
      }
      const existing = Array.from(repo.prs.values()).find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
      if (existing) {
        return { status: 422, json: { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'head', code: 'custom', message: 'A pull request already exists' }] } };
      }
      repo.prSeq += 1;
      forge.prIdSeq += 1;
      const now = trialNowIso();
      const pr: PullRequest = {
        id: forge.prIdSeq,
        number: repo.prSeq,
        title,
        body: str(ctx.body.body),
        state: 'open',
        merged: false,
        headRef: head,
        baseRef: base,
        user: VIEWER_LOGIN,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        mergedAt: null,
        mergeCommitSha: null,
        draft: ctx.body.draft === true,
      };
      repo.prs.set(pr.number, pr);
      return { status: 201, json: prJson(repo, pr) };
    }
    return err(404, 'Not Found');
  }

  const number = parseInt(tail[0], 10);
  if (Number.isNaN(number)) return err(404, 'Not Found');
  const pr = repo.prs.get(number);

  if (tail.length === 1) {
    if (!pr) return err(404, 'Not Found');
    if (method === 'GET') return { status: 200, json: prJson(repo, pr) };
    if (method === 'PATCH') {
      if (!isObj(ctx.body)) return err(400, 'Problems parsing JSON');
      if (typeof ctx.body.title === 'string') pr.title = ctx.body.title;
      if (typeof ctx.body.body === 'string') pr.body = ctx.body.body;
      if (typeof ctx.body.state === 'string' && (ctx.body.state === 'open' || ctx.body.state === 'closed')) {
        pr.state = ctx.body.state;
        pr.closedAt = ctx.body.state === 'closed' ? trialNowIso() : null;
        if (ctx.body.state === 'open') pr.merged = false;
      }
      pr.updatedAt = trialNowIso();
      return { status: 200, json: prJson(repo, pr) };
    }
    return err(404, 'Not Found');
  }

  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    if (!pr) return err(404, 'Not Found');
    const headTip = branchTip(repo, pr.headRef) ?? ZERO_OID;
    const items = prFiles(repo, pr).map((f) => ({
      sha: headTip,
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      changes: f.changes,
      blob_url: `https://github.com/${repo.owner}/${repo.name}/blob/${headTip}/${f.filename}`,
      raw_url: `https://github.com/${repo.owner}/${repo.name}/raw/${headTip}/${f.filename}`,
      contents_url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${f.filename}?ref=${headTip}`,
      patch: f.patch,
    }));
    const { page, link } = paginate(items, ctx);
    return withLink({ status: 200, json: page }, link);
  }

  if (tail.length === 2 && tail[1] === 'commits' && method === 'GET') {
    if (!pr) return err(404, 'Not Found');
    const items = prCommits(repo, pr).map((c) => commitJson(repo, c)).filter((c): c is Record<string, unknown> => c !== null);
    const { page, link } = paginate(items, ctx);
    return withLink({ status: 200, json: page }, link);
  }

  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (!pr) return err(404, 'Not Found');
    if (pr.state !== 'open') {
      return { status: 405, json: { message: 'Pull request is already closed' } };
    }
    if (!prMergeable(repo, pr)) {
      return { status: 405, json: { message: 'Merge conflict' } };
    }
    const commitTitle = isObj(ctx.body) && typeof ctx.body.commit_title === 'string' ? ctx.body.commit_title : undefined;
    const result = mergePullRequest(forge, repo, pr, commitTitle);
    if ('error' in result) return { status: 405, json: { message: result.error } };
    return { status: 200, json: { sha: result.sha, merged: true, message: 'Pull request successfully merged' } };
  }

  if (tail.length === 2 && tail[1] === 'reviews') {
    if (!pr) return err(404, 'Not Found');
    if (method === 'GET') return { status: 200, json: [] };
    if (method === 'POST') {
      forge.prIdSeq += 1;
      return {
        status: 201,
        json: {
          id: forge.prIdSeq,
          node_id: `PRR_${forge.prIdSeq}`,
          user: userJson(VIEWER_LOGIN),
          body: isObj(ctx.body) ? str(ctx.body.body) : '',
          state: isObj(ctx.body) ? str(ctx.body.event, 'COMMENT') : 'COMMENT',
          html_url: '',
          pull_request_url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
          submitted_at: trialNowIso(),
          commit_id: branchTip(repo, pr.headRef) ?? ZERO_OID,
        },
      };
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}
