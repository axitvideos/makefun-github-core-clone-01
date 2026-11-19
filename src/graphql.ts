// GitHub GraphQL v4 at /api/graphql: a small parser and executor for the
// documents gh and github-mcp-server send, plus introspection.
import {
  Forge,
  VIEWER_LOGIN,
  addIssueComment,
  branchTip,
  createIssue,
  issueNodeId,
  mergePullRequest,
  prCommits,
  prFiles,
  prMergeable,
  prNodeId,
  repoNodeId,
  trialNowIso,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';
import { parseCommit } from './gitcore.ts';

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'eof' };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (src[i + 1] === '"' && src[i + 2] === '"') {
        // Block string.
        const end = src.indexOf('"""', i + 3);
        if (end === -1) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: src.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') {
          const e = src[j + 1];
          if (e === 'n') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === 'r') out += '\r';
          else if (e === 'u') {
            out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += e;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      if (j >= src.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      let isFloat = false;
      if (src[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < src.length && /[0-9]/.test(src[j])) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < src.length && isNameChar(src[j])) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------
// AST + parser
// ---------------------------------------------------------------------------

export interface ValueNode {
  kind: 'variable' | 'string' | 'int' | 'float' | 'boolean' | 'null' | 'enum' | 'list' | 'object';
  name?: string;
  value?: string | number | boolean;
  items?: ValueNode[];
  fields?: Array<{ name: string; value: ValueNode }>;
}

export interface SelectionNode {
  kind: 'field' | 'fragmentSpread' | 'inlineFragment';
  alias?: string;
  name?: string;
  args?: Array<{ name: string; value: ValueNode }>;
  selections?: SelectionNode[];
  typeCondition?: string;
}

export interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name?: string;
  variables: Array<{ name: string; type: string; defaultValue?: ValueNode }>;
  selections: SelectionNode[];
}

export interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

type DefinitionNode = OperationNode | FragmentNode;

class Parser {
  private pos = 0;
  private tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const t = this.tokens[this.pos];
    this.pos += 1;
    return t;
  }

  private expectPunct(v: string): void {
    const t = this.next();
    if (t.kind !== 'punct' || t.value !== v) throw new Error(`expected ${v}`);
  }

  private expectName(want?: string): string {
    const t = this.next();
    if (t.kind !== 'name') throw new Error('expected name');
    if (want !== undefined && t.value !== want) throw new Error(`expected ${want}`);
    return t.value;
  }

  parseDocument(): DefinitionNode[] {
    const defs: DefinitionNode[] = [];
    while (this.peek().kind !== 'eof') {
      defs.push(this.parseDefinition());
    }
    return defs;
  }

  private parseDefinition(): DefinitionNode {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '{') {
      return { kind: 'operation', operation: 'query', variables: [], selections: this.parseSelectionSet() };
    }
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
      const op = this.next().value as 'query' | 'mutation' | 'subscription';
      let name: string | undefined;
      if (this.peek().kind === 'name') name = this.next().value as string;
      const variables = this.parseVariableDefinitions();
      return { kind: 'operation', operation: op, name, variables, selections: this.parseSelectionSet() };
    }
    if (t.kind === 'name' && t.value === 'fragment') {
      this.next();
      const name = this.expectName();
      this.expectName('on');
      const typeCondition = this.expectName();
      return { kind: 'fragment', name, typeCondition, selections: this.parseSelectionSet() };
    }
    throw new Error('unexpected definition');
  }

  private parseVariableDefinitions(): Array<{ name: string; type: string; defaultValue?: ValueNode }> {
    const vars: Array<{ name: string; type: string; defaultValue?: ValueNode }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        if (this.peek().kind === 'punct' && this.peek().value === '$') this.next();
        const name = this.expectName();
        this.expectPunct(':');
        const type = this.parseType();
        let defaultValue: ValueNode | undefined;
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        vars.push({ name, type, defaultValue });
      }
      this.next();
    }
    return vars;
  }

  private parseType(): string {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '[') {
      const inner = this.parseType();
      this.expectPunct(']');
      let out = `[${inner}]`;
      if (this.peek().kind === 'punct' && this.peek().value === '!') {
        this.next();
        out += '!';
      }
      return out;
    }
    if (t.kind !== 'name') throw new Error('expected type');
    let out = t.value;
    if (this.peek().kind === 'punct' && this.peek().value === '!') {
      this.next();
      out += '!';
    }
    return out;
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const sels: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      sels.push(this.parseSelection());
    }
    this.next();
    return sels;
  }

  private parseSelection(): SelectionNode {
    const t = this.peek();
    if (t.kind === 'punct' && t.value === '...') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next.kind === 'name') {
        const name = this.next().value as string;
        this.skipDirectives();
        return { kind: 'fragmentSpread', name };
      }
      this.skipDirectives();
      return { kind: 'inlineFragment', selections: this.parseSelectionSet() };
    }
    const nameOrAlias = this.expectName();
    let alias: string | undefined;
    let name = nameOrAlias;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = nameOrAlias;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.skipDirectives();
    let selections: SelectionNode[] | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): Array<{ name: string; value: ValueNode }> | undefined {
    if (!(this.peek().kind === 'punct' && this.peek().value === '(')) return undefined;
    this.next();
    const args: Array<{ name: string; value: ValueNode }> = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.next();
    return args;
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      this.parseArguments();
    }
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (t.kind === 'punct' && t.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) items.push(this.parseValue());
      this.next();
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (t.kind === 'string') return { kind: 'string', value: t.value };
    if (t.kind === 'int') return { kind: 'int', value: parseInt(t.value, 10) };
    if (t.kind === 'float') return { kind: 'float', value: parseFloat(t.value) };
    if (t.kind === 'name') {
      if (t.value === 'true') return { kind: 'boolean', value: true };
      if (t.value === 'false') return { kind: 'boolean', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    throw new Error('unexpected value');
  }
}

