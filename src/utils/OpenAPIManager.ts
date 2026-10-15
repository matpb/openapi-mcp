import type { OpenAPIV3 } from 'openapi-types';
import { parse as parseYaml } from 'yaml';
import { config } from '../config.js';
import { RefResolver } from './RefResolver.js';

export interface EndpointInfo {
  path: string;
  method: string;
  summary?: string;
  description?: string;
  tags?: string[];
  operationId?: string;
}

export interface SchemaInfo {
  name: string;
  type?: string;
  properties?: string[];
  description?: string;
}

export interface GuideInfo {
  id: string;
  title: string;
  group: string;
  summary: string | null;
  verifiedAgainst: Record<string, string>;
  markdown: string;
}

export interface GuideOverview {
  id: 'overview';
  alias: string | null;
  title: string;
  summary: string | null;
  verifiedAgainst: Record<string, string>;
  markdown: string;
}

export interface GuideGroup {
  name: string;
  guides: GuideInfo[];
}

export interface GuideIndex {
  overview: GuideOverview | null;
  guides: GuideInfo[];
  groups: GuideGroup[];
  tags: Map<object, string>; // indexed guide tag object -> normalised guide id
}

export interface DocSearchResult {
  source: 'overview' | 'guide' | 'endpoint';
  id?: string;
  title: string;
  method?: string;
  path?: string;
  snippet: string;
}

interface GuideMeta {
  id: string;
  group?: unknown;
  order?: unknown;
  summary?: unknown;
  verified_against?: unknown;
}

type GuideTag = OpenAPIV3.TagObject & {
  'x-displayName'?: string;
  'x-guide': GuideMeta;
};

interface DocEntry {
  base: Omit<DocSearchResult, 'snippet'>;
  head: string[];
  body: string[];
  aliases?: string[]; // guide:<id> names, searchable only by a query that starts with guide:
}

interface CachedSpec {
  spec: OpenAPIV3.Document;
  fetchedAt: number;
  endpointIndex: EndpointInfo[];
  schemaIndex: SchemaInfo[];
  guideIndex: GuideIndex;
  docIndex?: DocEntry[];
}

