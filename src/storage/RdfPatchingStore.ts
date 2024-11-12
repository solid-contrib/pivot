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
import { graph, parse, serialize } from 'rdflib';
import { parsePatchDocument } from './patch/n3-patch-parser';


// Patch parsers by request body content type
const PATCH_PARSERS = {
  'text/n3': parsePatchDocument
};

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
    const store = graph();
    const patchStr = await readableToString(patch.data);
    const resourceUrl = identifier.path;
    const resourceSym = store.sym(resourceUrl);
    const resourceContentType = TEXT_TURTLE;
    let representation = await this.source.getRepresentation(identifier, { type: { [TEXT_TURTLE]: 1 }});
    const turtle: string = await readableToString(representation.data);
    parse(turtle, store, resourceUrl, resourceContentType);
    const parsePatch = PATCH_PARSERS['text/n3'];
    const patchObject = await parsePatch(resourceUrl, resourceUrl, patchStr);
    await new Promise((resolve, reject) => {
      (store as any).applyPatch(patchObject, resourceSym, (err: Error | null): void => {
        if (err) {
          reject(err);
        }
        resolve(undefined);
      });
    });
    let serialized: string | undefined = await new Promise((resolve, reject) => {
      serialize(resourceSym, store as any, resourceUrl, resourceContentType, (err: Error | null | undefined, result: string | undefined): void => {
        if (err) {
          reject(err);
        }
        resolve(result);
      });
    });
    if (typeof serialized !== 'string') {
      console.log('something went wrong');
      serialized = turtle;
    }
    representation = new BasicRepresentation(serialized, representation.metadata, TEXT_TURTLE);

    return this.source.setRepresentation(identifier, representation);
  }
}