// ---------------------------------------------------------------------------
// Value resolution (variables, literals)
// ---------------------------------------------------------------------------

type Variables = Record<string, unknown>;

function resolveValue(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'variable': {
      const v = variables[node.name as string];
      return v === undefined ? null : v;
    }
    case 'string':
    case 'enum':
      return node.value;
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return (node.items ?? []).map((i) => resolveValue(i, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields ?? []) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
    default:
      return null;
  }
}

function resolveArgs(args: Array<{ name: string; value: ValueNode }> | undefined, variables: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of args ?? []) out[a.name] = resolveValue(a.value, variables);
  return out;
}

// ---------------------------------------------------------------------------
// Introspection schema (the types the suite introspects)
// ---------------------------------------------------------------------------

interface TypeInfo {
  kind: 'OBJECT' | 'ENUM' | 'SCALAR';
  fields?: string[];
  enumValues?: string[];
}

const TYPE_INFO: Record<string, TypeInfo> = {
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body'] },
  PullRequest: { kind: 'OBJECT', fields: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'] },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'databaseId', 'avatarUrl', 'url'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'totalCount', 'pageInfo'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'totalCount', 'pageInfo'] },
  SearchType: { kind: 'ENUM', enumValues: ['CODE', 'COMMIT', 'DISCUSSION', 'ISSUE', 'REPOSITORY', 'USER'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['CONFLICTING', 'MERGEABLE', 'UNKNOWN'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['COMMENTS', 'CREATED_AT', 'UPDATED_AT'] },
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'search', 'node'] },
  Mutation: { kind: 'OBJECT', fields: ['createPullRequest', 'createIssue', 'closeIssue', 'addComment', 'mergePullRequest'] },
};

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface Ctx {
  forge: Forge;
  variables: Variables;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string }>;
}

type Obj = Record<string, unknown> & { __typename: string };

function issueObj(repo: Repo, issue: Issue): Obj {
  return {
    __typename: 'Issue',
    id: issueNodeId(repo, issue),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    author: { __typename: 'User', login: issue.user, id: 1, databaseId: 1, name: issue.user, avatarUrl: '', url: '' },
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository: repoObj(repo),
    _repo: repo,
    _issue: issue,
  };
}

