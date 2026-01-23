import type { OpenAPIV3 } from 'openapi-types';

export class RefResolver {
  private spec: OpenAPIV3.Document;
  private visitedRefs: Set<string>;

  constructor(spec: OpenAPIV3.Document) {
    this.spec = spec;
    this.visitedRefs = new Set();
  }

  /**
   * Resolve a $ref string to its actual value in the spec
   */
  resolveRef(ref: string): unknown {
    // Parse the ref path (e.g., "#/components/schemas/User")
    if (!ref.startsWith('#/')) {
      return { $unresolvableRef: ref };
    }

    const path = ref.slice(2).split('/');
    let current: unknown = this.spec;

    for (const segment of path) {
      // Handle URL-encoded characters in path segments
      const decodedSegment = decodeURIComponent(segment.replace(/~1/g, '/').replace(/~0/g, '~'));
      if (current && typeof current === 'object' && decodedSegment in current) {
        current = (current as Record<string, unknown>)[decodedSegment];
      } else {
        return { $unresolvableRef: ref };
      }
    }

    return current;
  }

  /**
   * Recursively resolve all $refs in an object up to a maximum depth
   */
  resolveAllRefs(obj: unknown, maxDepth: number = 5, currentDepth: number = 0): unknown {
    if (currentDepth >= maxDepth) {
      return obj;
    }

    if (obj === null || obj === undefined) {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map(item => this.resolveAllRefs(item, maxDepth, currentDepth));
    }

    if (typeof obj !== 'object') {
      return obj;
    }

    const typedObj = obj as Record<string, unknown>;

    // Check if this is a $ref object
    if ('$ref' in typedObj && typeof typedObj.$ref === 'string') {
      const ref = typedObj.$ref;

      // Check for circular reference
      if (this.visitedRefs.has(ref)) {
        return { $circularRef: ref };
      }

      this.visitedRefs.add(ref);
      const resolved = this.resolveRef(ref);
      const result = this.resolveAllRefs(resolved, maxDepth, currentDepth + 1);
      this.visitedRefs.delete(ref);

      return result;
    }

    // Recursively resolve all properties
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(typedObj)) {
      result[key] = this.resolveAllRefs(value, maxDepth, currentDepth);
    }

    return result;
  }

  /**
   * Reset the visited refs set (call between resolutions)
   */
  reset(): void {
    this.visitedRefs.clear();
  }
}
