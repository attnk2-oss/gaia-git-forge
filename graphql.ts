// GraphQL v4 at /api/graphql. A small, hand-written executor for the fixed
// documents the suite sends (gh's repository/issue/pull-request queries, the
// __type feature-detection probes, the five mutations, Relay node(id:) reads,
// cursor pagination and operation batching). No GraphQL library: a tokenizer,
// a recursive-descent parser, a schema table, and resolvers over the Forge store.
//
// Wire rules the suite relies on:
// - a GraphQL-level failure (an unknown field) is a 200 with an `errors` array,
//   never an HTTP error; an unauthenticated request is a 401;
// - a JSON array body is operation batching: one response per operation, in order;
// - global ids are opaque base64url payloads (R:/I:/P:/C:) shared with the store;
// - an unknown repository is data.repository = null with no errors.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  Forge,
  VIEWER_ID,
  VIEWER_LOGIN,
  decodeGlobalId,
  issueGlobalId,
  isoOf,
  pullGlobalId,
  repoGlobalId,
  commentGlobalId,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';
import { mergePull } from './rest.ts';
import { parseJsonBody, readBody, sendJson } from './util.ts';

// ---------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
  line: number;
  column: number;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let column = 1;
  const push = (kind: TokenKind, value: string, startLine: number, startColumn: number): void => {
    tokens.push({ kind, value, line: startLine, column: startColumn });
  };
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === ',' || ch === '\r') {
      i += 1;
      column += 1;
      continue;
    }
    if (ch === '\n') {
      i += 1;
      line += 1;
      column = 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') {
        i += 1;
        column += 1;
      }
      continue;
    }
    const startLine = line;
    const startColumn = column;
    if (ch === '"') {
      let value = '';
      i += 1;
      column += 1;
      for (;;) {
        if (i >= source.length) throw new Error('unterminated string in GraphQL document');
        const c = source[i]!;
        if (c === '"') {
          i += 1;
          column += 1;
          break;
        }
        if (c === '\\') {
          const esc = source[i + 1]!;
          if (esc === 'u') {
            value += String.fromCharCode(parseInt(source.slice(i + 2, i + 6), 16));
            i += 6;
            column += 6;
          } else {
            const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' };
            value += map[esc] ?? esc;
            i += 2;
            column += 2;
          }
          continue;
        }
        if (c === '\n') {
          line += 1;
          column = 1;
        } else {
          column += 1;
        }
        value += c;
        i += 1;
      }
      push('string', value, startLine, startColumn);
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j]!)) j += 1;
      const text = source.slice(i, j);
      push(/[eE.]/.test(text) ? 'float' : 'int', text, startLine, startColumn);
      column += j - i;
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j]!)) j += 1;
      push('name', source.slice(i, j), startLine, startColumn);
      column += j - i;
      i = j;
      continue;
    }
    if ('!$():=@[]{}|&.'.includes(ch)) {
      if (ch === '.' && source.slice(i, i + 3) === '...') {
        push('punct', '...', startLine, startColumn);
        i += 3;
        column += 3;
      } else {
        push('punct', ch, startLine, startColumn);
        i += 1;
        column += 1;
      }
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '', line, column });
  return tokens;
}

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Record<string, ValueNode>;
  selections: SelectionNode[];
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selections: SelectionNode[];
}

interface FragmentSpreadNode {
  kind: 'spread';
  name: string;
}

type SelectionNode = FieldNode | InlineFragmentNode | FragmentSpreadNode;

interface VariableDefinition {
  name: string;
  type: string;
  defaultValue: ValueNode | null;
}

interface OperationDefinition {
  kind: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefinitions: VariableDefinition[];
  selections: SelectionNode[];
}