function prObj(repo: Repo, pr: PullRequest): Obj {
  return {
    __typename: 'PullRequest',
    id: prNodeId(repo, pr),
    databaseId: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pr.merged,
    mergeable: prMergeable(repo, pr) ? 'MERGEABLE' : 'CONFLICTING',
    headRefName: pr.headRef,
    baseRefName: pr.baseRef,
    headRefOid: branchTip(repo, pr.headRef) ?? null,
    baseRefOid: branchTip(repo, pr.baseRef) ?? null,
    author: { __typename: 'User', login: pr.user, id: 1, databaseId: 1, name: pr.user, avatarUrl: '', url: '' },
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    closedAt: pr.closedAt,
    mergedAt: pr.mergedAt,
    url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`,
    repository: repoObj(repo),
    _repo: repo,
    _pr: pr,
  };
}

function repoObj(repo: Repo): Obj {
  return {
    __typename: 'Repository',
    id: repoNodeId(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    url: `https://github.com/${repo.owner}/${repo.name}`,
    owner: { __typename: 'User', login: repo.owner, id: 1, databaseId: 1, name: repo.owner, avatarUrl: '', url: '' },
    defaultBranchRef: { __typename: 'Ref', name: repo.defaultBranch, prefix: 'refs/heads/', target: { __typename: 'Commit', oid: branchTip(repo, repo.defaultBranch) ?? '' } },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    hasProjectsEnabled: true,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    _repo: repo,
  };
}

function encodeCursor(n: number): string {
  return Buffer.from(`cursor:${n}`).toString('base64url');
}

function decodeCursor(c: unknown): number | null {
  if (typeof c !== 'string') return null;
  try {
    const s = Buffer.from(c, 'base64url').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(s);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

function connection<T>(nodes: T[], first: unknown, after: unknown): Obj {
  const afterNum = decodeCursor(after);
  let start = 0;
  if (afterNum !== null) {
    const idx = nodes.findIndex((n) => (n as Obj).number === afterNum || (n as Obj).id === afterNum);
    if (idx >= 0) start = idx + 1;
  }
  const count = typeof first === 'number' && first >= 0 ? first : nodes.length;
  const slice = nodes.slice(start, start + count);
  const edges = slice.map((n) => ({ __typename: 'IssueEdge', node: n, cursor: encodeCursor((n as Obj).number as number) }));
  return {
    __typename: 'IssueConnection',
    nodes: slice,
    edges,
    totalCount: nodes.length,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + count < nodes.length,
      hasPreviousPage: start > 0,
      startCursor: edges.length > 0 ? edges[0].cursor : null,
      endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
    },
  };
}

function sortedIssues(repo: Repo, args: Record<string, unknown>): Issue[] {
  let issues = Array.from(repo.issues.values());
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const want = new Set(states.map((s) => String(s).toLowerCase()));
    issues = issues.filter((i) => want.has(i.state));
  }
  const orderBy = (args.orderBy as Record<string, unknown> | undefined) ?? {};
  const field = String(orderBy.field ?? 'CREATED_AT');
  const direction = String(orderBy.direction ?? 'DESC');
  const dir = direction === 'ASC' ? 1 : -1;
  issues.sort((a, b) => {
    let cmp = 0;
    if (field === 'UPDATED_AT') cmp = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
    else if (field === 'COMMENTS') cmp = a.comments.length - b.comments.length;
    else cmp = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    if (cmp === 0) cmp = a.number - b.number;
    return dir * cmp;
  });
  return issues;
}

function findRepoByNodeId(forge: Forge, id: unknown): Repo | undefined {
  if (typeof id !== 'string') return undefined;
  for (const repo of forge.repos.values()) {
    if (repoNodeId(repo) === id) return repo;
  }
  try {
    const decoded = Buffer.from(id.replace(/^R_/, ''), 'base64url').toString('utf8');
    const m = /^repo:([^/]+)\/(.+)$/.exec(decoded);
    if (m) return forge.getRepo(m[1], m[2]);
  } catch {
    // Not our id format.
  }
  return undefined;
}

function findIssueByNodeId(forge: Forge, id: unknown): { repo: Repo; issue: Issue } | undefined {
  if (typeof id !== 'string') return undefined;
  for (const repo of forge.repos.values()) {
    for (const issue of repo.issues.values()) {
      if (issueNodeId(repo, issue) === id) return { repo, issue };
    }
  }
  try {
    const decoded = Buffer.from(id.replace(/^I_/, ''), 'base64url').toString('utf8');
    const m = /^issue:([^/]+)\/([^:]+):(\d+)$/.exec(decoded);
    if (m) {
      const repo = forge.getRepo(m[1], m[2]);
      const issue = repo?.issues.get(parseInt(m[3], 10));
      if (repo && issue) return { repo, issue };
    }
  } catch {
    // Not our id format.
  }
  return undefined;
}

