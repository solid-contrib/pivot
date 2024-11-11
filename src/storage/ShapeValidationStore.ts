import type { Store } from 'n3';
import { DataFactory } from 'n3';
import type { Term } from 'rdf-js';
import type { AuxiliaryStrategy } from '@solid/community-server'
import type { Representation } from '@solid/community-server'
import type { ResourceIdentifier } from '@solid/community-server'
import {BasicRepresentation, filter, getLoggerFor, reduce} from '@solid/community-server'
import { INTERNAL_QUADS } from '@solid/community-server'
import { BadRequestHttpError } from '@solid/community-server'
import { NotFoundHttpError } from '@solid/community-server'
import type { IdentifierStrategy } from '@solid/community-server'
import { isContainerIdentifier } from '@solid/community-server'
import { cloneRepresentation } from '@solid/community-server'
import { readableToQuads } from '@solid/community-server'
import { LDP } from '../util/Vocabularies'
import type { Conditions } from '@solid/community-server'
import type { RepresentationConverter } from '@solid/community-server'
import { PassthroughStore } from '@solid/community-server'
import type { ResourceStore, ChangeMap } from '@solid/community-server'
import type { ShapeValidator } from './validators/ShapeValidator';
import namedNode = DataFactory.namedNode;

/**
 * ResourceStore which validates input data based on shapes.
 * When a validation is successful, the input data is written away in the backend.
 */
export class ShapeValidationStore extends PassthroughStore {
  private readonly identifierStrategy: IdentifierStrategy;
  private readonly metadataStrategy: AuxiliaryStrategy;
  private readonly converter: RepresentationConverter;
  private readonly validator: ShapeValidator;
  protected readonly logger = getLoggerFor(this);

  public constructor(source: ResourceStore, identifierStrategy: IdentifierStrategy, metadataStrategy: AuxiliaryStrategy,
    converter: RepresentationConverter, validator: ShapeValidator) {
    super(source);
    this.metadataStrategy = metadataStrategy;
    this.identifierStrategy = identifierStrategy;
    this.converter = converter;
    this.validator = validator;
  }

  public async addResource(identifier: ResourceIdentifier, representation: Representation, conditions?: Conditions):
  Promise<ChangeMap> {
    const parentRepresentation = await this.source.getRepresentation(identifier, {});

    await this.validator.handleSafe({ parentRepresentation, representation });

    return await this.source.addResource(identifier, representation, conditions);
  }

  public async setRepresentation(identifier: ResourceIdentifier, representation: Representation,
    conditions?: Conditions): Promise<ChangeMap> {
    if (this.metadataStrategy.isAuxiliaryIdentifier(identifier) &&
        isContainerIdentifier(this.metadataStrategy.getSubjectIdentifier(identifier))) {
      await this.validateConstrainedByCondition(identifier, representation);
    }


    if (!this.identifierStrategy.isRootContainer(identifier)) {
      const parentIdentifier = this.identifierStrategy.getParentContainer(identifier);
      // In case the parent being http://localhost:3123/.internal/setup/ getting the representation would result into a
      // NotFoundHttpError
      let parentRepresentation: BasicRepresentation = new BasicRepresentation();
      try {
        parentRepresentation = await this.source.getRepresentation(parentIdentifier, {});
      } catch (error: unknown) {
        if (!NotFoundHttpError.isInstance(error)) {
          throw error;
        }
      }
      await this.validator.handleSafe({ parentRepresentation, representation });
    }

    // Not allowed to create new containers within a constrained container
    const updatedResources = await this.source.setRepresentation(identifier, representation, conditions);
    if (updatedResources.size < 2) {
      return updatedResources;
    }
    if (updatedResources.size === 2 && !isContainerIdentifier(identifier)) {
      return updatedResources;
    }
    await this.validateNoContainersCreated(updatedResources);
    return updatedResources;

  }

