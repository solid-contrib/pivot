import {
  NotFoundHttpError,
} from '@solid/community-server';
import type {
  DataAccessor,
  IdentifierStrategy,
  RepresentationMetadata,
  ResourceIdentifier,
} from '@solid/community-server';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const PIM_STORAGE = 'http://www.w3.org/ns/pim/space#Storage';
const TYPE_TERM = { termType: 'NamedNode', value: RDF_TYPE };

/**
 * Finds the closest parent container that has `pim:Storage` as metadata.
 *
 * NOTE: unlike CSS's own `PodQuotaStrategy.searchPimStorage`, this reads the
 * metadata BEFORE testing for a root container. CSS checks `isRootContainer`
 * first and bails without reading metadata — in SUBDOMAIN mode that returns
 * "no pod" for every pod root (each subdomain root IS a root container), so
 * pod quota is silently unlimited and no pod is ever discovered there (and no
 * counter sidecar is ever created). Design C fixes the order so pod discovery
 * works in both suffix and subdomain modes.
 */
export async function discoverPod(
  identifier: ResourceIdentifier,
  accessor: DataAccessor,
  identifierStrategy: IdentifierStrategy,
): Promise<ResourceIdentifier | null> {
  let metadata: RepresentationMetadata;
  try {
    metadata = await accessor.getMetadata(identifier);
  } catch (error: unknown) {
    if (NotFoundHttpError.isInstance(error)) {
      // Resource and/or its metadata do not exist — walk up, but stop at a
      // root container to avoid unbounded recursion.
      if (identifierStrategy.isRootContainer(identifier)) {
        return null;
      }
      return discoverPod(
        identifierStrategy.getParentContainer(identifier),
        accessor,
        identifierStrategy,
      );
    }
    throw error;
  }
  const hasPimStorage = metadata.getAll(TYPE_TERM as any)
    .some((term): boolean => term.value === PIM_STORAGE);
  if (hasPimStorage) {
    return identifier;
  }
  if (identifierStrategy.isRootContainer(identifier)) {
    return null;
  }
  return discoverPod(
    identifierStrategy.getParentContainer(identifier),
    accessor,
    identifierStrategy,
  );
}