function findPrByNodeId(forge: Forge, id: unknown): { repo: Repo; pr: PullRequest } | undefined {
  if (typeof id !== 'string') return undefined;
  for (const repo of forge.repos.values()) {
    for (const pr of repo.prs.values()) {
      if (prNodeId(repo, pr) === id) return { repo, pr };
    }
  }
  try {
    const decoded = Buffer.from(id.replace(/^PR_/, ''), 'base64url').toString('utf8');
    const m = /^pr:([^/]+)\/([^:]+):(\d+)$/.exec(decoded);
    if (m) {
      const repo = forge.getRepo(m[1], m[2]);
      const pr = repo?.prs.get(parseInt(m[3], 10));
      if (repo && pr) return { repo, pr };
    }
  } catch {
    // Not our id format.
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Field resolution
// ---------------------------------------------------------------------------

function executeSelections(
  ctx: Ctx,
  parentType: string,
  parent: unknown,
  selections: SelectionNode[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragmentSpread') {
      const frag = ctx.fragments.get(sel.name as string);
      if (frag) {
        const sub = executeSelections(ctx, parentType, parent, frag.selections);
        Object.assign(out, sub);
      }
      continue;
    }
    if (sel.kind === 'inlineFragment') {
      if (!sel.typeCondition || sel.typeCondition === parentType) {
        const sub = executeSelections(ctx, parentType, parent, sel.selections ?? []);
        Object.assign(out, sub);
      }
      continue;
    }
    const key = sel.alias ?? (sel.name as string);
    out[key] = resolveField(ctx, parentType, parent, sel);
  }
  return out;
}

function resolveField(ctx: Ctx, parentType: string, parent: unknown, sel: SelectionNode): unknown {
  const name = sel.name as string;
  if (name === '__typename') return parentType;
  const args = resolveArgs(sel.args, ctx.variables);
  const p = (parent ?? {}) as Obj;

  // Introspection at the query root.
  if (parentType === 'Query' && name === '__type') {
    const info = TYPE_INFO[String(args.name ?? '')];
    if (!info) return null;
    return {
      __typename: '__Type',
      name: args.name,
      kind: info.kind,
      fields: info.fields ? info.fields.map((f) => ({ __typename: '__Field', name: f })) : null,
      enumValues: info.enumValues ? info.enumValues.map((v) => ({ __typename: '__EnumValue', name: v })) : null,
    };
  }
  if (parentType === 'Query' && name === '__schema') {
    return {
      __typename: '__Schema',
      queryType: { __typename: '__Type', name: 'Query' },
      mutationType: { __typename: '__Type', name: 'Mutation' },
      subscriptionType: null,
      types: Object.entries(TYPE_INFO).map(([n, info]) => ({
        __typename: '__Type',
        name: n,
        kind: info.kind,
        fields: info.fields ? info.fields.map((f) => ({ __typename: '__Field', name: f })) : null,
        enumValues: info.enumValues ? info.enumValues.map((v) => ({ __typename: '__EnumValue', name: v })) : null,
      })),
    };
  }

  const value = fieldValue(ctx, parentType, p, name, args, sel);
  if (value === undefined) {
    ctx.errors.push({ message: `Cannot query field "${name}" on type "${parentType}".` });
    return null;
  }
  if (sel.selections && value !== null && typeof value === 'object') {
    if (Array.isArray(value)) {
      return value.map((v) => {
        if (v !== null && typeof v === 'object') {
          const t = (v as Obj).__typename ?? parentType;
          return executeSelections(ctx, t, v, sel.selections as SelectionNode[]);
        }
        return v;
      });
    }
    const t = (value as Obj).__typename ?? parentType;
    return executeSelections(ctx, t, value, sel.selections);
  }
  return value;
}

function fieldValue(
  ctx: Ctx,
  parentType: string,
  p: Obj,
  name: string,
  args: Record<string, unknown>,
  _sel: SelectionNode,
): unknown {
  const forge = ctx.forge;

  if (parentType === 'Query') {
    if (name === 'viewer') {
      return { __typename: 'User', login: VIEWER_LOGIN, id: 1, databaseId: 1, name: VIEWER_LOGIN, avatarUrl: '', url: '' };
    }
    if (name === 'repository') {
      const repo = forge.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      if (!repo) return null;
      if (String(args.owner ?? '') !== VIEWER_LOGIN) return null;
      return repoObj(repo);
    }
    if (name === 'node') {
      const id = args.id;
      const repo = findRepoByNodeId(forge, id);
      if (repo) return repoObj(repo);
      const issue = findIssueByNodeId(forge, id);
      if (issue) return issueObj(issue.repo, issue.issue);
      const pr = findPrByNodeId(forge, id);
      if (pr) return prObj(pr.repo, pr.pr);
      return null;
    }
    if (name === 'search') {
      const q = String(args.query ?? '');
      const type = String(args.type ?? 'ISSUE');
      const repoMatch = /repo:([^\s]+)/.exec(q);
      let issues: Array<{ repo: Repo; issue: Issue }> = [];
      if (repoMatch) {
        const [o, n] = repoMatch[1].split('/');
        const repo = forge.getRepo(o ?? '', n ?? '');
        if (repo) issues = Array.from(repo.issues.values()).map((issue) => ({ repo, issue }));
      } else {
        for (const repo of forge.listRepos(VIEWER_LOGIN)) {
          for (const issue of repo.issues.values()) issues.push({ repo, issue });
        }
      }
      if (type !== 'ISSUE') return connection([], args.first, args.after);
      const terms = q.replace(/repo:[^\s]+/g, '').replace(/type:[^\s]+/g, '').trim().toLowerCase();
      if (terms !== '') {
        issues = issues.filter(({ issue }) => `${issue.title} ${issue.body}`.toLowerCase().includes(terms));
      }
      issues.sort((a, b) => b.issue.number - a.issue.number);
      return connection(issues.map(({ repo, issue }) => issueObj(repo, issue)), args.first, args.after);
    }
    return undefined;
  }

  if (parentType === 'Mutation') {
    return mutationValue(ctx, name, args);
  }

  if (parentType === 'Repository') {
    const repo = p._repo as Repo;
    if (!repo) return undefined;
    if (name === 'issue') {
      const issue = repo.issues.get(Number(args.number));
      return issue ? issueObj(repo, issue) : null;
    }
    if (name === 'issues') {
      const sorted = sortedIssues(repo, args);
      return connection(sorted.map((i) => issueObj(repo, i)), args.first, args.after);
    }
    if (name === 'pullRequest') {
      const pr = repo.prs.get(Number(args.number));
      return pr ? prObj(repo, pr) : null;
    }
    if (name === 'pullRequests') {
      let prs = Array.from(repo.prs.values());
      const states = args.states as string[] | undefined;
      if (Array.isArray(states) && states.length > 0) {
        const want = new Set(states.map((s) => String(s).toUpperCase()));
        prs = prs.filter((pr) => want.has(pr.merged ? 'MERGED' : pr.state.toUpperCase()));
      }
      prs.sort((a, b) => b.number - a.number);
      const conn = connection(prs.map((pr) => prObj(repo, pr)), args.first, args.after);
      conn.__typename = 'PullRequestConnection';
      return conn;
    }
    if (name === 'ref') {
      const qn = String(args.qualifiedName ?? '');
      const branch = qn.replace(/^refs\/heads\//, '');
      const tip = branchTip(repo, branch);
      if (!tip) return null;
      return { __typename: 'Ref', name: branch, prefix: 'refs/heads/', target: { __typename: 'Commit', oid: tip } };
    }
    if (name === 'refs') {
      const branches = Array.from(repo.git.refs.keys())
        .filter((r) => r.startsWith('refs/heads/'))
        .map((r) => ({ __typename: 'Ref', name: r.slice('refs/heads/'.length), prefix: 'refs/heads/' }));
      return connection(branches, args.first, args.after);
    }
    // Scalar/object fields live on the repo object itself.
    if (name in p) return p[name];
    return undefined;
  }

  if (parentType === 'Issue') {
    const repo = p._repo as Repo;
    const issue = p._issue as Issue;
    if (name === 'labels') {
      const nodes = issue.labels.map((n) => {
        const l = repo.labels.get(n);
        return { __typename: 'Label', name: n, color: l ? l.color : 'ededed', description: l ? l.description : '' };
      });
      return { __typename: 'LabelConnection', nodes, edges: nodes.map((n) => ({ __typename: 'LabelEdge', node: n, cursor: encodeCursor(0) })), totalCount: nodes.length, pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } };
    }
    if (name === 'comments') {
      const nodes = issue.comments.map((c) => ({
        __typename: 'IssueComment',
        id: `IC_${c.id}`,
        databaseId: c.id,
        body: c.body,
        author: { __typename: 'User', login: c.user, id: 1, databaseId: 1, name: c.user, avatarUrl: '', url: '' },
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      }));
      return connection(nodes, args.first, args.after);
    }
    if (name in p) return p[name];
    return undefined;
  }

  if (parentType === 'PullRequest') {
    const repo = p._repo as Repo;
    const pr = p._pr as PullRequest;
    if (name === 'files') {
      const files = prFiles(repo, pr).map((f) => ({
        __typename: 'PullRequestChangedFile',
        path: f.filename,
        additions: f.additions,
        deletions: f.deletions,
        changeType: f.status === 'added' ? 'ADDED' : f.status === 'removed' ? 'REMOVED' : 'MODIFIED',
      }));
      const conn = connection(files, args.first, args.after);
      conn.__typename = 'PullRequestChangedFileConnection';
      return conn;
    }
    if (name === 'commits') {
      const commits = prCommits(repo, pr).map((sha) => {
        const obj = repo.git.get(sha);
        const info = obj ? parseCommit(obj.data) : null;
        return { __typename: 'PullRequestCommit', commit: { __typename: 'Commit', oid: sha, message: info ? info.message : '' } };
      });
      return connection(commits, args.first, args.after);
    }
    if (name === 'reviews') {
      return { __typename: 'PullRequestReviewConnection', nodes: [], edges: [], totalCount: 0, pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } };
    }
    if (name in p) return p[name];
    return undefined;
  }

  if (name in p) return p[name];
  return undefined;
}