interface FragmentDefinition {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

interface Document {
  operations: OperationDefinition[];
  fragments: Map<string, FragmentDefinition>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private expectPunct(value: string): Token {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)} at line ${token.line}, got ${token.value}`);
    }
    return token;
  }

  private expectName(value?: string): Token {
    const token = this.next();
    if (token.kind !== 'name' || (value !== undefined && token.value !== value)) {
      throw new Error(`expected name ${value ?? ''} at line ${token.line}, got ${token.value}`);
    }
    return token;
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseArguments();
    }
  }

  parseDocument(): Document {
    const operations: OperationDefinition[] = [];
    const fragments = new Map<string, FragmentDefinition>();
    while (this.peek().kind !== 'eof') {
      if (this.peek().kind === 'punct' && this.peek().value === '{') {
        operations.push({ kind: 'query', name: null, variableDefinitions: [], selections: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.expectName();
      if (keyword.value === 'fragment') {
        const name = this.expectName().value;
        this.expectName('on');
        const typeCondition = this.expectName().value;
        this.skipDirectives();
        fragments.set(name, { name, typeCondition, selections: this.parseSelectionSet() });
      } else if (keyword.value === 'query' || keyword.value === 'mutation' || keyword.value === 'subscription') {
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        let variableDefinitions: VariableDefinition[] = [];
        if (this.peek().kind === 'punct' && this.peek().value === '(') variableDefinitions = this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ kind: keyword.value, name, variableDefinitions, selections: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected keyword ${keyword.value} in GraphQL document`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): VariableDefinition[] {
    this.expectPunct('(');
    const defs: VariableDefinition[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      this.expectPunct('$');
      const name = this.expectName().value;
      this.expectPunct(':');
      const type = this.parseTypeString();
      let defaultValue: ValueNode | null = null;
      if (this.peek().kind === 'punct' && this.peek().value === '=') {
        this.next();
        defaultValue = this.parseValue(true);
      }
      defs.push({ name, type, defaultValue });
    }
    this.expectPunct(')');
    return defs;
  }

  private parseTypeString(): string {
    if (this.peek().kind === 'punct' && this.peek().value === '[') {
      this.next();
      const inner = this.parseTypeString();
      this.expectPunct(']');
      let out = `[${inner}]`;
      if (this.peek().kind === 'punct' && this.peek().value === '!') {
        this.next();
        out += '!';
      }
      return out;
    }
    const name = this.expectName().value;
    if (this.peek().kind === 'punct' && this.peek().value === '!') {
      this.next();
      return `${name}!`;
    }
    return name;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName().value;
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const first = this.expectName().value;
    let alias: string | null = null;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName().value;
    }
    let args: Record<string, ValueNode> = {};
    if (this.peek().kind === 'punct' && this.peek().value === '(') args = this.parseArguments();
    this.skipDirectives();
    let selections: SelectionNode[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '{') selections = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selections };
  }

  private parseArguments(): Record<string, ValueNode> {
    this.expectPunct('(');
    const args: Record<string, ValueNode> = {};
    while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
      const name = this.expectName().value;
      this.expectPunct(':');
      args[name] = this.parseValue(false);
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(constValue: boolean): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      if (constValue) throw new Error('variables are not allowed in a constant value');
      return { kind: 'variable', name: this.expectName().value };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) items.push(this.parseValue(constValue));
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName().value;
        this.expectPunct(':');
        fields[name] = this.parseValue(constValue);
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value} at line ${token.line}`);
  }
}

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

interface SchemaField {
  type: string;
  args?: Record<string, string>;
  description?: string;
}

interface SchemaType {
  kind: 'OBJECT' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR' | 'INTERFACE';
  fields?: Record<string, SchemaField>;
  enumValues?: string[];
  inputFields?: Record<string, string>;
  description?: string;
  interfaces?: string[];
}

const SCHEMA: Record<string, SchemaType> = {
  Query: {
    kind: 'OBJECT',
    fields: {
      viewer: { type: 'Viewer' },
      repository: { type: 'Repository', args: { owner: 'String!', name: 'String!' } },
      node: { type: 'Node', args: { id: 'ID!' } },
      __type: { type: '__Type', args: { name: 'String!' } },
      __schema: { type: '__Schema' },
    },
  },
  Mutation: {
    kind: 'OBJECT',
    fields: {
      createIssue: { type: 'CreateIssuePayload', args: { input: 'CreateIssueInput!' } },
      closeIssue: { type: 'CloseIssuePayload', args: { input: 'CloseIssueInput!' } },
      createPullRequest: { type: 'CreatePullRequestPayload', args: { input: 'CreatePullRequestInput!' } },
      mergePullRequest: { type: 'MergePullRequestPayload', args: { input: 'MergePullRequestInput!' } },
      addComment: { type: 'AddCommentPayload', args: { input: 'AddCommentInput!' } },
    },
  },
  Viewer: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      login: { type: 'String!' },
      name: { type: 'String' },
      email: { type: 'String' },
      avatarUrl: { type: 'String' },
    },
  },
  User: {
    kind: 'OBJECT',
    interfaces: ['Node'],
    fields: {
      id: { type: 'ID!' },
      login: { type: 'String!' },
      name: { type: 'String' },
      email: { type: 'String' },
      avatarUrl: { type: 'String' },
    },
  },
  Node: { kind: 'INTERFACE', fields: { id: { type: 'ID!' } } },
  Repository: {
    kind: 'OBJECT',
    interfaces: ['Node'],
    fields: {
      id: { type: 'ID!' },
      databaseId: { type: 'Int!' },
      name: { type: 'String!' },
      nameWithOwner: { type: 'String!' },
      owner: { type: 'User!' },
      defaultBranchRef: { type: 'Ref' },
      viewerPermission: { type: 'RepositoryPermission!' },
      hasIssuesEnabled: { type: 'Boolean!' },
      description: { type: 'String' },
      private: { type: 'Boolean!' },
      url: { type: 'String!' },
      createdAt: { type: 'DateTime!' },
      updatedAt: { type: 'DateTime!' },
      issue: { type: 'Issue', args: { number: 'Int!' } },
      issues: {
        type: 'IssueConnection!',
        args: { first: 'Int', after: 'String', states: '[IssueState!]', orderBy: 'IssueOrder' },
      },
      pullRequest: { type: 'PullRequest', args: { number: 'Int!' } },
      pullRequests: { type: 'PullRequestConnection!', args: { first: 'Int', states: '[PullRequestState!]' } },
    },
  },
  Ref: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      name: { type: 'String!' },
      prefix: { type: 'String!' },
    },
  },
  Issue: {
    kind: 'OBJECT',
    interfaces: ['Node'],
    fields: {
      id: { type: 'ID!' },
      number: { type: 'Int!' },
      title: { type: 'String!' },
      body: { type: 'String!' },
      state: { type: 'IssueState!' },
      url: { type: 'String!' },
      createdAt: { type: 'DateTime!' },
      updatedAt: { type: 'DateTime!' },
      author: { type: 'User' },
      labels: { type: 'LabelConnection', args: { first: 'Int' } },
      comments: { type: 'IssueCommentConnection!', args: { first: 'Int', after: 'String' } },
    },
  },
  Label: { kind: 'OBJECT', fields: { id: { type: 'ID!' }, name: { type: 'String!' }, color: { type: 'String!' } } },
  LabelConnection: {
    kind: 'OBJECT',
    fields: { nodes: { type: '[Label]' }, pageInfo: { type: 'PageInfo!' }, totalCount: { type: 'Int!' } },
  },
  IssueComment: {
    kind: 'OBJECT',
    interfaces: ['Node'],
    fields: {
      id: { type: 'ID!' },
      body: { type: 'String!' },
      author: { type: 'User' },
      createdAt: { type: 'DateTime!' },
      updatedAt: { type: 'DateTime!' },
    },
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: { nodes: { type: '[Issue]' }, edges: { type: '[IssueEdge]' }, pageInfo: { type: 'PageInfo!' }, totalCount: { type: 'Int!' } },
  },
  IssueEdge: { kind: 'OBJECT', fields: { node: { type: 'Issue' }, cursor: { type: 'String!' } } },
  IssueCommentConnection: {
    kind: 'OBJECT',
    fields: { nodes: { type: '[IssueComment]' }, pageInfo: { type: 'PageInfo!' }, totalCount: { type: 'Int!' } },
  },
  IssueCommentEdge: { kind: 'OBJECT', fields: { node: { type: 'IssueComment' }, cursor: { type: 'String!' } } },
  PullRequest: {
    kind: 'OBJECT',
    interfaces: ['Node'],
    fields: {
      id: { type: 'ID!' },
      number: { type: 'Int!' },
      title: { type: 'String!' },
      body: { type: 'String!' },
      state: { type: 'PullRequestState!' },
      merged: { type: 'Boolean!' },
      mergeable: { type: 'MergeableState!' },
      headRefName: { type: 'String!' },
      baseRefName: { type: 'String!' },
      headRef: { type: 'Ref' },
      baseRef: { type: 'Ref' },
      files: { type: 'PullRequestChangedFileConnection!', args: { first: 'Int' } },
      mergedAt: { type: 'DateTime' },
      author: { type: 'User' },
      createdAt: { type: 'DateTime!' },
      updatedAt: { type: 'DateTime!' },
    },
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: { nodes: { type: '[PullRequest]' }, pageInfo: { type: 'PageInfo!' }, totalCount: { type: 'Int!' } },
  },
  PullRequestChangedFileConnection: {
    kind: 'OBJECT',
    fields: { nodes: { type: '[PullRequestChangedFile]' }, pageInfo: { type: 'PageInfo!' }, totalCount: { type: 'Int!' } },
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: {
      path: { type: 'String!' },
      additions: { type: 'Int!' },
      deletions: { type: 'Int!' },
      changeType: { type: 'String!' },
    },
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: {
      hasNextPage: { type: 'Boolean!' },
      hasPreviousPage: { type: 'Boolean!' },
      startCursor: { type: 'String' },
      endCursor: { type: 'String' },
    },
  },
  CreateIssuePayload: { kind: 'OBJECT', fields: { issue: { type: 'Issue' }, clientMutationId: { type: 'String' } } },
  CloseIssuePayload: { kind: 'OBJECT', fields: { issue: { type: 'Issue' }, clientMutationId: { type: 'String' } } },
  CreatePullRequestPayload: {
    kind: 'OBJECT',
    fields: { pullRequest: { type: 'PullRequest' }, clientMutationId: { type: 'String' } },
  },
  MergePullRequestPayload: {
    kind: 'OBJECT',
    fields: { pullRequest: { type: 'PullRequest' }, clientMutationId: { type: 'String' } },
  },
  AddCommentPayload: {
    kind: 'OBJECT',
    fields: { commentEdge: { type: 'IssueCommentEdge' }, clientMutationId: { type: 'String' } },
  },
  CreateIssueInput: {
    kind: 'INPUT_OBJECT',
    inputFields: { repositoryId: 'ID!', title: 'String!', body: 'String', clientMutationId: 'String' },
  },
  CloseIssueInput: { kind: 'INPUT_OBJECT', inputFields: { issueId: 'ID!', clientMutationId: 'String' } },
  CreatePullRequestInput: {
    kind: 'INPUT_OBJECT',
    inputFields: {
      repositoryId: 'ID!',
      baseRefName: 'String!',
      headRefName: 'String!',
      title: 'String!',
      body: 'String',
      clientMutationId: 'String',
    },
  },
  MergePullRequestInput: {
    kind: 'INPUT_OBJECT',
    inputFields: {
      pullRequestId: 'ID!',
      mergeMethod: 'PullRequestMergeMethod',
      commitHeadline: 'String',
      clientMutationId: 'String',
    },
  },
  AddCommentInput: {
    kind: 'INPUT_OBJECT',
    inputFields: { subjectId: 'ID!', body: 'String!', clientMutationId: 'String' },
  },
  IssueOrder: {
    kind: 'INPUT_OBJECT',
    inputFields: { field: 'IssueOrderField!', direction: 'OrderDirection!' },
  },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  DateTime: { kind: 'SCALAR' },
  __Schema: {
    kind: 'OBJECT',
    fields: {
      queryType: { type: '__Type!' },
      mutationType: { type: '__Type' },
      types: { type: '[__Type!]!' },
      directives: { type: '[__Directive!]!' },
    },
  },
  __Type: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String' },
      kind: { type: '__TypeKind!' },
      description: { type: 'String' },
      fields: { type: '[__Field!]', args: { includeDeprecated: 'Boolean' } },
      enumValues: { type: '[__EnumValue!]', args: { includeDeprecated: 'Boolean' } },
      inputFields: { type: '[__InputValue!]' },
      ofType: { type: '__Type' },
      possibleTypes: { type: '[__Type!]' },
      interfaces: { type: '[__Type!]' },
    },
  },
  __Field: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String!' },
      description: { type: 'String' },
      args: { type: '[__InputValue!]!' },
      type: { type: '__Type!' },
    },
  },
  __InputValue: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String!' },
      description: { type: 'String' },
      type: { type: '__Type!' },
      defaultValue: { type: 'String' },
    },
  },
  __EnumValue: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String!' },
      description: { type: 'String' },
      isDeprecated: { type: 'Boolean!' },
      deprecationReason: { type: 'String' },
    },
  },
  __Directive: { kind: 'OBJECT', fields: { name: { type: 'String!' }, description: { type: 'String' } } },
  __TypeKind: {
    kind: 'ENUM',
    enumValues: ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'],
  },
};

const NODE_TYPES = new Set(['Repository', 'Issue', 'PullRequest', 'IssueComment', 'User']);

// ---------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------

/** A resolved node: a GraphQL type name plus the store object (or a synthesized map). */
export interface GqlNode {
  __typename: string;
  __source: unknown;
}

type GqlValue = GqlNode | GqlNode[] | string | number | boolean | null;

function node(typename: string, source: unknown): GqlNode {
  return { __typename: typename, __source: source };
}

function repoNode(repo: Repo): GqlNode {
  return node('Repository', repo);
}

function issueNode(repo: Repo, issue: Issue): GqlNode {
  return node('Issue', { repo, issue });
}

function pullNode(repo: Repo, pull: PullRequest): GqlNode {
  return node('PullRequest', { repo, pull });
}

function commentNode(repo: Repo, issue: Issue, commentId: number): GqlNode {
  const comment = issue.comments.find((c) => c.id === commentId);
  return node('IssueComment', { repo, issue, comment });
}

function userNode(): GqlNode {
  return node('User', { login: VIEWER_LOGIN, id: VIEWER_ID });
}

function viewerNode(): GqlNode {
  return node('Viewer', { login: VIEWER_LOGIN, id: VIEWER_ID });
}

function refNode(repo: Repo, name: string): GqlNode {
  return node('Ref', { repo, name });
}

function typeNode(typeDef: { name: string | null; kind: string; ofType?: unknown }): GqlNode {
  return node('__Type', typeDef);
}

/** A type string like `[Issue!]!` rendered as a __Type node tree. */
function typeRefNode(typeString: string): GqlNode {
  const parse = (text: string): { name: string | null; kind: string; ofType?: unknown } => {
    if (text.endsWith('!')) return { name: null, kind: 'NON_NULL', ofType: parse(text.slice(0, -1)) };
    if (text.startsWith('[') && text.endsWith(']')) {
      return { name: null, kind: 'LIST', ofType: parse(text.slice(1, -1)) };
    }
    const def = SCHEMA[text];
    return { name: text, kind: def?.kind ?? 'SCALAR' };
  };
  return typeNode(parse(typeString));
}

/** The named-type __Type node for a schema type name, or null for an unknown name. */
function namedTypeNode(name: string): GqlNode | null {
  const def = SCHEMA[name];
  if (!def) return null;
  return typeNode({ name, kind: def.kind });
}

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  errors: Array<Record<string, unknown>>;
  document: Document;
}

function valueOf(valueNode: ValueNode, variables: Record<string, unknown>): unknown {
  switch (valueNode.kind) {
    case 'variable':
      return variables[valueNode.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return valueNode.value;
    case 'null':
      return null;
    case 'list':
      return valueNode.items.map((item) => valueOf(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(valueNode.fields)) out[key] = valueOf(value, variables);
      return out;
    }
  }
}

function resolveArgs(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, valueNode] of Object.entries(field.args)) out[name] = valueOf(valueNode, ctx.variables);
  return out;
}

function defaultRead(parent: GqlNode, fieldName: string): unknown {
  const source = parent.__source;
  if (source && typeof source === 'object' && fieldName in (source as Record<string, unknown>)) {
    return (source as Record<string, unknown>)[fieldName];
  }
  return null;
}

type Resolver = (parent: GqlNode, args: Record<string, unknown>, ctx: ExecContext) => GqlValue | undefined;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => viewerNode(),
    repository: (_parent, args, ctx) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      if (owner.toLowerCase() !== VIEWER_LOGIN.toLowerCase()) return null;
      const repo = ctx.forge.getRepo(name);
      return repo ? repoNode(repo) : null;
    },
    node: (_parent, args, ctx) => {
      const id = typeof args.id === 'string' ? args.id : '';
      const decoded = decodeGlobalId(id);
      if (!decoded) return null;
      if (decoded.owner.toLowerCase() !== VIEWER_LOGIN.toLowerCase()) return null;
      const repo = ctx.forge.getRepo(decoded.kind === 'repo' ? decoded.name : decoded.repo);
      if (!repo) return null;
      if (decoded.kind === 'repo') return repoNode(repo);
      if (decoded.kind === 'issue') {
        const issue = repo.issues.get(decoded.number);
        return issue ? issueNode(repo, issue) : null;
      }
      if (decoded.kind === 'pull') {
        const pull = repo.pulls.get(decoded.number);
        return pull ? pullNode(repo, pull) : null;
      }
      const issue = repo.issues.get(decoded.issue);
      return issue ? commentNode(repo, issue, decoded.commentId) : null;
    },
    __type: (_parent, args) => {
      const name = typeof args.name === 'string' ? args.name : '';
      return namedTypeNode(name);
    },
    __schema: () => node('__Schema', {}),
  },
  Mutation: {
    createIssue: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repoId = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      if (!repoId || repoId.kind !== 'repo' || !title) throw new Error('createIssue needs a repositoryId and a title');
      const repo = ctx.forge.getRepo(repoId.name);
      if (!repo) throw new Error('repository not found');
      const issue = ctx.forge.createIssue(repo, title, body, []);
      return node('CreateIssuePayload', { issue: issueNode(repo, issue) });
    },
    closeIssue: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
      if (!decoded || decoded.kind !== 'issue') throw new Error('closeIssue needs an issueId');
      const repo = ctx.forge.getRepo(decoded.repo);
      const issue = repo?.issues.get(decoded.number);
      if (!repo || !issue) throw new Error('issue not found');
      issue.state = 'closed';
      issue.updatedSeq = ctx.forge.bumpSeq();
      return node('CloseIssuePayload', { issue: issueNode(repo, issue) });
    },
    createPullRequest: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repoId = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
      const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
      const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      if (!repoId || repoId.kind !== 'repo' || !headRef || !baseRef || !title) {
        throw new Error('createPullRequest needs repositoryId, headRefName, baseRefName and title');
      }
      const repo = ctx.forge.getRepo(repoId.name);
      if (!repo) throw new Error('repository not found');
      const headSha = repo.refs.get(`refs/heads/${headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
      if (!headSha || !baseSha) throw new Error('head or base branch does not exist');
      const existing = [...repo.pulls.values()].find((p) => p.headRef === headRef && p.baseRef === baseRef && p.state === 'open');
      const pull =
        existing ??
        ctx.forge.createPull(repo, title, body, headRef, baseRef);
      return node('CreatePullRequestPayload', { pullRequest: pullNode(repo, pull) });
    },
    mergePullRequest: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
      if (!decoded || decoded.kind !== 'pull') throw new Error('mergePullRequest needs a pullRequestId');
      const repo = ctx.forge.getRepo(decoded.repo);
      const pull = repo?.pulls.get(decoded.number);
      if (!repo || !pull) throw new Error('pull request not found');
      if (pull.state === 'closed' && !pull.merged) throw new Error('Pull Request is not mergeable');
      const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'squash';
      if (pull.state === 'open') {
        const message = `Squash and merge ${pull.title} (#${pull.number})`;
        mergePull(ctx.forge, repo, pull, method, message);
      }
      return node('MergePullRequestPayload', { pullRequest: pullNode(repo, pull) });
    },
    addComment: (_parent, args, ctx) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const body = typeof input.body === 'string' ? input.body : '';
      const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
      if (!decoded || !body) throw new Error('addComment needs a subjectId and a body');
      const repo = ctx.forge.getRepo(decoded.kind === 'repo' ? decoded.name : decoded.repo);
      if (!repo) throw new Error('subject not found');
      let issue: Issue | undefined;
      if (decoded.kind === 'issue' || decoded.kind === 'pull') issue = repo.issues.get(decoded.number);
      if (!issue) throw new Error('subject not found');
      const comment = ctx.forge.createComment(repo, issue, body);
      const edge = node('IssueCommentEdge', {
        node: commentNode(repo, issue, comment.id),
        cursor: cursorOf(issue.number),
      });
      return node('AddCommentPayload', { commentEdge: edge });
    },
  },
  Viewer: {
    id: () => Buffer.from(`U:${VIEWER_ID}`, 'utf8').toString('base64url'),
    login: () => VIEWER_LOGIN,
    name: () => VIEWER_LOGIN,
    email: () => `${VIEWER_LOGIN}@example.invalid`,
    avatarUrl: () => '',
  },
  User: {
    id: () => Buffer.from(`U:${VIEWER_ID}`, 'utf8').toString('base64url'),
    login: () => VIEWER_LOGIN,
    name: () => VIEWER_LOGIN,
    email: () => `${VIEWER_LOGIN}@example.invalid`,
    avatarUrl: () => '',
  },
  Repository: {
    id: (parent) => repoGlobalId(VIEWER_LOGIN, (parent.__source as Repo).name),
    databaseId: (parent) => (parent.__source as Repo).id,
    name: (parent) => (parent.__source as Repo).name,
    nameWithOwner: (parent) => `${VIEWER_LOGIN}/${(parent.__source as Repo).name}`,
    owner: () => userNode(),
    defaultBranchRef: (parent) => {
      const repo = parent.__source as Repo;
      if (!repo.refs.has(`refs/heads/${repo.defaultBranch}`)) return null;
      return refNode(repo, repo.defaultBranch);
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (parent) => (parent.__source as Repo).description,
    private: (parent) => (parent.__source as Repo).isPrivate,
    url: (parent) => `https://github.invalid/${VIEWER_LOGIN}/${(parent.__source as Repo).name}`,
    createdAt: (parent) => isoOf((parent.__source as Repo).createdSeq),
    updatedAt: (parent) => isoOf((parent.__source as Repo).updatedSeq),
    issue: (parent, args) => {
      const repo = parent.__source as Repo;
      const number = typeof args.number === 'number' ? args.number : -1;
      const issue = repo.issues.get(number);
      return issue ? issueNode(repo, issue) : null;
    },
    issues: (parent, args) => issueConnection(parent.__source as Repo, args),
    pullRequest: (parent, args) => {
      const repo = parent.__source as Repo;
      const number = typeof args.number === 'number' ? args.number : -1;
      const pull = repo.pulls.get(number);
      return pull ? pullNode(repo, pull) : null;
    },
    pullRequests: (parent, args) => pullRequestConnection(parent.__source as Repo, args),
  },
  Ref: {
    id: (parent) => {
      const { repo, name } = parent.__source as { repo: Repo; name: string };
      return Buffer.from(`Ref:${repo.id}:${name}`, 'utf8').toString('base64url');
    },
    name: (parent) => (parent.__source as { name: string }).name,
    prefix: () => 'refs/heads/',
  },
  Issue: {
    id: (parent) => {
      const { repo, issue } = parent.__source as { repo: Repo; issue: Issue };
      return issueGlobalId(VIEWER_LOGIN, repo.name, issue.number);
    },
    number: (parent) => (parent.__source as { issue: Issue }).issue.number,
    title: (parent) => (parent.__source as { issue: Issue }).issue.title,
    body: (parent) => (parent.__source as { issue: Issue }).issue.body,
    state: (parent) => ((parent.__source as { issue: Issue }).issue.state === 'open' ? 'OPEN' : 'CLOSED'),
    url: (parent) => {
      const { repo, issue } = parent.__source as { repo: Repo; issue: Issue };
      return `https://github.invalid/${VIEWER_LOGIN}/${repo.name}/issues/${issue.number}`;
    },
    createdAt: (parent) => isoOf((parent.__source as { issue: Issue }).issue.createdSeq),
    updatedAt: (parent) => isoOf((parent.__source as { issue: Issue }).issue.updatedSeq),
    author: () => userNode(),
    labels: (parent, args) => {
      const { repo, issue } = parent.__source as { repo: Repo; issue: Issue };
      const first = typeof args.first === 'number' ? args.first : issue.labels.length;
      const labels = issue.labels
        .map((name) => repo.labels.get(name))
        .filter((l): l is NonNullable<typeof l> => l !== undefined);
      const nodes = labels.slice(0, first).map((l) => node('Label', l));
      return node('LabelConnection', { nodes, pageInfo: pageInfoOf(nodes.length, labels.length), totalCount: labels.length });
    },
    comments: (parent, args) => {
      const { repo, issue } = parent.__source as { repo: Repo; issue: Issue };
      const first = typeof args.first === 'number' ? args.first : 30;
      const after = typeof args.after === 'string' ? decodeCursor(args.after) : null;
      const comments = issue.comments.filter((c) => after === null || c.id > after);
      const page = comments.slice(0, first);
      const nodes = page.map((c) => commentNode(repo, issue, c.id));
      return node('IssueCommentConnection', {
        nodes,
        pageInfo: pageInfoOf(page.length, comments.length, page.length > 0 ? page[page.length - 1]!.id : null),
        totalCount: issue.comments.length,
      });
    },
  },
  Label: {
    id: (parent) => {
      const label = parent.__source as { id: number; name: string };
      return Buffer.from(`L:${label.id}`, 'utf8').toString('base64url');
    },
    name: (parent) => (parent.__source as { name: string }).name,
    color: (parent) => (parent.__source as { color: string }).color,
  },
  IssueComment: {
    id: (parent) => {
      const { repo, issue, comment } = parent.__source as { repo: Repo; issue: Issue; comment: { id: number } };
      return commentGlobalId(VIEWER_LOGIN, repo.name, issue.number, comment.id);
    },
    body: (parent) => (parent.__source as { comment: { body: string } }).comment.body,
    author: () => userNode(),
    createdAt: (parent) => isoOf((parent.__source as { comment: { createdSeq: number } }).comment.createdSeq),
    updatedAt: (parent) => isoOf((parent.__source as { comment: { createdSeq: number } }).comment.createdSeq),
  },
  PullRequest: {
    id: (parent) => {
      const { repo, pull } = parent.__source as { repo: Repo; pull: PullRequest };
      return pullGlobalId(VIEWER_LOGIN, repo.name, pull.number);
    },
    number: (parent) => (parent.__source as { pull: PullRequest }).pull.number,
    title: (parent) => (parent.__source as { pull: PullRequest }).pull.title,
    body: (parent) => (parent.__source as { pull: PullRequest }).pull.body,
    state: (parent) => {
      const pull = (parent.__source as { pull: PullRequest }).pull;
      if (pull.state === 'open') return 'OPEN';
      return pull.merged ? 'MERGED' : 'CLOSED';
    },
    merged: (parent) => (parent.__source as { pull: PullRequest }).pull.merged,
    mergeable: (parent, _args, ctx) => {
      const { repo, pull } = parent.__source as { repo: Repo; pull: PullRequest };
      if (pull.state !== 'open') return 'UNKNOWN';
      const headTip = ctx.forge.resolveToCommit(repo, pull.headRef);
      const baseTip = ctx.forge.resolveToCommit(repo, pull.baseRef);
      if (!headTip || !baseTip) return 'UNKNOWN';
      return ctx.forge.mergePlan(repo, pull).ok ? 'MERGEABLE' : 'CONFLICTING';
    },
    headRefName: (parent) => (parent.__source as { pull: PullRequest }).pull.headRef,
    baseRefName: (parent) => (parent.__source as { pull: PullRequest }).pull.baseRef,
    headRef: (parent) => {
      const { repo, pull } = parent.__source as { repo: Repo; pull: PullRequest };
      return repo.refs.has(`refs/heads/${pull.headRef}`) ? refNode(repo, pull.headRef) : null;
    },
    baseRef: (parent) => {
      const { repo, pull } = parent.__source as { repo: Repo; pull: PullRequest };
      return repo.refs.has(`refs/heads/${pull.baseRef}`) ? refNode(repo, pull.baseRef) : null;
    },
    files: (parent, args, ctx) => {
      const { repo, pull } = parent.__source as { repo: Repo; pull: PullRequest };
      const first = typeof args.first === 'number' ? args.first : 30;
      const headTip = ctx.forge.resolveToCommit(repo, pull.headRef);
      const baseTip = ctx.forge.resolveToCommit(repo, pull.baseRef);
      if (!headTip || !baseTip) {
        return node('PullRequestChangedFileConnection', { nodes: [], pageInfo: pageInfoOf(0, 0), totalCount: 0 });
      }
      const headTree = ctx.forge.treeOfCommit(repo, headTip);
      const baseTree = ctx.forge.treeOfCommit(repo, baseTip);
      const changes = ctx.forge.diffTrees(repo, baseTree, headTree);
      const all = changes.map((change) => {
        const oldText = change.oldOid ? blobText(repo, change.oldOid) : '';
        const newText = change.newOid ? blobText(repo, change.newOid) : '';
        const { additions, deletions } = countLineDiff(oldText, newText);
        return node('PullRequestChangedFile', {
          path: change.path,
          additions,
          deletions,
          changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'REMOVED' : 'MODIFIED',
        });
      });
      const page = all.slice(0, first);
      return node('PullRequestChangedFileConnection', {
        nodes: page,
        pageInfo: pageInfoOf(page.length, all.length),
        totalCount: all.length,
      });
    },
    mergedAt: (parent) => {
      const pull = (parent.__source as { pull: PullRequest }).pull;
      return pull.mergedAt;
    },
    author: () => userNode(),
    createdAt: (parent) => isoOf((parent.__source as { pull: PullRequest }).pull.createdSeq),
    updatedAt: (parent) => isoOf((parent.__source as { pull: PullRequest }).pull.updatedSeq),
  },
  __Schema: {
    queryType: () => namedTypeNode('Query')!,
    mutationType: () => namedTypeNode('Mutation')!,
    types: () => Object.keys(SCHEMA).map((name) => namedTypeNode(name)!),
    directives: () => [],
  },
  __Type: {
    name: (parent) => (parent.__source as { name: string | null }).name,
    kind: (parent) => (parent.__source as { kind: string }).kind,
    description: () => null,
    fields: (parent) => {
      const source = parent.__source as { name: string | null; kind: string };
      if (source.kind !== 'OBJECT' && source.kind !== 'INTERFACE') return null;
      const def = SCHEMA[source.name ?? ''];
      if (!def?.fields) return [];
      return Object.entries(def.fields).map(([name, field]) =>
        node('__Field', { name, type: field.type, args: field.args ?? {} }),
      );
    },
    enumValues: (parent) => {
      const source = parent.__source as { name: string | null; kind: string };
      if (source.kind !== 'ENUM') return null;
      const def = SCHEMA[source.name ?? ''];
      return (def?.enumValues ?? []).map((name) => node('__EnumValue', { name }));
    },
    inputFields: (parent) => {
      const source = parent.__source as { name: string | null; kind: string };
      if (source.kind !== 'INPUT_OBJECT') return null;
      const def = SCHEMA[source.name ?? ''];
      return Object.entries(def?.inputFields ?? {}).map(([name, type]) =>
        node('__InputValue', { name, type }),
      );
    },
    ofType: (parent) => {
      const source = parent.__source as { ofType?: unknown };
      return source.ofType ? typeNode(source.ofType as { name: string | null; kind: string; ofType?: unknown }) : null;
    },
    possibleTypes: (parent) => {
      const source = parent.__source as { name: string | null; kind: string };
      if (source.kind !== 'INTERFACE') return null;
      if (source.name === 'Node') return [...NODE_TYPES].map((name) => namedTypeNode(name)!);
      return [];
    },
    interfaces: (parent) => {
      const source = parent.__source as { name: string | null; kind: string };
      if (source.kind !== 'OBJECT') return null;
      const def = SCHEMA[source.name ?? ''];
      return (def?.interfaces ?? []).map((name) => namedTypeNode(name)!);
    },
  },
  __Field: {
    name: (parent) => (parent.__source as { name: string }).name,
    description: () => null,
    args: (parent) => {
      const source = parent.__source as { args: Record<string, string> };
      return Object.entries(source.args).map(([name, type]) => node('__InputValue', { name, type }));
    },
    type: (parent) => typeRefNode((parent.__source as { type: string }).type),
  },
  __InputValue: {
    name: (parent) => (parent.__source as { name: string }).name,
    description: () => null,
    type: (parent) => typeRefNode((parent.__source as { type: string }).type),
    defaultValue: () => null,
  },
  __EnumValue: {
    name: (parent) => (parent.__source as { name: string }).name,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
};

// ---------------------------------------------------------------------------
// connections
// ---------------------------------------------------------------------------

function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number.parseInt(match[1]!, 10) : null;
  } catch {
    return null;
  }
}

