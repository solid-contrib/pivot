import {
  getDefaultVariables,
  getPresetConfigPath,
  instantiateFromConfig,
} from './Config';

describe('The solidcommunity.net production configuration', (): void => {
  const variables = {
    ...getDefaultVariables(3333, 'https://solidcommunity.net/'),
    'urn:solid-server:default:variable:rootFilePath': '/tmp/solidcommunity-config-test',
  };

  it('preserves atomic writes while hard quota enforcement is relaxed.', async(): Promise<void> => {
    const store = await instantiateFromConfig(
      'urn:solid-server:default:ResourceStore_Backend',
      getPresetConfigPath('solidcommunity.net.json'),
      variables,
    );

    expect(store.constructor.name).toBe('DataAccessorBasedStore');
    expect(store.accessor.constructor.name).toBe('CachingDataAccessor');
    expect(store.accessor.source.constructor.name).toBe('FilterMetadataDataAccessor');
    expect(store.accessor.source.accessor.constructor.name).toBe('AtomicFileDataAccessor');
  });

  it('scopes persistent cleanup sweeps without changing their key-storage stack.', async(): Promise<void> => {
    const expectations = [
      [ 'urn:solid-server:default:ForgotPasswordStorage', 'accounts/forgot-password/',
        'https://solidcommunity.net/.internal/accounts/forgot-password/' ],
      [ 'urn:solid-server:default:ExpiringTokenStorage', 'idp/tokens/',
        'https://solidcommunity.net/.internal/idp/tokens/' ],
      [ 'urn:solid-server:default:IdpClientAdapterExpiringStorage', 'idp/adapter/',
        'https://solidcommunity.net/.internal/idp/adapter/' ],
    ];

    for (const [ component, relativePath, entryContainer ] of expectations) {
      const storage = await instantiateFromConfig(component, getPresetConfigPath('solidcommunity.net.json'), variables);
      expect(storage.constructor.name).toBe('WrappedExpiringStorage');
      expect(storage.batchSize).toBe(8);
      expect(storage.source.constructor.name).toBe('ContainerPathStorage');
      expect(storage.source.basePath).toBe(relativePath);
      expect(storage.source.source.constructor.name).toBe('MaxKeyLengthStorage');
      expect(storage.source.source.source.constructor.name).toBe('ScopedJsonResourceStorage');
      expect(storage.source.source.source.container).toBe('https://solidcommunity.net/.internal/');
      expect(storage.source.source.source.entryContainer).toBe(entryContainer);
      await storage.finalize();
    }
  });

  it('keeps cookie and transient OIDC state in memory.', async(): Promise<void> => {
    for (const component of [
      'urn:solid-server:default:CookieStorage',
      'urn:solid-server:default:IdpAdapterExpiringStorage',
    ]) {
      const storage = await instantiateFromConfig(component, getPresetConfigPath('solidcommunity.net.json'), variables);
      expect(storage.source.constructor.name).toBe('ContainerPathStorage');
      expect(storage.source.source.constructor.name).toBe('MemoryMapStorage');
      await storage.finalize();
    }
  });

  it('uses the CSS account storage now that cleanup failures are contained upstream.', async(): Promise<void> => {
    const storage = await instantiateFromConfig(
      'urn:solid-server:default:AccountStorage',
      getPresetConfigPath('solidcommunity.net.json'),
      variables,
    );
    expect(storage.constructor.name).toBe('BaseLoginAccountStorage');
  });
});
