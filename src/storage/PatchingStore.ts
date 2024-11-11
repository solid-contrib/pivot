import {
  Patch,
  ResourceIdentifier,
  NotImplementedHttpError,
  Conditions,
  PassthroughStore,
  PatchHandler,
  ChangeMap,
  ResourceStore
} from '@solid/community-server';

/**
 * {@link ResourceStore} using decorator pattern for the `modifyResource` function.
 * If the original store supports the {@link Patch}, behaviour will be identical,
 * otherwise the {@link PatchHandler} will be called instead.
 */
export class PatchingStore<T extends ResourceStore = ResourceStore> extends PassthroughStore<T> {
  private readonly patchHandler: PatchHandler;

  public constructor(source: T, patchHandler: PatchHandler) {
    super(source);
    this.patchHandler = patchHandler;
  }

  public async modifyResource(
    identifier: ResourceIdentifier,
    patch: Patch,
    conditions?: Conditions,
  ): Promise<ChangeMap> {
    try {
      return await this.source.modifyResource(identifier, patch, conditions);
    } catch (error: unknown) {
      if (NotImplementedHttpError.isInstance(error)) {
        return this.patchHandler.handleSafe({ source: this.source, identifier, patch });
      }
      throw error;
    }
  }
}
