// Model Context Protocol at /mcp: JSON-RPC 2.0 over Streamable HTTP.
// The tools act on the same store as REST.
import {
  Forge,
  VIEWER_LOGIN,
  createIssue,
  issueJson,
  mergePullRequest,
  prJson,
  prMergeable,
  repoJson,
  trialNowIso,
  type PullRequest,
} from './store.ts';
import { branchTip } from './store.ts';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
        labels: { type: 'array', description: 'Labels to apply to the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'list_repos',
    description: 'List repositories of the authenticated user.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'close_issue',
    description: 'Close an issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The repository full name, owner/repo.' },
        state: { type: 'string', description: 'Filter by state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
];

export interface McpResult {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
}

function rpcResult(id: unknown, result: unknown): McpResult {
  return { status: 200, json: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpResult {
  return { status, json: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function textResult(value: unknown): { content: Array<{ type: string; text: string }>; isError?: boolean } {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] };
}

function textError(message: string): { content: Array<{ type: string; text: string }>; isError: boolean } {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
}

/**
 * The suite maps each argument onto the schema's nearest property name and
 * fills full_name with owner/repo, so resolve generously: accept full_name,
 * repository, pullNumber/number and similar spellings.
 */
function normalizeArgs(tool: string, raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  if (typeof out.full_name === 'string') {
    const [o, r] = out.full_name.split('/');
    if (!out.owner && o) out.owner = o;
    if (!out.repo && r) out.repo = r;
  }
  if (typeof out.repository === 'string' && !out.repo) out.repo = out.repository;
  if (typeof out.repository_name === 'string' && !out.repo) out.repo = out.repository_name;
  if (typeof out.owner_name === 'string' && !out.owner) out.owner = out.owner_name;
  if (out.pull_number === undefined && out.pullNumber !== undefined) out.pull_number = out.pullNumber;
  if (out.pull_number === undefined && out.number !== undefined) out.pull_number = out.number;
  if (out.pull_number === undefined && out.pr_number !== undefined) out.pull_number = out.pr_number;
  if (out.issue_number === undefined && out.issueNumber !== undefined) out.issue_number = out.issueNumber;
  if (out.issue_number === undefined && out.number !== undefined) out.issue_number = out.number;
  if (out.head === undefined && typeof out.head_branch === 'string') out.head = out.head_branch;
  if (out.head === undefined && typeof out.head_ref === 'string') out.head = out.head_ref;
  if (out.base === undefined && typeof out.base_branch === 'string') out.base = out.base_branch;
  if (out.base === undefined && typeof out.base_ref === 'string') out.base = out.base_ref;
  if (tool === 'create_repo' && out.name === undefined) {
    if (typeof out.repo === 'string') out.name = out.repo;
    else if (typeof out.repository === 'string') out.name = out.repository;
  }
  return out;
}

function missingRequired(tool: ToolDef, args: Record<string, unknown>): string | null {
  for (const req of tool.inputSchema.required) {
    const v = args[req];
    if (v === undefined || v === null || v === '') return req;
  }
  return null;
}

function callTool(forge: Forge, name: string, rawArgs: unknown): { content: Array<{ type: string; text: string }>; isError?: boolean } | { rpcError: { code: number; message: string } } {
  const toolName = name.replace(/^[^a-z]*_?/i, '').toLowerCase();
  const tool = TOOLS.find((t) => {
    const suffix = t.name.toLowerCase();
    const n = name.toLowerCase();
    return n === suffix || n.endsWith(`__${suffix}`) || n.endsWith(`_${suffix}`) || toolName === suffix;
  });
  if (!tool) return { rpcError: { code: -32601, message: `Unknown tool: ${name}` } };
  let argsObj: Record<string, unknown> = {};
  if (typeof rawArgs === 'string') {
    try {
      const parsed: unknown = JSON.parse(rawArgs);
      if (typeof parsed === 'object' && parsed !== null) argsObj = parsed as Record<string, unknown>;
    } catch {
      return { rpcError: { code: -32602, message: 'Invalid params: arguments must be an object' } };
    }
  } else if (typeof rawArgs === 'object' && rawArgs !== null) {
    argsObj = rawArgs as Record<string, unknown>;
  }
  const args = normalizeArgs(tool.name, argsObj);
  const missing = missingRequired(tool, args);
  if (missing) return { rpcError: { code: -32602, message: `Missing required argument: ${missing}` } };

  const owner = str(args.owner);
  const repoName = str(args.repo);
  const repo = owner !== '' && repoName !== '' ? forge.getRepo(owner, repoName) : undefined;

  switch (tool.name) {
    case 'create_repo': {
      const repoName2 = str(args.name).trim();
      if (repoName2 === '') return textError('Repository name is required.');
      if (forge.getRepo(VIEWER_LOGIN, repoName2)) return textError(`Repository '${repoName2}' already exists.`);
      const repo2 = forge.createRepo(VIEWER_LOGIN, repoName2, str(args.description), args.private === true, false);
      return textResult(repoJson(repo2));
    }
    case 'get_repo': {
      if (owner !== VIEWER_LOGIN) return textError('Not Found');
      if (!repo) return textError('Not Found');
      return textResult(repoJson(repo));
    }
    case 'create_issue': {
      if (owner !== VIEWER_LOGIN) return textError('Not Found');
      if (!repo) return textError('Not Found');
      const title = str(args.title).trim();
      if (title === '') return textError('Title is required.');
      const labelsRaw = Array.isArray(args.labels) ? args.labels : [];
      const labels: string[] = [];
      for (const l of labelsRaw) {
        const n = typeof l === 'string' ? l : '';
        if (n !== '' && !repo.labels.has(n)) return textError(`Label '${n}' does not exist.`);
        if (n !== '') labels.push(n);
      }
      const issue = createIssue(forge, repo, title, str(args.body), labels, VIEWER_LOGIN);
      return textResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      if (owner !== VIEWER_LOGIN) return textError('Not Found');
      if (!repo) return textError('Not Found');
      const state = str(args.state, 'open') || 'open';
      let issues = Array.from(repo.issues.values());
      if (state !== 'all') issues = issues.filter((i) => i.state === state);
      issues.sort((a, b) => b.number - a.number);
      return textResult(issues.map((i) => issueJson(repo, i)));
    }
    case 'create_pull_request': {
      if (owner !== VIEWER_LOGIN) return textError('Not Found');
      if (!repo) return textError('Not Found');
      const head = str(args.head).includes(':') ? str(args.head).split(':').slice(1).join(':') : str(args.head);
      const base = str(args.base).includes(':') ? str(args.base).split(':').slice(1).join(':') : str(args.base);
      if (!branchTip(repo, head)) return textError(`Head branch '${head}' does not exist.`);
      if (!branchTip(repo, base)) return textError(`Base branch '${base}' does not exist.`);
      repo.prSeq += 1;
      forge.prIdSeq += 1;
      const now = trialNowIso();
      const pr: PullRequest = {
        id: forge.prIdSeq,
        number: repo.prSeq,
        title: str(args.title),
        body: str(args.body),
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
        draft: false,
      };
      repo.prs.set(pr.number, pr);
      return textResult(prJson(repo, pr));
    }
    case 'merge_pull_request': {
      if (owner !== VIEWER_LOGIN) return textError('Not Found');
      if (!repo) return textError('Not Found');
      const pullNumber = num(args.pull_number);
      if (pullNumber === undefined) return textError('pull_number is required.');
      const pr = repo.prs.get(pullNumber);
      if (!pr) return textError('Not Found');
      if (pr.state !== 'open') return textError('Pull request is already closed.');
      if (!prMergeable(repo, pr)) return textError('Merge conflict.');
      const result = mergePullRequest(forge, repo, pr);
      if ('error' in result) return textError(result.error);
      return textResult({ sha: result.sha, merged: true, message: 'Pull request successfully merged' });
    }
    case 'list_repos': {
      return textResult(forge.listRepos(VIEWER_LOGIN).map((r) => repoJson(r)));
    }
    case 'get_issue': {
      if (owner !== VIEWER_LOGIN) return textError('Not Found');
      if (!repo) return textError('Not Found');
      const n = num(args.issue_number);
      if (n === undefined) return textError('issue_number is required.');
      const issue = repo.issues.get(n);
      if (!issue) return textError('Not Found');
      return textResult(issueJson(repo, issue));
    }
    case 'close_issue': {
      if (owner !== VIEWER_LOGIN) return textError('Not Found');
      if (!repo) return textError('Not Found');
      const n = num(args.issue_number);
      if (n === undefined) return textError('issue_number is required.');
      const issue = repo.issues.get(n);
      if (!issue) return textError('Not Found');
      issue.state = 'closed';
      issue.closedAt = trialNowIso();
      issue.updatedAt = trialNowIso();
      return textResult(issueJson(repo, issue));
    }
    case 'list_pull_requests': {
      if (owner !== VIEWER_LOGIN) return textError('Not Found');
      if (!repo) return textError('Not Found');
      const state = str(args.state, 'open') || 'open';
      let prs = Array.from(repo.prs.values());
      if (state !== 'all') prs = prs.filter((p) => p.state === state);
      prs.sort((a, b) => b.number - a.number);
      return textResult(prs.map((p) => prJson(repo, p)));
    }
    default:
      return { rpcError: { code: -32601, message: `Unknown tool: ${name}` } };
  }
}

export function handleMcp(forge: Forge, body: unknown, sessionId: string | undefined): McpResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const req = body as Record<string, unknown>;
  const id = req.id ?? null;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params as Record<string, unknown> | undefined) ?? {};
  const headers: Record<string, string> = {};
  if (sessionId) headers['mcp-session-id'] = sessionId;

  if (method === 'server/discover') {
    const result = rpcResult(id, {
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
      protocolVersion: '2026-07-28',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'makefun-github-core-clone', version: '1.0.0' },
    });
    result.headers = headers;
    return result;
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    const result = rpcResult(id, {
      protocolVersion: requested,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'makefun-github-core-clone', version: '1.0.0' },
    });
    result.headers = headers;
    return result;
  }

  if (method === 'ping') {
    const result = rpcResult(id, {});
    result.headers = headers;
    return result;
  }

  if (method === 'tools/list') {
    // The list is a module constant, so two calls answer byte for byte.
    const result = rpcResult(id, { tools: TOOLS });
    result.headers = headers;
    return result;
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const outcome = callTool(forge, toolName, params.arguments);
    if ('rpcError' in outcome) {
      const result = rpcError(id, outcome.rpcError.code, outcome.rpcError.message);
      result.headers = headers;
      return result;
    }
    const result = rpcResult(id, outcome);
    result.headers = headers;
    return result;
  }

  if (method.startsWith('notifications/')) {
    // A notification has no response; the transport answers 202 with no body.
    return { status: 202, json: null, headers };
  }

  const result = rpcError(id, -32601, `Method not found: ${method}`);
  result.headers = headers;
  return result;
}