  /**
   * Verify that no containers are created when going up in the hierarchy a container is constrained by a shape.
   * When a container is created in a constrained container,
   * all newly created resources are deleted and an error is thrown.
   *
   * @param updatedResources - Identifiers of resources that were possibly modified.
   */
  protected async validateNoContainersCreated(updatedResources: ChangeMap): Promise<void> {
    const topIdentifier = reduce(updatedResources.keys(),
        (a: ResourceIdentifier, b: ResourceIdentifier) => a.path.length < b.path.length ? a : b)

    const topRepresentation = await this.source.getRepresentation(topIdentifier, {});
    const topStore = await this.representationToStore(topIdentifier, topRepresentation);
    const shapes = this.extractShapes(topIdentifier, topStore);

    if (shapes.length > 0) {
      // deleted created resources
      const createdIdentifiers = Array.from(filter(updatedResources.keys(), (id: ResourceIdentifier) => id.path !== topIdentifier.path));
      const sortedIdentifiers = createdIdentifiers.sort((a: ResourceIdentifier, b: ResourceIdentifier) => b.path.length - a.path.length);
      for (const sortedIdentifier of sortedIdentifiers) {
        await this.source.deleteResource(sortedIdentifier);
      }
      throw new BadRequestHttpError("Not allowed to create new containers within a constrained container");
    }
  }

  /**
   * Verify that the modification to the description resource of a container regarding `ldp:constrainedBy` triples is valid.
   *
   * @param identifier - Identifier of a metadata resource of a container.
   * @param representation - Corresponding representation.
   */
  protected async validateConstrainedByCondition(identifier: ResourceIdentifier, representation: Representation): Promise<void> {
      const subjectIdentifier = this.metadataStrategy.getSubjectIdentifier(identifier);
      // Retrieve shapes from new and current representation
      const dataStore = await this.representationToStore(identifier, await cloneRepresentation(representation));
      const newShapes = this.extractShapes(identifier, dataStore);

      const currentShapes = this.extractShapes(
          identifier,
          await this.representationToStore(identifier, await this.source.getRepresentation(identifier, {})),
      );
      newShapes.forEach((shape: string): any => this.logger.debug(`New shape: ${shape}`));
      currentShapes.forEach((shape: string): any => this.logger.debug(`Shape already present: ${shape}`));
      // Verify that only there is at most one shapeConstraint per container
      // https://github.com/CommunitySolidServer/CommunitySolidServer/issues/942#issuecomment-1143789703
      if (newShapes.length > 1) {
        throw new BadRequestHttpError('A container can only be constrained by at most one shape resource.');
      }
      // Verify that no (non-auxiliary) resources are available in the container (children = 0)
      // https://github.com/CommunitySolidServer/CommunitySolidServer/issues/942#issuecomment-1143789703
      const children = dataStore.getObjects(namedNode(subjectIdentifier.path), LDP.terms.contains, null);
      if ((newShapes.length === 1 && !(currentShapes[0] === newShapes[0])) && children.length > 0) {
        throw new BadRequestHttpError(
            'A container can only be constrained when there are no resources present in that container.',
        );
      }
  }

  /**
   * Transforms the data of a representation to quads.
   * @param identifier - Identifier of the resource.
   * @param representation - Corresponding Representation.
   * @returns N3 store of the data of the Representation.
   */
  protected async representationToStore(identifier: ResourceIdentifier, representation: Representation): Promise<Store> {
    const preferences = { type: { [INTERNAL_QUADS]: 1 }};

    representation = await this.converter.handleSafe({
      identifier,
      representation: await cloneRepresentation(representation),
      preferences,
    });

    return await readableToQuads(representation.data);
  }

  /**
   * Extracts the shape URL(s) from a metadata resource.
   * @param identifier - Identifier of the resource.
   * @param store - N3 store of the corresponding resource (data).
   * @returns A list of shape URL(s).
   */
  protected extractShapes(identifier: ResourceIdentifier, store: Store): string[] {
    let subjectIdentifier: ResourceIdentifier = identifier;
    if (this.metadataStrategy.isAuxiliaryIdentifier(identifier)) {
      subjectIdentifier = this.metadataStrategy.getSubjectIdentifier(identifier);
    }

    return store.getObjects(
      namedNode(subjectIdentifier.path), LDP.terms.constrainedBy, null,
    ).map((shape: Term): string => shape.value);
  }
}
