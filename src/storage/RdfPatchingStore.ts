import {
  Patch,
  ResourceIdentifier,
  TEXT_TURTLE,
  Conditions,
  PassthroughStore,
  PatchHandler,
  ChangeMap,
  ResourceStore,
  readableToString,
  BasicRepresentation
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
    let representation = await this.source.getRepresentation(identifier, { type: { [TEXT_TURTLE]: 1 }});
    const turtle: string = await readableToString(representation.data);
    representation = new BasicRepresentation(turtle + '\n<oh> <hi> <there> .\n', identifier, TEXT_TURTLE);

    return this.source.setRepresentation(identifier, representation);
  }
}
