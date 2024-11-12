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
export class RdfPatchingStore<T extends ResourceStore = ResourceStore> extends PassthroughStore<T> {
  protected source: T;

  public constructor(source: T) {
    super(source);
    this.source = source;
  }

  public async modifyResource(
    identifier: ResourceIdentifier,
    patch: Patch,
    conditions?: Conditions,
  ): Promise<ChangeMap> {
    const representation = await this.source.getRepresentation(identifier, {});
    console.log(representation);
    return this.source.setRepresentation(identifier, representation);
  }
}
