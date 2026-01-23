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

interface CachedSpec {
  spec: OpenAPIV3.Document;
  fetchedAt: number;
  endpointIndex: EndpointInfo[];
  schemaIndex: SchemaInfo[];
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

    // If a fetch is already in progress, wait for it
    if (this.fetchPromise) {
      return this.fetchPromise;
    }

    // Fetch new spec
    this.fetchPromise = this.fetchSpec();

    try {
      const spec = await this.fetchPromise;
      this.cache = {
        spec,
        fetchedAt: Date.now(),
        endpointIndex: this.buildEndpointIndex(spec),
        schemaIndex: this.buildSchemaIndex(spec),
      };
      return spec;
    } catch (error) {
      // If fetch fails and we have cache, return stale cache
      if (this.cache) {
        console.error('[OpenAPIManager] Fetch failed, using stale cache:', error);
        return this.cache.spec;
      }
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

    const response = await fetch(config.openapi.specUrl, { headers });

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
    const spec = await this.getSpec();

    if (!section || section === 'full') {
      if (pathFilter) {
        return this.filterSpecByPath(spec, pathFilter);
      }
      return spec;
    }

    switch (section) {
      case 'info':
        return spec.info;
      case 'paths':
        if (pathFilter) {
          return this.filterPaths(spec.paths || {}, pathFilter);
        }
        return spec.paths;
      case 'components':
        return spec.components;
      case 'tags':
        return spec.tags;
      case 'servers':
        return spec.servers;
      default:
        throw new Error(`Unknown section: ${section}. Valid sections: info, paths, components, tags, servers, full`);
    }
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
