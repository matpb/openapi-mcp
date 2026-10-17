import { before, after, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

type Json = any;

const PAD = 'Filler sentence about nothing. '.repeat(30);

const guideTags = [
  {
    name: 'guide:core-concepts',
    'x-displayName': 'Core concepts',
    description: `# Core concepts\n\n${PAD}The Actor is whoever performs an action. ${PAD}`,
    'x-guide': {
      id: 'core-concepts',
      group: 'Platform',
      order: 1,
      summary: 'The vocabulary of the platform',
      verified_against: { 'backend': 'abc1234' },
    },
  },
  {
    name: 'guide:feed',
    'x-displayName': 'Feed',
    description: '# Feed\n\nHow feed card ordering works.',
    'x-guide': {
      id: 'feed',
      group: 'Features',
      order: 1,
      summary: 'How the feed is built',
      verified_against: { 'backend': 'def5678' },
    },
  },
];

const fixture = {
  openapi: '3.1.0',
  info: {
    title: 'Fixture API',
    version: '1',
    description: '# Fixture platform\n\nIntro about ice and the feed.',
  },
  tags: [
    ...guideTags,
    { name: 'Feed', description: 'Feed endpoints' },
    { name: 'Entity', description: 'Entity endpoints' },
  ],
  'x-tagGroups': [
    { name: 'Platform', tags: ['guide:core-concepts'] },
    { name: 'Features', tags: ['guide:feed'] },
    { name: 'Ghost', tags: ['Entity'] },
    { name: 'API reference', tags: ['Feed', 'Entity'] },
  ],
  paths: {
    '/api/v2/feed': {
      get: { tags: ['Feed'], summary: 'List the feed', responses: { '200': { description: 'ok' } } },
    },
    '/api/v2/entity/{id}': {
      get: {
        tags: ['Entity'],
        summary: 'Show an entity',
        description: 'Returns the entity and its actor.',
        responses: { '200': { description: 'ok' } },
      },
    },
  },
};

const noGuides = {
  openapi: '3.1.0',
  info: { title: 'Plain API', version: '1', description: 'Plain text without a heading.' },
  tags: [{ name: 'Feed', description: 'Feed endpoints' }],
  paths: {},
};

const noDescription = {
  openapi: '3.1.0',
  info: { title: 'Bare API', version: '1' },
  paths: {},
};

let current: unknown = fixture;
let failing = false;
let requests = 0;
let server: Server;
let manager: { clearCache(): void };

async function useSpec(spec: unknown) {
  current = spec;
  manager.clearCache();
}

async function tool(file: string): Promise<Json> {
  const mod = await import(`../tools/${file}.js`);
  return new mod.default();
}

before(async () => {
  server = createServer((_req, res) => {
    requests++;
    if (failing) {
      res.statusCode = 500;
      res.end('boom');
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(current));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  process.env.OPENAPI_SPEC_URL = `http://127.0.0.1:${port}/openapi.json`;
  process.env.SPEC_CACHE_TTL = '300';
  process.env.SPEC_FETCH_TIMEOUT = '7';
  manager = (await import('../utils/OpenAPIManager.js')).openAPIManager;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('list_guides', () => {
  it('lists groups in x-tagGroups order with their guides, overview title from the first heading', async () => {
    await useSpec(fixture);
    const { success, data } = await (await tool('ListGuidesTool')).execute({});
    assert.equal(success, true);
    assert.deepEqual(data.overview, { id: 'overview', title: 'Fixture platform', summary: null });
    assert.deepEqual(data.groups, [
      { name: 'Platform', guides: [{ id: 'core-concepts', title: 'Core concepts', summary: 'The vocabulary of the platform' }] },
      { name: 'Features', guides: [{ id: 'feed', title: 'Feed', summary: 'How the feed is built' }] },
    ]);
  });

  it('returns no groups for a spec without guide tags and falls back to info.title', async () => {
    await useSpec(noGuides);
    const { data } = await (await tool('ListGuidesTool')).execute({});
    assert.deepEqual(data.groups, []);
    assert.deepEqual(data.overview, { id: 'overview', title: 'Plain API', summary: null });
  });

  it('returns a null overview when info.description is absent', async () => {
    await useSpec(noDescription);
    const { data } = await (await tool('ListGuidesTool')).execute({});
    assert.equal(data.overview, null);
    assert.deepEqual(data.groups, []);
  });
});

describe('get_guide', () => {
  it('returns a guide by bare id', async () => {
    await useSpec(fixture);
    const { success, data } = await (await tool('GetGuideTool')).execute({ id: 'feed' });
    assert.equal(success, true);
    assert.deepEqual(data, {
      id: 'feed',
      title: 'Feed',
      group: 'Features',
      summary: 'How the feed is built',
      verifiedAgainst: { 'backend': 'def5678' },
      markdown: '# Feed\n\nHow feed card ordering works.',
    });
  });

  it('accepts the guide: prefixed id', async () => {
    await useSpec(fixture);
    const { data } = await (await tool('GetGuideTool')).execute({ id: 'guide:feed' });
    assert.equal(data.id, 'feed');
    assert.equal(data.title, 'Feed');
    assert.equal(data.markdown, '# Feed\n\nHow feed card ordering works.');
  });

  it('returns the overview from info.description', async () => {
    await useSpec(fixture);
    const { data } = await (await tool('GetGuideTool')).execute({ id: 'overview' });
    assert.deepEqual(data, {
      id: 'overview',
      title: 'Fixture platform',
      group: 'Overview',
      summary: null,
      verifiedAgainst: {},
      markdown: '# Fixture platform\n\nIntro about ice and the feed.',
    });
  });

  it('reads the overview metadata from info.x-guide and accepts its own id', async () => {
    const withMeta = structuredClone(fixture) as { info: Record<string, unknown> };
    withMeta.info['x-guide'] = { id: 'platform-overview', summary: 'What the platform is', verified_against: { 'backend': 'abc1234', bad: 5 } };
    await useSpec(withMeta);
    const { data } = await (await tool('GetGuideTool')).execute({ id: 'platform-overview' });
    assert.equal(data.id, 'overview');
    assert.equal(data.summary, 'What the platform is');
    assert.deepEqual(data.verifiedAgainst, { 'backend': 'abc1234' });
    const list = await (await tool('ListGuidesTool')).execute({});
    assert.equal(list.data.overview.summary, 'What the platform is');
  });

  it('ignores an overview id that is empty once normalised', async () => {
    const withMeta = structuredClone(fixture) as { info: Record<string, unknown> };
    for (const id of ['guide:', '  ', 'guide:  guide: ']) {
      withMeta.info['x-guide'] = { id };
      await useSpec(withMeta);
      await assert.rejects((await tool('GetGuideTool')).execute({ id: 'guide:' }), /Guide not found/);
    }
  });

  it('rejects an unknown id with a message listing the available ids', async () => {
    await useSpec(fixture);
    const t = await tool('GetGuideTool');
    await assert.rejects(t.execute({ id: 'nope' }), (err: Error) => {
      assert.match(err.message, /feed/);
      assert.match(err.message, /core-concepts/);
      return true;
    });
  });

  it('toolCall reports an unknown id as isError', async () => {
    await useSpec(fixture);
    const res = await (await tool('GetGuideTool')).toolCall({ params: { arguments: { id: 'nope' } } });
    assert.equal(res.isError, true);
  });
});

describe('search_docs', () => {
  it('finds an Actor mention case-insensitively, guide before endpoint, with a bounded snippet', async () => {
    await useSpec(fixture);
    const { success, data } = await (await tool('SearchDocsTool')).execute({ query: 'ACTOR' });
    assert.equal(success, true);
    assert.equal(data.query, 'ACTOR');
    assert.equal(data.total, 2);
    assert.deepEqual(data.results.map((r: Json) => r.source), ['guide', 'endpoint']);
    const [guide, endpoint] = data.results;
    assert.equal(guide.id, 'core-concepts');
    assert.equal(guide.title, 'Core concepts');
    assert.equal(endpoint.method, 'GET');
    assert.equal(endpoint.path, '/api/v2/entity/{id}');
    for (const r of data.results) {
      const bare = r.snippet.replace(/^…|…$/g, '');
      assert.ok(bare.length <= 240, `snippet too long: ${bare.length}`);
      assert.ok(r.snippet.toLowerCase().includes('actor'), `snippet misses the match: ${r.snippet}`);
    }
  });

  it('ranks the guide whose title matches before the overview body mention, endpoints last', async () => {
    await useSpec(fixture);
    const { data } = await (await tool('SearchDocsTool')).execute({ query: 'feed' });
    assert.equal(data.total, 3);
    assert.deepEqual(data.results.map((r: Json) => r.source), ['guide', 'overview', 'endpoint']);
    assert.equal(data.results[0].id, 'feed');
    assert.equal(data.results[1].title, 'Fixture platform');
    assert.equal(data.results[2].path, '/api/v2/feed');
  });

  it('applies limit but keeps total at the full hit count', async () => {
    await useSpec(fixture);
    const { data } = await (await tool('SearchDocsTool')).execute({ query: 'actor', limit: 1 });
    assert.equal(data.results.length, 1);
    assert.equal(data.results[0].source, 'guide');
    assert.equal(data.total, 2);
  });

  it('returns no results for a query that matches nothing', async () => {
    await useSpec(fixture);
    const { data } = await (await tool('SearchDocsTool')).execute({ query: 'zzzzqqq' });
    assert.equal(data.total, 0);
    assert.deepEqual(data.results, []);
  });

  it('rejects empty and whitespace queries', async () => {
    await useSpec(fixture);
    const t = await tool('SearchDocsTool');
    await assert.rejects(t.execute({ query: '' }));
    await assert.rejects(t.execute({ query: '   ' }));
  });
});

describe('get_openapi_spec section tags', () => {
  it('strips the description of guide tags and points to get_guide', async () => {
    await useSpec(fixture);
    const { data } = await (await tool('GetOpenAPISpecTool')).execute({ section: 'tags' });
    const guide = data.find((t: Json) => t.name === 'guide:feed');
    assert.ok(guide, 'guide:feed tag missing');
    assert.equal('description' in guide, false);
    assert.equal(guide['x-displayName'], 'Feed');
    assert.deepEqual(guide['x-guide'], guideTags[1]['x-guide']);
    assert.equal(guide['x-note'], 'Full text: get_guide { id: "feed" }');
  });

  it('keeps normal tags unchanged', async () => {
    await useSpec(fixture);
    const { data } = await (await tool('GetOpenAPISpecTool')).execute({ section: 'tags' });
    assert.deepEqual(data.find((t: Json) => t.name === 'Feed'), { name: 'Feed', description: 'Feed endpoints' });
    assert.deepEqual(data.find((t: Json) => t.name === 'Entity'), { name: 'Entity', description: 'Entity endpoints' });
  });
});

function guideTag(id: string, body: string, meta: Json = {}, extra: Json = {}) {
  return {
    name: `guide:${id}`,
    'x-displayName': `Title ${id}`,
    description: body,
    'x-guide': { id, ...meta },
    ...extra,
  };
}

function specWith(parts: Json) {
  return { openapi: '3.1.0', info: { title: 'Case API', version: '1' }, paths: {}, ...parts };
}

const oneEndpoint = {
  '/api/v2/ping': { get: { tags: ['Ping'], summary: 'Ping the server', responses: { '200': { description: 'ok' } } } },
};

describe('robust guide index', () => {
  const malformed = specWith({
    info: { title: 'Malformed API', version: '1', description: 12345 },
    tags: [
      null,
      { name: 'guide:bad', 'x-guide': 'oops' },
      guideTag('a', '# A\n\nbody'),
      { name: 'Ping', description: 'Ping endpoints' },
    ],
    'x-tagGroups': [null, { name: 'G', tags: 'guide:a' }],
    paths: oneEndpoint,
  });

  it('search_endpoints still returns its endpoints', async () => {
    await useSpec(malformed);
    const res = await (await tool('SearchEndpointsTool')).execute({});
    assert.equal(res.success, true);
    assert.equal(res.endpoints.length, 1);
    assert.equal(res.endpoints[0].path, '/api/v2/ping');
  });

  it('list_guides returns success true', async () => {
    await useSpec(malformed);
    const res = await (await tool('ListGuidesTool')).execute({});
    assert.equal(res.success, true);
  });

  it('search_docs does not throw', async () => {
    await useSpec(malformed);
    const res = await (await tool('SearchDocsTool')).execute({ query: 'ping' });
    assert.equal(res.success, true);
  });
});

describe('search_docs whitespace handling', () => {
  const spec = specWith({
    tags: [guideTag('a', 'the quick brown\nfox jumps'), guideTag('b', 'quick  brown')],
  });

  it('matches across a newline', async () => {
    await useSpec(spec);
    const { data } = await (await tool('SearchDocsTool')).execute({ query: 'brown fox' });
    assert.equal(data.total, 1);
    assert.equal(data.results[0].id, 'a');
  });

  it('matches across repeated spaces', async () => {
    await useSpec(spec);
    const { data } = await (await tool('SearchDocsTool')).execute({ query: 'quick brown' });
    assert.equal(data.total, 2);
    assert.deepEqual(data.results.map((r: Json) => r.id).sort(), ['a', 'b']);
  });

  it('collapses whitespace in the query and snippet', async () => {
    await useSpec(spec);
    const { data } = await (await tool('SearchDocsTool')).execute({ query: 'quick\nbrown' });
    assert.ok(data.total >= 1);
    assert.ok(data.results[0].snippet.includes('quick brown'), data.results[0].snippet);
  });
});

describe('search_docs offset', () => {
  const spec = specWith({
    tags: [guideTag('a', 'needle one'), guideTag('b', 'needle two'), guideTag('c', 'needle three')],
  });

  it('returns the third hit with limit 1 and offset 2, total unchanged', async () => {
    await useSpec(spec);
    const t = await tool('SearchDocsTool');
    const all = (await t.execute({ query: 'needle' })).data;
    assert.equal(all.total, 3);
    const { data } = await t.execute({ query: 'needle', limit: 1, offset: 2 });
    assert.equal(data.total, 3);
    assert.equal(data.results.length, 1);
    assert.deepEqual(data.results[0], all.results[2]);
  });
});

describe('search_docs limit validation', () => {
  const spec = specWith({
    tags: Array.from({ length: 12 }, (_, i) => guideTag(`g${i}`, `needle ${i}`)),
  });

  for (const limit of [0, -3, 2.5, 51]) {
    it(`toolCall rejects limit ${limit}`, async () => {
      await useSpec(spec);
      const res = await (await tool('SearchDocsTool')).toolCall({ params: { arguments: { query: 'needle', limit } } });
      assert.equal(res.isError, true);
    });
  }

  it('toolCall accepts limits 1 and 50', async () => {
    await useSpec(spec);
    const t = await tool('SearchDocsTool');
    for (const limit of [1, 50]) {
      const res = await t.toolCall({ params: { arguments: { query: 'needle', limit } } });
      assert.notEqual(res.isError, true);
    }
  });

  it('defaults to 10 results', async () => {
    await useSpec(spec);
    const res = await (await tool('SearchDocsTool')).toolCall({ params: { arguments: { query: 'needle' } } });
    const body = JSON.parse(res.content[0].text);
    assert.equal(body.data.total, 12);
    assert.equal(body.data.results.length, 10);
  });
});

describe('search_docs long query snippet', () => {
  it('starts the snippet at the match when the query exceeds 240 characters', async () => {
    const query = Array.from({ length: 75 }, (_, i) => String(1000 + i)).join('');
    assert.equal(query.length, 300);
    await useSpec(specWith({
      tags: [guideTag('long', `${'prefix words go here '.repeat(8)}${query} and a suffix after it`)],
    }));
    const { data } = await (await tool('SearchDocsTool')).execute({ query });
    assert.equal(data.total, 1);
    assert.equal(data.results[0].snippet, `…${query.slice(0, 240)}…`);
  });
});

describe('overview title extraction', () => {
  it('ignores headings inside code fences and strips closing hashes', async () => {
    await useSpec(specWith({
      info: { title: 'T', version: '1', description: 'Intro text\n\n```bash\n# install deps\n```\n\n# Real title #' },
    }));
    const { data } = await (await tool('ListGuidesTool')).execute({});
    assert.equal(data.overview.title, 'Real title');
  });

  it('strips closing hashes on their own', async () => {
    await useSpec(specWith({ info: { title: 'T', version: '1', description: '# Closed heading ##\n\nbody' } }));
    const { data } = await (await tool('ListGuidesTool')).execute({});
    assert.equal(data.overview.title, 'Closed heading');
  });
});

describe('guide grouping', () => {
  it('groups guides by x-guide.group when there is no x-tagGroups', async () => {
    await useSpec(specWith({ tags: [guideTag('a', '# A', { group: 'Features', summary: 'S' })] }));
    const { data } = await (await tool('ListGuidesTool')).execute({});
    assert.equal(data.groups.length, 1);
    assert.equal(data.groups[0].name, 'Features');
    assert.deepEqual(data.groups[0].guides.map((g: Json) => g.id), ['a']);
  });

  it('lists a guide once, in the first x-tagGroups group that holds it', async () => {
    await useSpec(specWith({
      tags: [guideTag('a', '# A', { group: 'X' }), guideTag('b', '# B', { group: 'X' })],
      'x-tagGroups': [
        { name: 'G1', tags: ['guide:a'] },
        { name: 'G2', tags: ['guide:a', 'guide:b'] },
      ],
    }));
    const { data } = await (await tool('ListGuidesTool')).execute({});
    assert.deepEqual(
      data.groups.map((g: Json) => [g.name, g.guides.map((x: Json) => x.id)]),
      [['G1', ['a']], ['G2', ['b']]],
    );
  });

  it('does not special-case a group named "API reference"', async () => {
    await useSpec(specWith({
      tags: [guideTag('a', '# A')],
      'x-tagGroups': [{ name: 'API reference', tags: ['guide:a'] }],
    }));
    const { data } = await (await tool('ListGuidesTool')).execute({});
    assert.deepEqual(
      data.groups.map((g: Json) => [g.name, g.guides.map((x: Json) => x.id)]),
      [['API reference', ['a']]],
    );
  });
});

describe('null normalisation', () => {
  const spec = specWith({
    tags: [guideTag('a', '# A', { summary: null })],
    'x-tagGroups': [{ name: 'G', tags: ['guide:a'] }],
  });

  it('get_guide returns null summary and null group', async () => {
    await useSpec(spec);
    const { data } = await (await tool('GetGuideTool')).execute({ id: 'a' });
    assert.equal(data.summary, null);
    assert.equal(data.group, 'G');
  });

  it('list_guides returns a null summary', async () => {
    await useSpec(spec);
    const { data } = await (await tool('ListGuidesTool')).execute({});
    const guide = data.groups.flatMap((g: Json) => g.guides).find((g: Json) => g.id === 'a');
    assert.ok(guide, 'guide a not listed');
    assert.equal(guide.summary, null);
  });
});

describe('get_openapi_spec description', () => {
  it('points agents at get_guide', async () => {
    const t = await tool('GetOpenAPISpecTool');
    assert.match(t.description, /get_guide/);
  });
});

describe('get_openapi_spec section tags with a non-array tags', () => {
  for (const tags of ['oops', { a: 1 }, 7]) {
    it(`returns ${JSON.stringify(tags)} unchanged`, async () => {
      await useSpec(specWith({ tags }));
      const { success, data } = await (await tool('GetOpenAPISpecTool')).execute({ section: 'tags' });
      assert.equal(success, true);
      assert.deepEqual(data, tags);
    });
  }

  it('escapes quotes in the guide id inside the note', async () => {
    await useSpec(specWith({ tags: [guideTag('a"b', '# A')] }));
    const { data } = await (await tool('GetOpenAPISpecTool')).execute({ section: 'tags' });
    assert.equal(data[0]['x-note'], 'Full text: get_guide { id: "a\\"b" }');
  });
});

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('search_docs snippet offsets and truncation', () => {
  it('keeps the match inside the snippet when lowercasing changes the text length', async () => {
    await useSpec(specWith({ tags: [guideTag('a', `${'İ'.repeat(300)} needle ${'tail '.repeat(60)}`)] }));
    const { data } = await (await tool('SearchDocsTool')).execute({ query: 'needle' });
    assert.equal(data.total, 1);
    assert.ok(data.results[0].snippet.includes('needle'), data.results[0].snippet);
  });

  it('treats regex metacharacters in the query literally', async () => {
    await useSpec(specWith({ tags: [guideTag('a', 'xx a.b(c yy'), guideTag('b', 'xx aXb(c yy')] }));
    const { data } = await (await tool('SearchDocsTool')).execute({ query: 'a.b(c' });
    assert.deepEqual(data.results.map((r: Json) => r.id), ['a']);
  });

  it('never splits a surrogate pair at either window edge', async () => {
    const e = '😀';
    await useSpec(specWith({ tags: [guideTag('a', `${e.repeat(200)}x needle ${e.repeat(200)}`)] }));
    const { data } = await (await tool('SearchDocsTool')).execute({ query: 'needle' });
    const { snippet } = data.results[0];
    assert.doesNotMatch(snippet, LONE_SURROGATE);
    assert.ok(snippet.includes('needle'));
    assert.ok(snippet.startsWith('…') && snippet.endsWith('…'), snippet);
    assert.ok(snippet.replace(/^…|…$/g, '').length <= 240);
  });

  it('adds an ellipsis only on the side that was cut', async () => {
    const filler = 'filler words here '.repeat(40);
    await useSpec(specWith({
      tags: [guideTag('head', `needle ${filler}`), guideTag('tail', `${filler}needle`), guideTag('short', 'a needle here')],
    }));
    const { data } = await (await tool('SearchDocsTool')).execute({ query: 'needle' });
    const byId = Object.fromEntries(data.results.map((r: Json) => [r.id, r.snippet]));
    assert.ok(byId.head.startsWith('needle') && byId.head.endsWith('…'), byId.head);
    assert.ok(byId.tail.startsWith('…') && byId.tail.endsWith('needle'), byId.tail);
    assert.equal(byId.short, 'a needle here');
  });
});

describe('search_docs searchable fields and ranking', () => {
  it('finds a guide by its summary and by its title', async () => {
    await useSpec(specWith({
      tags: [guideTag('a', '# A\n\nbody', { summary: 'About quokkas' }), guideTag('b', 'body', {}, { 'x-displayName': 'Wombat handbook' })],
    }));
    const t = await tool('SearchDocsTool');
    assert.deepEqual((await t.execute({ query: 'quokkas' })).data.results.map((r: Json) => r.id), ['a']);
    assert.deepEqual((await t.execute({ query: 'wombat' })).data.results.map((r: Json) => r.id), ['b']);
  });

  it('finds an endpoint by its path and by its operationId', async () => {
    await useSpec(specWith({
      paths: {
        '/api/v2/gizmos/{id}': { get: { operationId: 'fetchGizmoXyz', responses: { '200': { description: 'ok' } } } },
        '/api/v2/other': { get: { responses: { '200': { description: 'ok' } } } },
      },
    }));
    const t = await tool('SearchDocsTool');
    const byPath = (await t.execute({ query: 'gizmos/{id}' })).data.results;
    assert.deepEqual(byPath.map((r: Json) => r.path), ['/api/v2/gizmos/{id}']);
    const byOp = (await t.execute({ query: 'gizmoxyz' })).data.results;
    assert.deepEqual(byOp.map((r: Json) => r.path), ['/api/v2/gizmos/{id}']);
  });

  it('ranks title/id/summary hits, then body-only guide hits, then endpoints, stable within a tier', async () => {
    await useSpec(specWith({
      info: { title: 'T', version: '1', description: '# Zeta overview\n\nintro' },
      tags: [
        guideTag('body-only', 'mentions zeta in the body'),
        guideTag('by-summary', 'body', { summary: 'zeta summary' }),
        guideTag('by-title', 'body', {}, { 'x-displayName': 'Zeta guide' }),
        guideTag('zeta-id', 'body'),
      ],
      paths: { '/api/v2/z': { get: { summary: 'zeta endpoint', responses: { '200': { description: 'ok' } } } } },
    }));
    const { data } = await (await tool('SearchDocsTool')).execute({ query: 'zeta' });
    assert.deepEqual(
      data.results.map((r: Json) => r.id ?? r.path),
      ['overview', 'by-summary', 'by-title', 'zeta-id', 'body-only', '/api/v2/z'],
    );
  });

  it('counts the overview as a body hit when only its body matches', async () => {
    await useSpec(specWith({
      info: { title: 'T', version: '1', description: '# Intro\n\nzeta here' },
      tags: [guideTag('g', 'body', { summary: 'zeta' })],
    }));
    const { data } = await (await tool('SearchDocsTool')).execute({ query: 'zeta' });
    assert.deepEqual(data.results.map((r: Json) => r.id), ['g', 'overview']);
  });
});

describe('guide ids', () => {
  it('skips a guide tag whose id is overview, so the overview stays reachable', async () => {
    await useSpec(specWith({
      info: { title: 'T', version: '1', description: '# Real overview\n\nintro' },
      tags: [guideTag('overview', '# Shadow'), guideTag('a', '# A')],
    }));
    const { data } = await (await tool('ListGuidesTool')).execute({});
    assert.deepEqual(data.groups.flatMap((g: Json) => g.guides.map((x: Json) => x.id)), ['a']);
    const guide = (await (await tool('GetGuideTool')).execute({ id: 'overview' })).data;
    assert.equal(guide.markdown, '# Real overview\n\nintro');
  });

  it('keeps the first of two guides sharing an id; list_guides and get_guide agree', async () => {
    await useSpec(specWith({
      tags: [guideTag('dup', '# First'), guideTag('other', '# Other'), { ...guideTag('dup', '# Second'), name: 'guide:dup2' }],
    }));
    const { data } = await (await tool('ListGuidesTool')).execute({});
    assert.deepEqual(data.groups.flatMap((g: Json) => g.guides.map((x: Json) => x.id)), ['dup', 'other']);
    assert.equal((await (await tool('GetGuideTool')).execute({ id: 'dup' })).data.markdown, '# First');
  });
});

describe('get_guide matches list_guides', () => {
  it('reports the group list_guides shows when the guide has no x-guide.group', async () => {
    await useSpec(specWith({
      tags: [guideTag('a', '# A'), guideTag('b', '# B')],
      'x-tagGroups': [{ name: 'Placed', tags: ['guide:a'] }],
    }));
    const list = (await (await tool('ListGuidesTool')).execute({})).data;
    const listed = (id: string) => list.groups.find((g: Json) => g.guides.some((x: Json) => x.id === id)).name;
    const t = await tool('GetGuideTool');
    assert.equal((await t.execute({ id: 'a' })).data.group, listed('a'));
    assert.equal((await t.execute({ id: 'a' })).data.group, 'Placed');
    assert.equal((await t.execute({ id: 'b' })).data.group, listed('b'));
    assert.equal((await t.execute({ id: 'b' })).data.group, 'Other');
  });

  it('treats empty group, summary and displayName as missing', async () => {
    await useSpec(specWith({
      tags: [guideTag('a', '# Heading A', { group: '', summary: '' }, { 'x-displayName': '' })],
    }));
    const list = (await (await tool('ListGuidesTool')).execute({})).data;
    assert.equal(list.groups[0].name, 'Other');
    assert.deepEqual(list.groups[0].guides[0], { id: 'a', title: 'Heading A', summary: null });
    const guide = (await (await tool('GetGuideTool')).execute({ id: 'a' })).data;
    assert.equal(guide.group, 'Other');
    assert.equal(guide.summary, null);
    assert.equal(guide.title, 'Heading A');
  });
});

describe('search_docs schema and pagination', () => {
  it('states the integer ranges in the published schema', async () => {
    const t = await tool('SearchDocsTool');
    assert.match(t.schema.limit.description, /integer 1-50, default 10/);
    assert.match(t.schema.offset.description, /integer >= 0, default 0/);
  });

  it('returns a pagination object and keeps total', async () => {
    await useSpec(specWith({ tags: Array.from({ length: 12 }, (_, i) => guideTag(`g${i}`, `needle ${i}`)) }));
    const t = await tool('SearchDocsTool');
    const first = (await t.execute({ query: 'needle' })).data;
    assert.equal(first.total, 12);
    assert.deepEqual(first.pagination, { total: 12, limit: 10, offset: 0, hasMore: true });
    const last = (await t.execute({ query: 'needle', limit: 5, offset: 10 })).data;
    assert.equal(last.results.length, 2);
    assert.deepEqual(last.pagination, { total: 12, limit: 5, offset: 10, hasMore: false });
  });
});

describe('firstHeading code fences', () => {
  const titleOf = async (description: string) => {
    await useSpec(specWith({ info: { title: 'T', version: '1', description } }));
    return (await (await tool('ListGuidesTool')).execute({})).data.overview.title;
  };

  it('ignores headings inside a ~~~ fence', async () => {
    assert.equal(await titleOf('~~~\n# not this\n~~~\n\n# Real'), 'Real');
  });

  it('does not close a ``` fence with ~~~ or with a shorter fence', async () => {
    assert.equal(await titleOf('```\n~~~\n# not this\n~~~\n```\n# Real'), 'Real');
    assert.equal(await titleOf('````\n```\n# not this\n```\n````\n# Real'), 'Real');
  });

  it('closes a fence with a longer one of the same character', async () => {
    assert.equal(await titleOf('```\n# not this\n`````\n# Real'), 'Real');
  });
});

describe('doc index laziness', () => {
  it('builds the doc index on the first search and once per spec load', async () => {
    const internals = manager as unknown as { buildDocIndex: (...args: unknown[]) => unknown };
    const original = internals.buildDocIndex;
    let builds = 0;
    internals.buildDocIndex = function (this: unknown, ...args: unknown[]) {
      builds++;
      return original.apply(this, args);
    };
    try {
      await useSpec(fixture);
      await (await tool('ListGuidesTool')).execute({});
      assert.equal(builds, 0);
      const t = await tool('SearchDocsTool');
      await t.execute({ query: 'feed' });
      await t.execute({ query: 'actor' });
      assert.equal(builds, 1);
      await useSpec(fixture);
      await t.execute({ query: 'feed' });
      assert.equal(builds, 2);
    } finally {
      internals.buildDocIndex = original;
    }
  });
});

async function listedIds(): Promise<string[]> {
  const { data } = await (await tool('ListGuidesTool')).execute({});
  return data.groups.flatMap((g: Json) => g.guides.map((x: Json) => x.id));
}

async function listedGroups(): Promise<Json[]> {
  const { data } = await (await tool('ListGuidesTool')).execute({});
  return data.groups.map((g: Json) => [g.name, g.guides.map((x: Json) => x.id)]);
}

async function withErrors(run: () => Promise<void>): Promise<string[]> {
  const spy = mock.method(console, 'error', () => {});
  try {
    await run();
    return spy.mock.calls.map(call => String(call.arguments[0]));
  } finally {
    spy.mock.restore();
  }
}

describe('section tags only strips indexed guides', () => {
  it('keeps the description of a reserved or duplicate-id guide tag and adds no x-note', async () => {
    await useSpec(specWith({
      info: { title: 'T', version: '1', description: '# Real overview' },
      tags: [
        guideTag('overview', '# Shadow'),
        guideTag('a', '# A'),
        { ...guideTag('a', '# Second A'), name: 'guide:a2' },
      ],
    }));
    const { data } = await (await tool('GetOpenAPISpecTool')).execute({ section: 'tags' });
    assert.equal('description' in data[1], false);
    assert.equal(data[1]['x-note'], 'Full text: get_guide { id: "a" }');
    for (const skipped of [data[0], data[2]]) {
      assert.ok(skipped.description, `${skipped.name} lost its description`);
      assert.equal('x-note' in skipped, false);
    }
  });
});

describe('overview reservation', () => {
  it('reserves "overview" only when the spec has an overview', async () => {
    await useSpec(specWith({ tags: [guideTag('overview', '# Mine\n\nbody')] }));
    const list = (await (await tool('ListGuidesTool')).execute({})).data;
    assert.equal(list.overview, null);
    assert.deepEqual(await listedIds(), ['overview']);
    const guide = (await (await tool('GetGuideTool')).execute({ id: 'overview' })).data;
    assert.equal(guide.markdown, '# Mine\n\nbody');
  });
});

describe('duplicate guide tag names', () => {
  it('skips the second tag with one console.error line', async () => {
    await useSpec(specWith({
      tags: [guideTag('one', '# One', {}, { name: 'guide:x' }), guideTag('two', '# Two', {}, { name: 'guide:x' })],
    }));
    let ids: string[] = [];
    const lines = await withErrors(async () => { ids = await listedIds(); });
    assert.deepEqual(ids, ['one']);
    assert.equal(lines.filter(line => line.includes('guide:x')).length, 1);
  });
});

describe('section info with an overview', () => {
  it('replaces the description by a pointer and keeps the other keys', async () => {
    await useSpec(fixture);
    const { data } = await (await tool('GetOpenAPISpecTool')).execute({ section: 'info' });
    assert.deepEqual(data, { title: 'Fixture API', version: '1', description: 'Overview guide: get_guide { id: "overview" }' });
    const overview = (await (await tool('GetGuideTool')).execute({ id: 'overview' })).data;
    assert.equal(overview.markdown, fixture.info.description);
  });

  it('returns info unchanged when there is no overview', async () => {
    await useSpec(noDescription);
    const { data } = await (await tool('GetOpenAPISpecTool')).execute({ section: 'info' });
    assert.deepEqual(data, noDescription.info);
  });
});

describe('guide id normalisation', () => {
  it('trims ids and strips a guide: prefix; list_guides ids are fetchable', async () => {
    await useSpec(specWith({
      tags: [guideTag(' foo ', '# Foo'), guideTag('guide:bar', '# Bar'), { ...guideTag('x', '# X'), name: 'guide:y' }],
    }));
    const ids = await listedIds();
    assert.deepEqual(ids, ['foo', 'bar', 'x']);
    const get = await tool('GetGuideTool');
    for (const id of ids) assert.equal((await get.execute({ id })).data.id, id);
  });

  it('skips a tag whose id is empty after normalisation, with a console.error line', async () => {
    await useSpec(specWith({
      tags: [guideTag('  ', '# Blank'), guideTag('guide:', '# Prefix only'), guideTag('ok', '# Ok')],
    }));
    let ids: string[] = [];
    const lines = await withErrors(async () => { ids = await listedIds(); });
    assert.deepEqual(ids, ['ok']);
    assert.equal(lines.filter(line => line.includes('Skipping guide tag')).length, 2);
  });

  it('treats a normalised overview id as reserved', async () => {
    await useSpec(specWith({
      info: { title: 'T', version: '1', description: '# Real' },
      tags: [guideTag('guide:overview', '# Shadow'), guideTag(' overview', '# Shadow 2')],
    }));
    assert.deepEqual(await listedIds(), []);
  });
});

describe('guide order inside a group', () => {
  const tags = [
    guideTag('a', '# A', { group: 'G', order: 10 }),
    guideTag('b', '# B', { group: 'G' }),
    guideTag('c', '# C', { group: 'G', order: 1 }),
    guideTag('d', '# D', { group: 'G', order: 2 }),
    guideTag('e', '# E', { group: 'G', order: '1' }),
  ];

  it('sorts the fallback path by numeric order, then tag order, unnumbered last', async () => {
    await useSpec(specWith({ tags }));
    assert.deepEqual(await listedGroups(), [['G', ['c', 'd', 'a', 'b', 'e']]]);
  });

  it('sorts the x-tagGroups path the same way', async () => {
    await useSpec(specWith({
      tags,
      'x-tagGroups': [{ name: 'G', tags: ['guide:e', 'guide:a', 'guide:b', 'guide:d', 'guide:c'] }],
    }));
    assert.deepEqual(await listedGroups(), [['G', ['c', 'd', 'a', 'e', 'b']]]);
  });
});

describe('x-tagGroups names', () => {
  const tags = [guideTag('a', '# A'), guideTag('b', '# B'), guideTag('c', '# C'), guideTag('d', '# D')];

  it('trims names, maps empty names to Other and merges equal names in first-seen order', async () => {
    await useSpec(specWith({
      tags,
      'x-tagGroups': [
        { name: ' G ', tags: ['guide:a'] },
        { name: '  ', tags: ['guide:c'] },
        { name: 'G', tags: ['guide:b'] },
        { name: '', tags: ['guide:d'] },
      ],
    }));
    assert.deepEqual(await listedGroups(), [['G', ['a', 'b']], ['Other', ['c', 'd']]]);
    assert.equal((await (await tool('GetGuideTool')).execute({ id: 'b' })).data.group, 'G');
  });

  it('merges fallback groups by trimmed name, also into an x-tagGroups group', async () => {
    await useSpec(specWith({
      tags: [
        guideTag('a', '# A', { group: ' F ' }),
        guideTag('b', '# B', { group: 'F' }),
        guideTag('c', '# C', { group: 'H' }),
        guideTag('d', '# D', { group: 'H ' }),
      ],
      'x-tagGroups': [{ name: 'H', tags: ['guide:c'] }],
    }));
    assert.deepEqual(await listedGroups(), [['H', ['c', 'd']], ['F', ['a', 'b']]]);
  });
});

describe('get_openapi_spec description names the extension', () => {
  it('says guides are tags carrying an x-guide object with an id', async () => {
    const t = await tool('GetOpenAPISpecTool');
    assert.ok(t.description.includes(
      'Platform guides are tags carrying an x-guide object with an id (a common naming is guide:<id>); use list_guides, get_guide and search_docs to read them instead of dumping the spec.',
    ));
  });
});

describe('get_openapi_spec slims guide text in every section', () => {
  const OVERVIEW_NOTE = 'Overview guide: get_guide { id: "overview" }';

  it('slims info and guide tags in the default full section', async () => {
    await useSpec(fixture);
    const { data } = await (await tool('GetOpenAPISpecTool')).execute({});
    assert.equal(data.info.description, OVERVIEW_NOTE);
    const guide = data.tags.find((t: Json) => t.name === 'guide:feed');
    assert.equal(guide.description, undefined);
    assert.equal(guide['x-note'], 'Full text: get_guide { id: "feed" }');
    assert.deepEqual(data.tags.find((t: Json) => t.name === 'Feed'), { name: 'Feed', description: 'Feed endpoints' });
    assert.deepEqual(Object.keys(data.paths), Object.keys(fixture.paths));
  });

  it('slims them with a pathFilter too, and does not mutate the cached spec', async () => {
    await useSpec(fixture);
    const t = await tool('GetOpenAPISpecTool');
    const { data } = await t.execute({ section: 'full', pathFilter: '/entity' });
    assert.equal(data.info.description, OVERVIEW_NOTE);
    assert.equal(data.tags.find((x: Json) => x.name === 'guide:feed').description, undefined);
    assert.deepEqual(Object.keys(data.paths), ['/api/v2/entity/{id}']);
    const guide = (await (await tool('GetGuideTool')).execute({ id: 'feed' })).data;
    assert.equal(guide.markdown, '# Feed\n\nHow feed card ordering works.');
  });

  it('returns the full spec unchanged when it has no guides and no overview', async () => {
    await useSpec(noDescription);
    const { data } = await (await tool('GetOpenAPISpecTool')).execute({});
    assert.deepEqual(data, noDescription);
  });
});

describe('getSpec failure handling', () => {
  const internals = () => manager as unknown as { cache: { fetchedAt: number } | null; getSpec(): Promise<Json> };

  async function expireCache() {
    await useSpec(fixture);
    await internals().getSpec();
    internals().cache!.fetchedAt = 0;
  }

  it('lets a caller that awaits an in-flight failing fetch fall back to the stale cache', async () => {
    await expireCache();
    failing = true;
    try {
      await withErrors(async () => {
        const [first, second] = await Promise.all([internals().getSpec(), internals().getSpec()]);
        assert.equal(first.info.title, 'Fixture API');
        assert.equal(second.info.title, 'Fixture API');
      });
    } finally {
      failing = false;
    }
  });

  it('rejects when the fetch fails and there is no cache', async () => {
    await useSpec(fixture);
    failing = true;
    try {
      await assert.rejects(Promise.all([internals().getSpec(), internals().getSpec()]));
    } finally {
      failing = false;
    }
  });

  it('waits a backoff before retrying after a failed refetch with a stale cache', async () => {
    await expireCache();
    failing = true;
    try {
      await withErrors(async () => {
        await internals().getSpec();
        const before = requests;
        await internals().getSpec();
        await internals().getSpec();
        assert.equal(requests, before);
      });
    } finally {
      failing = false;
    }
  });

  it('passes an abort signal to the spec fetch', async () => {
    await useSpec(fixture);
    const original = globalThis.fetch;
    const signals: unknown[] = [];
    const spy = mock.method(globalThis, 'fetch', (input: unknown, init?: RequestInit) => {
      signals.push(init?.signal);
      return original(input as string, init);
    });
    try {
      await internals().getSpec();
    } finally {
      spy.mock.restore();
    }
    assert.equal(signals.length, 1);
    assert.ok(signals[0] instanceof AbortSignal);
  });
});

describe('guide: prefix handling', () => {
  it('get_guide strips repeated guide: prefixes', async () => {
    await useSpec(fixture);
    const get = await tool('GetGuideTool');
    assert.equal((await get.execute({ id: 'guide:guide:feed' })).data.id, 'feed');
    assert.equal((await get.execute({ id: 'guide:overview' })).data.id, 'overview');
  });

  it('a tag id with repeated prefixes is listed as the bare id and stays fetchable', async () => {
    await useSpec(specWith({ tags: [guideTag('guide:guide:x', '# X')] }));
    const ids = await listedIds();
    assert.deepEqual(ids, ['x']);
    assert.equal((await (await tool('GetGuideTool')).execute({ id: ids[0] })).data.id, 'x');
  });

  it('search_docs finds a guide by its tag name guide:<id>', async () => {
    await useSpec(fixture);
    const { data } = await (await tool('SearchDocsTool')).execute({ query: 'guide:feed' });
    assert.deepEqual(data.results.map((r: Json) => [r.source, r.id]), [['guide', 'feed']]);
  });
});

describe('search_docs guide: alias', () => {
  it('does not make every guide a title hit for guide, ui or id', async () => {
    await useSpec(specWith({
      tags: [guideTag('ui', 'body one'), guideTag('g1', 'the guide to things'), guideTag('g2', 'nothing relevant')],
    }));
    const t = await tool('SearchDocsTool');
    assert.deepEqual((await t.execute({ query: 'guide' })).data.results.map((r: Json) => r.id), ['g1']);
    assert.deepEqual((await t.execute({ query: 'ui' })).data.results.map((r: Json) => r.id), ['ui', 'g1']);
    assert.deepEqual((await t.execute({ query: 'id' })).data.results.map((r: Json) => r.id), ['g1']);
  });

  it('matches guide:<id> case-insensitively only when the query starts with guide:', async () => {
    await useSpec(fixture);
    const t = await tool('SearchDocsTool');
    assert.deepEqual((await t.execute({ query: 'GUIDE:Feed' })).data.results.map((r: Json) => r.id), ['feed']);
    assert.deepEqual((await t.execute({ query: 'guide:feed Feed' })).data.results.map((r: Json) => r.id), ['feed']);
    assert.deepEqual((await t.execute({ query: 'Feed guide:feed' })).data.results, []);
  });
});

describe('search_docs overview metadata', () => {
  const ids = (r: Json) => r.data.results.map((hit: Json) => hit.id ?? hit.path);
  const info = (meta?: Json) => ({ title: 'Case API', version: '1', description: '# Plain intro\n\nBody text.', ...(meta ? { 'x-guide': meta } : {}) });

  it('ranks the overview as a head hit on its alias id and summary, ahead of a rival head hit', async () => {
    const rival = guideTag('rival', 'body', { summary: 'Quokka notes on platform-overview' });
    const paths = { '/quokka': { get: { summary: 'Quokka platform-overview endpoint' } } };
    await useSpec(specWith({ info: info({ id: 'platform-overview', summary: 'Quokka summary' }), tags: [rival], paths }));
    const t = await tool('SearchDocsTool');
    assert.deepEqual(ids(await t.execute({ query: 'platform-overview' })), ['overview', 'rival', '/quokka']);
    assert.deepEqual(ids(await t.execute({ query: 'quokka' })), ['overview', 'rival', '/quokka']);
    assert.deepEqual(ids(await t.execute({ query: 'guide:platform-overview' })), ['overview']);
    assert.deepEqual(ids(await t.execute({ query: 'guide:overview' })), ['overview']);
  });

  it('ranks the overview as a head hit on its own id without metadata', async () => {
    await useSpec(specWith({ info: info(), tags: [guideTag('rival', 'body', { summary: 'overview notes' })] }));
    const t = await tool('SearchDocsTool');
    assert.deepEqual(ids(await t.execute({ query: 'overview' })), ['overview', 'rival']);
    assert.deepEqual(ids(await t.execute({ query: 'guide:overview' })), ['overview']);
  });
});

describe('search_docs multi-term queries', () => {
  it('matches non-adjacent terms across head and body and centres the snippet on the first term', async () => {
    await useSpec(fixture);
    const { data } = await (await tool('SearchDocsTool')).execute({ query: 'actor core' });
    assert.deepEqual(data.results.map((r: Json) => r.id), ['core-concepts']);
    assert.ok(data.results[0].snippet.toLowerCase().includes('actor'), data.results[0].snippet);
  });

  it('requires every term, in any order', async () => {
    await useSpec(fixture);
    const t = await tool('SearchDocsTool');
    assert.equal((await t.execute({ query: 'actor zzzzqqq' })).data.total, 0);
    assert.deepEqual((await t.execute({ query: 'core actor' })).data.results.map((r: Json) => r.id), ['core-concepts']);
  });

  it('ranks entries with every term in the head before body matches', async () => {
    await useSpec(specWith({
      tags: [
        guideTag('a', 'mentions quokka here', {}, { 'x-displayName': 'Wombat handbook' }),
        guideTag('b', 'body', {}, { 'x-displayName': 'Wombat quokka' }),
      ],
    }));
    const { data } = await (await tool('SearchDocsTool')).execute({ query: 'wombat quokka' });
    assert.deepEqual(data.results.map((r: Json) => r.id), ['b', 'a']);
  });
});

describe('get_openapi_spec on a spec without guides', () => {
  it('returns the overview, info and tags unchanged', async () => {
    await useSpec(noGuides);
    const t = await tool('GetOpenAPISpecTool');
    assert.deepEqual((await t.execute({})).data, noGuides);
    assert.deepEqual((await t.execute({ section: 'info' })).data, noGuides.info);
    assert.deepEqual((await t.execute({ section: 'tags' })).data, noGuides.tags);
  });
});

describe('spec fetch timeout', () => {
  it('uses SPEC_FETCH_TIMEOUT seconds for the fetch abort signal', async () => {
    await useSpec(fixture);
    const spy = mock.method(AbortSignal, 'timeout');
    try {
      await (manager as unknown as { getSpec(): Promise<Json> }).getSpec();
    } finally {
      spy.mock.restore();
    }
    assert.deepEqual(spy.mock.calls.map(c => c.arguments[0]), [7000]);
  });
});

describe('firstHeading indentation', () => {
  it('accepts ATX headings indented 1 to 3 spaces and rejects 4', async () => {
    const titleOf = async (description: string) => {
      await useSpec(specWith({ info: { title: 'T', version: '1', description } }));
      return (await (await tool('ListGuidesTool')).execute({})).data.overview.title;
    };
    assert.equal(await titleOf(' # One'), 'One');
    assert.equal(await titleOf('   # Three'), 'Three');
    assert.equal(await titleOf('    # Four\n# Real'), 'Real');
  });
});