function mutationValue(ctx: Ctx, name: string, args: Record<string, unknown>): unknown {
  const forge = ctx.forge;
  const input = (args.input as Record<string, unknown> | undefined) ?? {};
  const clientMutationId = input.clientMutationId ?? null;

  if (name === 'createPullRequest') {
    const repo = findRepoByNodeId(forge, input.repositoryId);
    if (!repo) {
      ctx.errors.push({ message: `Could not resolve to a Repository with the id of '${String(input.repositoryId ?? '')}'.` });
      return null;
    }
    const head = String(input.headRefName ?? '');
    const base = String(input.baseRefName ?? '');
    if (!branchTip(repo, head) || !branchTip(repo, base)) {
      ctx.errors.push({ message: 'Head or base ref does not exist.' });
      return null;
    }
    repo.prSeq += 1;
    forge.prIdSeq += 1;
    const now = trialNowIso();
    const pr: PullRequest = {
      id: forge.prIdSeq,
      number: repo.prSeq,
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
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
      draft: input.draft === true,
    };
    repo.prs.set(pr.number, pr);
    return { __typename: 'CreatePullRequestPayload', pullRequest: prObj(repo, pr), clientMutationId };
  }

  if (name === 'createIssue') {
    const repo = findRepoByNodeId(forge, input.repositoryId);
    if (!repo) {
      ctx.errors.push({ message: `Could not resolve to a Repository with the id of '${String(input.repositoryId ?? '')}'.` });
      return null;
    }
    const title = String(input.title ?? '');
    if (title === '') {
      ctx.errors.push({ message: 'Title is required.' });
      return null;
    }
    const issue = createIssue(forge, repo, title, String(input.body ?? ''), [], VIEWER_LOGIN);
    return { __typename: 'CreateIssuePayload', issue: issueObj(repo, issue), clientMutationId };
  }

  if (name === 'closeIssue') {
    const found = findIssueByNodeId(forge, input.issueId ?? input.id);
    if (!found) {
      ctx.errors.push({ message: 'Could not resolve to an Issue.' });
      return null;
    }
    found.issue.state = 'closed';
    found.issue.closedAt = trialNowIso();
    found.issue.updatedAt = trialNowIso();
    return { __typename: 'CloseIssuePayload', issue: issueObj(found.repo, found.issue), clientMutationId };
  }

  if (name === 'addComment') {
    const subjectId = input.subjectId ?? input.subject_id;
    const found = findIssueByNodeId(forge, subjectId);
    const prFound = found ? undefined : findPrByNodeId(forge, subjectId);
    const body = String(input.body ?? '');
    if (body === '') {
      ctx.errors.push({ message: 'Body is required.' });
      return null;
    }
    if (found) {
      const comment = addIssueComment(forge, found.issue, body, VIEWER_LOGIN);
      const node = { __typename: 'IssueComment', id: `IC_${comment.id}`, databaseId: comment.id, body: comment.body, author: { __typename: 'User', login: VIEWER_LOGIN, id: 1, databaseId: 1, name: VIEWER_LOGIN, avatarUrl: '', url: '' }, createdAt: comment.createdAt, updatedAt: comment.updatedAt };
      return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'IssueCommentEdge', node, cursor: encodeCursor(comment.id) }, comment: node, subject: issueObj(found.repo, found.issue), clientMutationId };
    }
    if (prFound) {
      ctx.errors.push({ message: 'Comments on pull requests are not supported here.' });
      return null;
    }
    ctx.errors.push({ message: 'Could not resolve to a subject.' });
    return null;
  }

  if (name === 'mergePullRequest') {
    const found = findPrByNodeId(forge, input.pullRequestId ?? input.id);
    if (!found) {
      ctx.errors.push({ message: 'Could not resolve to a PullRequest.' });
      return null;
    }
    const { repo, pr } = found;
    if (pr.state !== 'open') {
      ctx.errors.push({ message: 'Pull request is already closed.' });
      return null;
    }
    if (!prMergeable(repo, pr)) {
      ctx.errors.push({ message: 'Merge conflict.' });
      return null;
    }
    mergePullRequest(forge, repo, pr);
    return { __typename: 'MergePullRequestPayload', pullRequest: prObj(repo, pr), clientMutationId };
  }

  if (name === 'updateIssue') {
    const found = findIssueByNodeId(forge, input.id ?? input.issueId);
    if (!found) {
      ctx.errors.push({ message: 'Could not resolve to an Issue.' });
      return null;
    }
    if (typeof input.title === 'string') found.issue.title = input.title;
    if (typeof input.body === 'string') found.issue.body = input.body;
    if (typeof input.state === 'string') {
      found.issue.state = input.state === 'CLOSED' ? 'closed' : 'open';
      found.issue.closedAt = found.issue.state === 'closed' ? trialNowIso() : null;
    }
    found.issue.updatedAt = trialNowIso();
    return { __typename: 'UpdateIssuePayload', issue: issueObj(found.repo, found.issue), clientMutationId };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Entry point: one operation document, or a batch of them.
// ---------------------------------------------------------------------------

export interface GraphQLResult {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

function executeOne(forge: Forge, query: string, variables: Variables, operationName?: string): GraphQLResult {
  let defs: DefinitionNode[];
  try {
    defs = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: (err as Error).message }] };
  }
  const fragments = new Map<string, FragmentNode>();
  for (const d of defs) if (d.kind === 'fragment') fragments.set(d.name, d);
  const ops = defs.filter((d): d is OperationNode => d.kind === 'operation');
  if (ops.length === 0) return { data: null, errors: [{ message: 'No operation found.' }] };
  const op = operationName ? ops.find((o) => o.name === operationName) ?? ops[0] : ops[0];
  const vars: Variables = { ...variables };
  for (const v of op.variables) {
    if (!(v.name in vars) && v.defaultValue !== undefined) vars[v.name] = resolveValue(v.defaultValue, vars);
  }
  const ctx: Ctx = { forge, variables: vars, fragments, errors: [] };
  const rootType = op.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(ctx, rootType, {}, op.selections);
  const result: GraphQLResult = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

export function handleGraphQL(forge: Forge, body: unknown): GraphQLResult | GraphQLResult[] {
  if (Array.isArray(body)) {
    return body.map((item) => {
      if (typeof item !== 'object' || item === null) return { data: null, errors: [{ message: 'Invalid operation.' }] };
      const q = item as Record<string, unknown>;
      return executeOne(forge, String(q.query ?? ''), (q.variables as Variables) ?? {}, typeof q.operationName === 'string' ? q.operationName : undefined);
    });
  }
  if (typeof body !== 'object' || body === null) {
    return { data: null, errors: [{ message: 'Invalid operation.' }] };
  }
  const q = body as Record<string, unknown>;
  return executeOne(forge, String(q.query ?? ''), (q.variables as Variables) ?? {}, typeof q.operationName === 'string' ? q.operationName : undefined);
}
