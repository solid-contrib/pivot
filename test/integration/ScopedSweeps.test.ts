import { getDefaultVariables, getPresetConfigPath, instantiateFromConfig } from './Config';

describe('A server configured with the pivot scoped sweeps', (): void => {
  const config = getPresetConfigPath('prod.json');
  const variables = {
    ...getDefaultVariables(3000, 'http://localhost:3000/'),
    'urn:solid-server:default:variable:rootFilePath': '/tmp/pivot-scoped-sweeps-test',
  };

  // Instantiates the given storage from the configuration and returns the entry container of its scoped JSON storage.
  // Class names are compared instead of instanceof: the configuration instantiates the built classes from dist/.
  async function getEntryContainer(storageId: string): Promise<string> {
    const storage = await instantiateFromConfig(storageId, config, variables) as any;
    expect(storage.constructor.name).toBe('PivotExpiringStorage');
    expect(storage.source.constructor.name).toBe('ContainerPathStorage');
    const scoped = storage.source.source.source;
    expect(scoped.constructor.name).toBe('ScopedJsonResourceStorage');
    return scoped.entryContainer;
  }

  it('scopes the cookie sweep to the cookie container.', async(): Promise<void> => {
    await expect(getEntryContainer('urn:solid-server:default:CookieStorage'))
      .resolves.toBe('http://localhost:3000/.internal/accounts/cookies/');
  });

  it('scopes the forgot-password sweep to the forgot-password container.', async(): Promise<void> => {
    await expect(getEntryContainer('urn:solid-server:default:ForgotPasswordStorage'))
      .resolves.toBe('http://localhost:3000/.internal/accounts/forgot-password/');
  });

  it('scopes the ownership-token sweep to the token container.', async(): Promise<void> => {
    await expect(getEntryContainer('urn:solid-server:default:ExpiringTokenStorage'))
      .resolves.toBe('http://localhost:3000/.internal/idp/tokens/');
  });

  it('scopes the OIDC adapter sweep to the adapter container.', async(): Promise<void> => {
    await expect(getEntryContainer('urn:solid-server:default:PivotExpiringAdapterStorage'))
      .resolves.toBe('http://localhost:3000/.internal/idp/adapter/');
  });
});