function pageInfoOf(shown: number, total: number, lastNumber: number | null = null): GqlNode {
  return node('PageInfo', {
    hasNextPage: shown < total,
    hasPreviousPage: false,
    startCursor: null,
    endCursor: lastNumber === null ? null : cursorOf(lastNumber),
  });
}

function issueConnection(repo: Repo, args: Record<string, unknown>): GqlNode {
  const first = typeof args.first === 'number' ? args.first : 30;
  const after = typeof args.after === 'string' ? decodeCursor(args.after) : null;
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = orderBy.direction === 'ASC' ? 'asc' : 'desc';
  let issues = [...repo.issues.values()];
  if (states) {
    const wanted = new Set(states.map((s) => s.toLowerCase()));
    issues = issues.filter((i) => wanted.has(i.state));
  }
  issues = [...issues].sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  if (after !== null) {
    issues = issues.filter((i) => (direction === 'asc' ? i.number > after : i.number < after));
  }
  const page = issues.slice(0, first);
  const nodes = page.map((issue) => issueNode(repo, issue));
  const edges = page.map((issue) => node('IssueEdge', { node: issueNode(repo, issue), cursor: cursorOf(issue.number) }));
  return node('IssueConnection', {
    nodes,
    edges,
    pageInfo: pageInfoOf(page.length, issues.length, page.length > 0 ? page[page.length - 1]!.number : null),
    totalCount: issues.length,
  });
}