const SNIPPET_MAX = 240;
const RETRY_BACKOFF_MS = 60_000;
const OTHER_GROUP = 'Other';
const EMPTY_GUIDE_INDEX: GuideIndex = { overview: null, guides: [], groups: [], tags: new Map() };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isGuideTag(tag: unknown): tag is GuideTag {
  if (!isRecord(tag) || typeof tag.name !== 'string') return false;
  const meta = tag['x-guide'];
  return isRecord(meta) && typeof meta.id === 'string';
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function normaliseGuideId(id: string): string {
  return id.trim().replace(/^(?:guide:\s*)+/, '').trim();
}

function groupName(value: unknown): string {
  return stringOrNull(value)?.trim() ?? OTHER_GROUP;
}

function guideOrder(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Infinity;
}

function firstMatch(texts: string[], pattern: RegExp): { text: string; match: RegExpExecArray } | null {
  for (const text of texts) {
    const match = pattern.exec(text);
    if (match) return { text, match };
  }
  return null;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function firstHeading(markdown: string): string | undefined {
  let fence: { char: string; length: number } | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (marker && !(marker[1][0] === '`' && marker[2].includes('`'))) {
      fence = { char: marker[1][0], length: marker[1].length };
      continue;
    }
    const title = /^ {0,3}# +(.+?)(?:\s+#+)?\s*$/.exec(line)?.[1];
    if (title) return title;
  }
  return undefined;
}

function collapse(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  return text.replace(/\s+/g, ' ').trim() || null;
}

function isHighSurrogate(char: string | undefined): boolean {
  return char !== undefined && char >= '\uD800' && char <= '\uDBFF';
}

function isLowSurrogate(char: string | undefined): boolean {
  return char !== undefined && char >= '\uDC00' && char <= '\uDFFF';
}

function buildSnippet(flat: string, match: RegExpExecArray): string {
  const index = match.index;
  const length = match[0].length;
  let start = length > SNIPPET_MAX
    ? index
    : Math.max(0, index - Math.floor((SNIPPET_MAX - length) / 2));
  if (start > 0 && isLowSurrogate(flat[start]) && isHighSurrogate(flat[start - 1])) start--;
  let end = Math.min(flat.length, start + SNIPPET_MAX);
  if (end < flat.length && isHighSurrogate(flat[end - 1]) && isLowSurrogate(flat[end])) end--;
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

class OpenAPIManager {
  private cache: CachedSpec | null = null;
  private fetchPromise: Promise<OpenAPIV3.Document> | null = null;

  /**
   * Get the OpenAPI spec, fetching if necessary
   */
  async getSpec(): Promise<OpenAPIV3.Document> {
    // Return cached if still valid
    if (this.cache && Date.now() - this.cache.fetchedAt < config.openapi.cacheTtl) {
      return this.cache.spec;
    }

    // Concurrent callers share one fetch and one stale-cache fallback
    this.fetchPromise ??= this.refresh();

    try {
      return await this.fetchPromise;
    } catch (error) {
      if (this.cache) {
        console.error('[OpenAPIManager] Fetch failed, using stale cache:', error);
        return this.cache.spec;
      }
      throw error;
    }
  }

  private async refresh(): Promise<OpenAPIV3.Document> {
    try {
      const spec = await this.fetchSpec();
      this.cache = {
        spec,
        fetchedAt: Date.now(),
        endpointIndex: this.buildEndpointIndex(spec),
        schemaIndex: this.buildSchemaIndex(spec),
        guideIndex: this.buildGuideIndex(spec),
      };
      return spec;
    } catch (error) {
      // Keep serving the stale cache for the backoff instead of refetching on every call
      if (this.cache) this.cache.fetchedAt = Date.now() - Math.max(0, config.openapi.cacheTtl - RETRY_BACKOFF_MS);
      throw error;
    } finally {
      this.fetchPromise = null;
    }
  }

  /**
   * Fetch the OpenAPI spec from the configured URL
   */
  private async fetchSpec(): Promise<OpenAPIV3.Document> {
    console.error(`[OpenAPIManager] Fetching spec from ${config.openapi.specUrl}`);

    const headers: Record<string, string> = {
      'Accept': 'application/json, application/x-yaml, text/yaml, */*',
    };

    if (config.openapi.apiKey) {
      headers['X-API-Key'] = config.openapi.apiKey;
    }

    const response = await fetch(config.openapi.specUrl, { headers, signal: AbortSignal.timeout(config.openapi.fetchTimeout) });

    if (!response.ok) {
      throw new Error(`Failed to fetch OpenAPI spec: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();

    let spec: OpenAPIV3.Document;

    // Try to parse as JSON first, fall back to YAML
    if (contentType.includes('json')) {
      spec = JSON.parse(text) as OpenAPIV3.Document;
    } else if (contentType.includes('yaml') || contentType.includes('yml')) {
      spec = parseYaml(text) as OpenAPIV3.Document;
    } else {
      // Auto-detect: try JSON first, then YAML
      try {
        spec = JSON.parse(text) as OpenAPIV3.Document;
      } catch {
        spec = parseYaml(text) as OpenAPIV3.Document;
      }
    }

    console.error(`[OpenAPIManager] Spec fetched successfully`);
    return spec;
  }

  /**
   * Build an index of all endpoints for fast searching
   */
  private buildEndpointIndex(spec: OpenAPIV3.Document): EndpointInfo[] {
    const endpoints: EndpointInfo[] = [];

    if (!spec.paths) return endpoints;

    for (const [path, pathItem] of Object.entries(spec.paths)) {
      if (!pathItem) continue;

      const methods = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'] as const;

      for (const method of methods) {
        const operation = (pathItem as Record<string, unknown>)[method] as OpenAPIV3.OperationObject | undefined;
        if (operation) {
          endpoints.push({
            path,
            method: method.toUpperCase(),
            summary: operation.summary,
            description: operation.description,
            tags: operation.tags,
            operationId: operation.operationId,
          });
        }
      }
    }

    return endpoints;
  }

  /**
   * Build an index of all schemas for fast searching
   */
  private buildSchemaIndex(spec: OpenAPIV3.Document): SchemaInfo[] {
    const schemas: SchemaInfo[] = [];

    const components = spec.components?.schemas;
    if (!components) return schemas;

    for (const [name, schema] of Object.entries(components)) {
      if (!schema || '$ref' in schema) continue;

      const schemaObj = schema as OpenAPIV3.SchemaObject;
      schemas.push({
        name,
        type: schemaObj.type,
        properties: schemaObj.properties ? Object.keys(schemaObj.properties) : undefined,
        description: schemaObj.description,
      });
    }

    return schemas;
  }

  /**
   * Build an index of the overview and the guide tags; a malformed spec yields an empty index
   */
  private buildGuideIndex(spec: OpenAPIV3.Document): GuideIndex {
    try {
      return this.collectGuides(spec);
    } catch (error) {
      console.error(`[OpenAPIManager] Guide index failed, using an empty one: ${error instanceof Error ? error.message : String(error)}`);
      return EMPTY_GUIDE_INDEX;
    }
  }

  private collectGuides(spec: OpenAPIV3.Document): GuideIndex {
    const info: Record<string, unknown> = isRecord(spec.info) ? spec.info : {};
    const description = typeof info.description === 'string' ? info.description : '';
    const meta: Record<string, unknown> = isRecord(info['x-guide']) ? info['x-guide'] : {};
    const overview: GuideOverview | null = description.trim()
      ? {
          id: 'overview',
          alias: (typeof meta.id === 'string' && normaliseGuideId(meta.id)) || null,
          title: firstHeading(description) ?? stringOrNull(info.title) ?? 'Overview',
          summary: stringOrNull(meta.summary),
          verifiedAgainst: stringRecord(meta.verified_against),
          markdown: description,
        }
      : null;

    const candidates = new Map<string, { tag: GuideTag; id: string; order: number }>();
    const ids = new Set<string>(overview ? ['overview', ...(overview.alias ? [overview.alias] : [])] : []);
    for (const tag of Array.isArray(spec.tags) ? spec.tags : []) {
      if (!isGuideTag(tag)) continue;
      const meta = tag['x-guide'];
      const id = normaliseGuideId(meta.id);
      if (candidates.has(tag.name)) {
        console.error(`[OpenAPIManager] Skipping guide tag ${tag.name}: another guide tag has the same name`);
        continue;
      }
      if (!id || ids.has(id)) {
        console.error(`[OpenAPIManager] Skipping guide tag ${tag.name}: id "${meta.id}" is empty, reserved or already used`);
        continue;
      }
      ids.add(id);
      candidates.set(tag.name, { tag, id, order: guideOrder(meta.order) });
    }

    const groupTags = new Map<string, string[]>(); // group name -> tag names, first-seen order
    const placed = new Map<string, string>(); // tag name -> group name
    const place = (name: string, tagName: string) => {
      placed.set(tagName, name);
      const members = groupTags.get(name);
      if (members) members.push(tagName);
      else groupTags.set(name, [tagName]);
    };
    const tagGroups = (spec as unknown as Record<string, unknown>)['x-tagGroups'];
    for (const entry of Array.isArray(tagGroups) ? tagGroups : []) {
      if (!isRecord(entry) || typeof entry.name !== 'string' || !Array.isArray(entry.tags)) continue;
      const name = groupName(entry.name);
      for (const tagName of entry.tags) {
        if (typeof tagName === 'string' && candidates.has(tagName) && !placed.has(tagName)) place(name, tagName);
      }
    }
    for (const [tagName, { tag }] of candidates) {
      if (!placed.has(tagName)) place(groupName(tag['x-guide'].group), tagName);
    }

    const byTag = new Map<string, GuideInfo>();
    const tags = new Map<object, string>();
    for (const [tagName, { tag, id }] of candidates) {
      const meta = tag['x-guide'];
      const markdown = stringOrNull(tag.description) ?? '';
      byTag.set(tagName, {
        id,
        title: stringOrNull(tag['x-displayName']) ?? firstHeading(markdown) ?? id,
        group: placed.get(tagName) ?? OTHER_GROUP,
        summary: stringOrNull(meta.summary),
        verifiedAgainst: stringRecord(meta.verified_against),
        markdown,
      });
      tags.set(tag, id);
    }

    const orderOf = (tagName: string) => candidates.get(tagName)?.order ?? Infinity;
    const groups: GuideGroup[] = [...groupTags].map(([name, tagNames]) => ({
      name,
      guides: [...tagNames]
        .sort((a, b) => (orderOf(a) === orderOf(b) ? 0 : orderOf(a) < orderOf(b) ? -1 : 1))
        .flatMap(tagName => byTag.get(tagName) ?? []),
    }));

    return { overview, guides: [...byTag.values()], groups, tags };
  }

  /**
   * Precompute the whitespace-collapsed search texts, in spec order: overview, guides, endpoints.
   */
  private buildDocIndex(guideIndex: GuideIndex, endpoints: EndpointInfo[]): DocEntry[] {
    const entries: DocEntry[] = [];
    const add = (base: DocEntry['base'], headTexts: unknown[], bodyTexts: unknown[], aliases?: string[]) => {
      const texts = (values: unknown[]) => values.flatMap(value => collapse(value) ?? []);
      const head = texts(headTexts);
      const body = texts(bodyTexts);
      if (head.length + body.length > 0) entries.push({ base, head, body, aliases });
    };

    const { overview, guides } = guideIndex;
    if (overview) {
      add(
        { source: 'overview', id: overview.id, title: overview.title },
        [overview.title, overview.id, overview.alias, overview.summary],
        [overview.markdown],
        [overview.id, ...(overview.alias ? [overview.alias] : [])].map(id => `guide:${id}`),
      );
    }
    for (const guide of guides) {
      add({ source: 'guide', id: guide.id, title: guide.title }, [guide.title, guide.id, guide.summary], [guide.markdown], [`guide:${guide.id}`]);
    }
    for (const endpoint of endpoints) {
      add(
        {
          source: 'endpoint',
          title: endpoint.summary || `${endpoint.method} ${endpoint.path}`,
          method: endpoint.method,
          path: endpoint.path,
        },
        [],
        [endpoint.description, endpoint.summary, endpoint.path, endpoint.operationId],
      );
    }
    return entries;
  }

  /**
   * List the overview and the guides grouped as in the spec
   */
  async listGuides() {
    const { overview, groups } = (await this.getCache()).guideIndex;
    return {
      overview: overview ? { id: overview.id, title: overview.title, summary: overview.summary } : null,
      groups: groups.map(group => ({
        name: group.name,
        guides: group.guides.map(({ id, title, summary }) => ({ id, title, summary })),
      })),
    };
  }

  /**
   * Get one guide, or the overview, by id (with or without the guide: prefix)
   */
  async getGuide(id: string): Promise<GuideInfo> {
    const { overview, guides } = (await this.getCache()).guideIndex;
    const bareId = normaliseGuideId(id);

    if (overview && (bareId === overview.id || bareId === overview.alias)) {
      return {
        id: overview.id,
        title: overview.title,
        group: 'Overview',
        summary: overview.summary,
        verifiedAgainst: overview.verifiedAgainst,
        markdown: overview.markdown,
      };
    }

    const guide = guides.find(g => g.id === bareId);
    if (!guide) {
      const available = [...(overview ? [overview.id] : []), ...guides.map(g => g.id)];
      throw new Error(`Guide not found: ${id}. Available: ${available.join(', ') || 'none'}`);
    }
    return guide;
  }

  /**
   * Search the overview, guides and endpoints: whitespace-separated terms, all required, case-insensitive substrings.
   * Hits with every term in the title/id/summary rank first, then body-only guide hits, then endpoints; spec order within a tier.
   */
  async searchDocs(query: string, limit: number = 10, offset: number = 0): Promise<{
    query: string;
    total: number;
    pagination: { total: number; limit: number; offset: number; hasMore: boolean };
    results: DocSearchResult[];
  }> {
    const needle = collapse(query);
    if (!needle) {
      throw new Error('Query must not be empty');
    }
    const cache = await this.getCache();
    cache.docIndex ??= this.buildDocIndex(cache.guideIndex, cache.endpointIndex);
    const patterns = needle.split(' ').map(term => new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    const guideQuery = needle.toLowerCase().startsWith('guide:');
    const hits: { tier: number; base: DocEntry['base']; text: string; match: RegExpExecArray }[] = [];

    for (const { base, head: plainHead, body, aliases } of cache.docIndex) {
      const head = aliases && guideQuery ? [...plainHead, ...aliases] : plainHead;
      const inHead = (pattern: RegExp) => head.some(text => pattern.test(text));
      if (!patterns.every(pattern => inHead(pattern) || body.some(text => pattern.test(text)))) continue;
      const found = firstMatch(body, patterns[0]) ?? firstMatch(head, patterns[0]);
      if (!found) continue;
      hits.push({ tier: base.source === 'endpoint' ? 2 : patterns.every(inHead) ? 0 : 1, base, ...found });
    }

    hits.sort((a, b) => a.tier - b.tier);
    const total = hits.length;
    const results = hits.slice(offset, offset + limit).map(({ base, text, match }) => ({ ...base, snippet: buildSnippet(text, match) }));
    return {
      query,
      total,
      pagination: { total, limit, offset, hasMore: offset + results.length < total },
      results,
    };
  }

  private async getCache(): Promise<CachedSpec> {
    await this.getSpec(); // Ensure cache is populated

    if (!this.cache) {
      throw new Error('Failed to load OpenAPI spec');
    }

    return this.cache;
  }

  /**
   * Search endpoints by criteria
   */
  async searchEndpoints(options: {
    pathPattern?: string;
    method?: string;
    tags?: string[];
    description?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ endpoints: EndpointInfo[]; total: number }> {
    await this.getSpec(); // Ensure cache is populated

    if (!this.cache) {
      throw new Error('Failed to load OpenAPI spec');
    }

    let results = [...this.cache.endpointIndex];

    // Filter by path pattern
    if (options.pathPattern) {
      const regex = new RegExp(options.pathPattern, 'i');
      results = results.filter(e => regex.test(e.path));
    }

    // Filter by method
    if (options.method) {
      const method = options.method.toUpperCase();
      results = results.filter(e => e.method === method);
    }

    // Filter by tags
    if (options.tags && options.tags.length > 0) {
      results = results.filter(e =>
        e.tags && options.tags!.some(tag => e.tags!.includes(tag))
      );
    }

    // Filter by description
    if (options.description) {
      const regex = new RegExp(options.description, 'i');
      results = results.filter(e =>
        (e.summary && regex.test(e.summary)) ||
        (e.description && regex.test(e.description))
      );
    }

    const total = results.length;
    const offset = options.offset || 0;
    const limit = options.limit || 20;

    return {
      endpoints: results.slice(offset, offset + limit),
      total,
    };
  }

  /**
   * Get detailed endpoint information
   */
  async getEndpointDetails(path: string, method: string, resolveRefs: boolean = true): Promise<unknown> {
    const spec = await this.getSpec();

    const pathItem = spec.paths?.[path];
    if (!pathItem) {
      throw new Error(`Path not found: ${path}`);
    }

    const operation = pathItem[method.toLowerCase() as keyof OpenAPIV3.PathItemObject] as OpenAPIV3.OperationObject | undefined;
    if (!operation) {
      throw new Error(`Method ${method} not found for path ${path}`);
    }

    // Include path-level parameters
    const pathParams = pathItem.parameters || [];
    const allParams = [...pathParams, ...(operation.parameters || [])];

    const result = {
      path,
      method: method.toUpperCase(),
      ...operation,
      parameters: allParams.length > 0 ? allParams : undefined,
    };

    if (resolveRefs) {
      const resolver = new RefResolver(spec);
      return resolver.resolveAllRefs(result);
    }

    return result;
  }

  /**
   * Search schemas by criteria
   */
  async searchSchemas(options: {
    namePattern?: string;
    propertyName?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ schemas: SchemaInfo[]; total: number }> {
    await this.getSpec(); // Ensure cache is populated

    if (!this.cache) {
      throw new Error('Failed to load OpenAPI spec');
    }

    let results = [...this.cache.schemaIndex];

    // Filter by name pattern
    if (options.namePattern) {
      const regex = new RegExp(options.namePattern, 'i');
      results = results.filter(s => regex.test(s.name));
    }

    // Filter by property name
    if (options.propertyName) {
      const propLower = options.propertyName.toLowerCase();
      results = results.filter(s =>
        s.properties && s.properties.some(p => p.toLowerCase().includes(propLower))
      );
    }

    const total = results.length;
    const offset = options.offset || 0;
    const limit = options.limit || 20;

    return {
      schemas: results.slice(offset, offset + limit),
      total,
    };
  }

  /**
   * Get detailed schema information
   */
  async getSchemaDetails(schemaName: string, resolveRefs: boolean = true, maxDepth: number = 5): Promise<unknown> {
    const spec = await this.getSpec();

    const schema = spec.components?.schemas?.[schemaName];
    if (!schema) {
      throw new Error(`Schema not found: ${schemaName}`);
    }

    if (resolveRefs) {
      const resolver = new RefResolver(spec);
      return {
        name: schemaName,
        schema: resolver.resolveAllRefs(schema, maxDepth),
      };
    }

    return {
      name: schemaName,
      schema,
    };
  }

  /**
   * Get a section of the spec
   */
  async getSpecSection(section?: string, pathFilter?: string): Promise<unknown> {
    const { spec, guideIndex } = await this.getCache();
    const slimmed = !section || section === 'full' || section === 'info' || section === 'tags';
    const slim = slimmed ? this.slimGuideText(spec, guideIndex) : spec;

    if (!section || section === 'full') {
      return pathFilter ? this.filterSpecByPath(slim, pathFilter) : slim;
    }

    switch (section) {
      case 'info':
        return slim.info;
      case 'paths':
        if (pathFilter) {
          return this.filterPaths(spec.paths || {}, pathFilter);
        }
        return spec.paths;
      case 'components':
        return spec.components;
      case 'tags':
        return slim.tags;
      case 'servers':
        return spec.servers;
      default:
        throw new Error(`Unknown section: ${section}. Valid sections: info, paths, components, tags, servers, full`);
    }
  }

  /**
   * Replace the overview text in info and the indexed guide tag descriptions by pointers to get_guide;
   * a spec without indexed guide tags is returned as is
   */
  private slimGuideText(spec: OpenAPIV3.Document, guideIndex: GuideIndex): OpenAPIV3.Document {
    if (guideIndex.tags.size === 0) return spec;
    const slim = { ...spec };
    if (guideIndex.overview && isRecord(spec.info)) {
      slim.info = { ...spec.info, description: 'Overview guide: get_guide { id: "overview" }' };
    }
    if (Array.isArray(spec.tags)) {
      slim.tags = spec.tags.map(tag => {
        const id = isRecord(tag) ? guideIndex.tags.get(tag) : undefined;
        if (id === undefined) return tag;
        const { description: _description, ...rest } = tag;
        return { ...rest, 'x-note': `Full text: get_guide { id: ${JSON.stringify(id)} }` };
      });
    }
    return slim;
  }

  /**
   * Filter paths by regex pattern
   */
  private filterPaths(paths: OpenAPIV3.PathsObject, pattern: string): OpenAPIV3.PathsObject {
    const regex = new RegExp(pattern, 'i');
    const filtered: OpenAPIV3.PathsObject = {};

    for (const [path, pathItem] of Object.entries(paths)) {
      if (regex.test(path)) {
        filtered[path] = pathItem;
      }
    }

    return filtered;
  }

  /**
   * Filter full spec to only include matching paths
   */
  private filterSpecByPath(spec: OpenAPIV3.Document, pattern: string): OpenAPIV3.Document {
    return {
      ...spec,
      paths: this.filterPaths(spec.paths || {}, pattern),
    };
  }

  /**
   * Clear the cache
   */
  clearCache(): void {
    this.cache = null;
  }
}

export const openAPIManager = new OpenAPIManager();
