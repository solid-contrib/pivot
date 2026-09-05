import {
  BasicRepresentation,
  ContainerPathStorage,
  guardedStreamFrom,
  INTERNAL_QUADS,
  LDP,
  MaxKeyLengthStorage,
} from '@solid/community-server';
import type { Quad } from '@rdfjs/types';
import type { ResourceStore } from '@solid/community-server';
import { ScopedJsonResourceStorage } from '../../../src/storage/ScopedJsonResourceStorage';

describe('A ScopedJsonResourceStorage', (): void => {
  const baseUrl = 'https://example.com/';
  const container = '/.internal/';
  const entryContainer = '/.internal/idp/tokens/';
  const entryContainerUrl = `${baseUrl}.internal/idp/tokens/`;
  const entryUrl = `${entryContainerUrl}token`;
  let source: jest.Mocked<ResourceStore>;

  beforeEach((): void => {
    source = {
      getRepresentation: jest.fn(async(identifier): Promise<any> => {
        if (identifier.path === entryContainerUrl) {
          const containerNode = { termType: 'NamedNode', value: entryContainerUrl } as const;
          const entryNode = { termType: 'NamedNode', value: entryUrl } as const;
          const quad = {
            subject: containerNode,
            predicate: LDP.terms.contains,
            object: entryNode,
            graph: { termType: 'DefaultGraph', value: '' },
          } as Quad;
          return new BasicRepresentation(guardedStreamFrom([ quad ]), INTERNAL_QUADS);
        }
        return new BasicRepresentation(JSON.stringify({ payload: 'value' }), 'application/json');
      }),
      hasResource: jest.fn(),
      setRepresentation: jest.fn(),
      deleteResource: jest.fn(),
    } satisfies Partial<ResourceStore> as any;
  });

  it('starts enumeration at the scoped container while returning root-relative keys.', async(): Promise<void> => {
    const storage = new ScopedJsonResourceStorage(source, baseUrl, container, entryContainer);

    const entries = [];
    for await (const entry of storage.entries()) {
      entries.push(entry);
    }

    expect(entries).toEqual([[ 'idp/tokens/token', { payload: 'value' }]]);
    expect(source.getRepresentation).toHaveBeenNthCalledWith(1, { path: entryContainerUrl }, {});
    expect(source.getRepresentation).toHaveBeenNthCalledWith(
      2,
      { path: entryUrl },
      { type: { 'application/json': 1 }},
    );
  });

  it('preserves root-relative key mapping for direct lookups.', async(): Promise<void> => {
    const storage = new ScopedJsonResourceStorage(source, baseUrl, container, entryContainer);

    await expect(storage.get('idp/tokens/token')).resolves.toEqual({ payload: 'value' });
    expect(source.getRepresentation).toHaveBeenCalledWith(
      { path: entryUrl },
      { type: { 'application/json': 1 }},
    );
  });

  it('preserves long-key hashing and deletion through the existing wrapper stack.', async(): Promise<void> => {
    const jsonStorage = new ScopedJsonResourceStorage<{
      key: string;
      payload: { payload: string };
    }>(source, baseUrl, container, entryContainer);
    const storage = new ContainerPathStorage(
      new MaxKeyLengthStorage(jsonStorage),
      '/idp/tokens/',
    );
    const key = 'token'.repeat(40);
    const value = { payload: 'value' };

    await storage.set(key, value);
    const storedIdentifier = source.setRepresentation.mock.calls[0][0];
    expect(storedIdentifier.path).toMatch(/^https:\/\/example\.com\/\.internal\/idp\/tokens\/\$hash\$/u);

    source.getRepresentation.mockImplementation(async(identifier): Promise<any> => {
      if (identifier.path === entryContainerUrl) {
        const containerNode = { termType: 'NamedNode', value: entryContainerUrl } as const;
        const entryNode = { termType: 'NamedNode', value: storedIdentifier.path } as const;
        const quad = {
          subject: containerNode,
          predicate: LDP.terms.contains,
          object: entryNode,
          graph: { termType: 'DefaultGraph', value: '' },
        } as Quad;
        return new BasicRepresentation(guardedStreamFrom([ quad ]), INTERNAL_QUADS);
      }
      return new BasicRepresentation(JSON.stringify({ key: `idp/tokens/${key}`, payload: value }), 'application/json');
    });

    const entries = [];
    for await (const entry of storage.entries()) {
      entries.push(entry);
    }
    expect(entries).toEqual([[ key, value ]]);

    await expect(storage.delete(key)).resolves.toBe(true);
    expect(source.deleteResource).toHaveBeenCalledWith(storedIdentifier);
  });

  it('rejects an entry container outside the storage root.', (): void => {
    expect((): ScopedJsonResourceStorage<unknown> =>
      new ScopedJsonResourceStorage(source, baseUrl, '/.internal/accounts/', '/.internal/idp/'))
      .toThrow('The entry container must be inside the storage container.');
  });
});