function pullRequestConnection(repo: Repo, args: Record<string, unknown>): GqlNode {
  const first = typeof args.first === 'number' ? args.first : 30;
  const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
  const wanted = new Set(states.map((s) => s.toLowerCase()));
  let pulls = [...repo.pulls.values()].filter((p) => wanted.has(p.state === 'open' ? 'open' : 'closed'));
  pulls = [...pulls].sort((a, b) => b.createdSeq - a.createdSeq);
  const page = pulls.slice(0, first);
  const nodes = page.map((pull) => pullNode(repo, pull));
  return node('PullRequestConnection', {
    nodes,
    pageInfo: pageInfoOf(page.length, pulls.length),
    totalCount: pulls.length,
  });
}

function blobText(repo: Repo, oid: string): string {
  const obj = repo.objects.get(oid);
  return obj && obj.type === 'blob' ? obj.data.toString('utf8') : '';
}

function countLineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const left = oldCounts.get(line) ?? 0;
    if (left > 0) oldCounts.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of oldCounts.values()) deletions += left;
  return { additions, deletions };
}

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

function resolveField(parent: GqlNode, field: FieldNode, ctx: ExecContext, path: Array<string | number>): unknown {
  const responseKey = field.alias ?? field.name;
  const fieldPath = [...path, responseKey];
  if (field.name === '__typename') return parent.__typename;
  const def = SCHEMA[parent.__typename]?.fields?.[field.name];
  if (!def) {
    ctx.errors.push({
      message: `Cannot query field "${field.name}" on type "${parent.__typename}".`,
      path: fieldPath,
    });
    return null;
  }
  const args = resolveArgs(field, ctx);
  let value: unknown;
  try {
    const resolver = RESOLVERS[parent.__typename]?.[field.name];
    value = resolver ? resolver(parent, args, ctx) : defaultRead(parent, field.name);
  } catch (error) {
    ctx.errors.push({
      message: error instanceof Error ? error.message : String(error),
      path: fieldPath,
    });
    return null;
  }
  if (value === undefined) value = null;
  if (field.selections.length === 0) return value;
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      isGqlNode(item) ? executeSelectionSet(item, field.selections, ctx, [...fieldPath, index]) : item,
    );
  }
  if (isGqlNode(value)) return executeSelectionSet(value, field.selections, ctx, fieldPath);
  return value;
}

