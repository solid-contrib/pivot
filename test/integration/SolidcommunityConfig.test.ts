import {
  getDefaultVariables,
  getPresetConfigPath,
  instantiateFromConfig,
} from './Config';

describe('The solidcommunity.net production configuration', (): void => {
  it('preserves atomic writes while hard quota enforcement is relaxed.', async(): Promise<void> => {
    const store = await instantiateFromConfig(
      'urn:solid-server:default:ResourceStore_Backend',
      getPresetConfigPath('solidcommunity.net.json'),
      {
        ...getDefaultVariables(3333, 'https://solidcommunity.net/'),
        'urn:solid-server:default:variable:rootFilePath': '/tmp/solidcommunity-config-test',
      },
    );

    expect(store.constructor.name).toBe('DataAccessorBasedStore');
    expect(store.accessor.constructor.name).toBe('CachingDataAccessor');
    expect(store.accessor.source.constructor.name).toBe('FilterMetadataDataAccessor');
    expect(store.accessor.source.accessor.constructor.name).toBe('AtomicFileDataAccessor');
  });
});