function isGqlNode(value: unknown): value is GqlNode {
  return typeof value === 'object' && value !== null && '__typename' in value && '__source' in value;
}

function executeSelectionSet(
  parent: GqlNode,
  selections: readonly SelectionNode[],
  ctx: ExecContext,
  path: Array<string | number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      out[selection.alias ?? selection.name] = resolveField(parent, selection, ctx, path);
    } else if (selection.kind === 'inline') {
      const condition = selection.typeCondition;
      if (condition === null || condition === parent.__typename || (condition === 'Node' && NODE_TYPES.has(parent.__typename))) {
        Object.assign(out, executeSelectionSet(parent, selection.selections, ctx, path));
      }
    } else {
      const fragment = ctx.document.fragments.get(selection.name);
      if (!fragment) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".`, path });
        continue;
      }
      if (fragment.typeCondition === parent.__typename || (fragment.typeCondition === 'Node' && NODE_TYPES.has(parent.__typename))) {
        Object.assign(out, executeSelectionSet(parent, fragment.selections, ctx, path));
      }
    }
  }
  return out;
}

export interface GraphQLOperationInput {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

export function executeOperation(
  forge: Forge,
  input: GraphQLOperationInput,
): Record<string, unknown> {
  const query = typeof input.query === 'string' ? input.query : '';
  const variables =
    input.variables && typeof input.variables === 'object' && !Array.isArray(input.variables)
      ? (input.variables as Record<string, unknown>)
      : {};
  const operationName = typeof input.operationName === 'string' ? input.operationName : null;
  let document: Document;
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  const operation =
    document.operations.find((op) => op.name === operationName) ??
    (operationName === null && document.operations.length === 1 ? document.operations[0]! : undefined);
  if (!operation) {
    return { data: null, errors: [{ message: operationName ? `Unknown operation named "${operationName}".` : 'Must provide an operation.' }] };
  }
  const ctx: ExecContext = { forge, variables, errors: [], document };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const root = node(rootType, {});
  let data: Record<string, unknown>;
  try {
    data = executeSelectionSet(root, operation.selections, ctx, []);
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

export async function handleGraphQL(
  forge: Forge,
  token: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const header = req.headers.authorization ?? '';
  const ok = token === '' ? header.startsWith('Bearer ') && header.length > 7 : header === `Bearer ${token}`;
  if (!ok) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return true;
  }
  let body: Buffer;
  try {
    body = await readBody(req);
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Request body is too large' }] });
    return true;
  }
  let parsed: unknown;
  try {
    parsed = parseJsonBody(body);
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Request body is not valid JSON' }] });
    return true;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) =>
      entry && typeof entry === 'object' ? executeOperation(forge, entry as GraphQLOperationInput) : { data: null, errors: [{ message: 'Invalid operation' }] },
    );
    sendJson(res, 200, results);
    return true;
  }
  if (parsed === null || typeof parsed !== 'object') {
    sendJson(res, 400, { errors: [{ message: 'Request body must be a JSON object' }] });
    return true;
  }
  sendJson(res, 200, executeOperation(forge, parsed as GraphQLOperationInput));
  return true;
}
