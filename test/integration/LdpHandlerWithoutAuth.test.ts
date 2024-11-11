import fetch from 'cross-fetch';
import {DataFactory} from 'n3';
import type {App} from '@solid/community-server';
import {deleteResource, getResource, patchResource, postResource, putResource,} from '../util/FetchUtil';
import {getPort} from '../util/Util';
import {
    getDefaultVariables,
    getPresetConfigPath,
    getTestConfigPath,
    getTestFolder,
    instantiateFromConfig,
    removeFolder,
} from './Config';

const port = getPort('LpdHandlerWithoutAuth');
const baseUrl = `http://localhost:${port}/`;
const metaSuffix = '.meta';
const rootFilePath = getTestFolder('full-config-no-auth');
const stores: [string, any][] = [
    [ 'in-memory storage', {
        storeConfig: 'storage/backend/memory.json',
        teardown: jest.fn(),
    }],
    [ 'on-disk storage', {
        storeConfig: 'storage/backend/file.json',
        teardown: async(): Promise<void> => removeFolder(rootFilePath),
    }],
];

describe.each(stores)('An LDP handler allowing all requests %s', (name, { storeConfig, teardown }): void => {
    let app: App;

    beforeAll(async(): Promise<void> => {
        const variables = {
            ...getDefaultVariables(port, baseUrl),
            'urn:solid-server:default:variable:rootFilePath': rootFilePath,
        };

        // Create and start the server
        const instances = await instantiateFromConfig(
            'urn:solid-server:test:Instances',
            [
                getPresetConfigPath(storeConfig),
                getTestConfigPath('ldp-with-auth.json'),
            ],
            variables,
        ) as Record<string, any>;
        ({ app } = instances);

        await app.start();
    });

    afterAll(async(): Promise<void> => {
        await teardown();
        await app.stop();
    });

    const shape = `<http://example.org/exampleshape> a <http://www.w3.org/ns/shacl#NodeShape>.
    <http://example.org/exampleshape> <http://www.w3.org/ns/shacl#targetClass> <http://example.org/c>.
    <http://example.org/exampleshape> <http://www.w3.org/ns/shacl#property> <http://example.org/property>.
    <http://example.org/property> <http://www.w3.org/ns/shacl#path> <http://xmlns.com/foaf/0.1/name>.
    <http://example.org/property> <http://www.w3.org/ns/shacl#minCount> 1.
    <http://example.org/property> <http://www.w3.org/ns/shacl#maxCount> 1.
    <http://example.org/property> <http://www.w3.org/ns/shacl#datatype> <http://www.w3.org/2001/XMLSchema#string>.`;
    const conformingResource = `<a> a <http://example.org/c>.
    <a> <http://xmlns.com/foaf/0.1/name> "test".`;

    async function initialiseShapeContainer(shapeURL: string, constrainedContainerURL: string): Promise<void> {
        // PUT shape
        await putResource(shapeURL, { contentType: 'text/turtle', body: shape });

        // PUT container for constrained resources
        await putResource(constrainedContainerURL, { contentType: 'text/turtle' });

        // PATCH: Add shape constraint to container
        await patchResource(
            constrainedContainerURL + metaSuffix,
            `INSERT DATA { <${constrainedContainerURL}> <http://www.w3.org/ns/ldp#constrainedBy> <${shapeURL}>}`,
            'sparql',
            true,
        );

        const constrainedContainerResponse = await getResource(constrainedContainerURL);
        expect(constrainedContainerResponse.headers.get('link'))
            .toContain(`<${shapeURL}>; rel="http://www.w3.org/ns/ldp#constrainedBy"`);
    }

    async function cleanupShapeContainer(shapeURL: string, constrainedContainerURL: string): Promise<void> {
        expect(await deleteResource(constrainedContainerURL)).toBeUndefined();
        expect(await deleteResource(shapeURL)).toBeUndefined();
    }

    it('can validate RDF resources using SHACL shapes.', async(): Promise<void> => {
        const shapeURL = `${baseUrl}shape`;
        const constrainedContainerURL = `${baseUrl}constrained/`;

        await initialiseShapeContainer(shapeURL, constrainedContainerURL);

        // POST: Add resource to constrained container which is valid
        const postResponse = await postResource(
            constrainedContainerURL, { contentType: 'text/turtle', body: conformingResource },
        );

        // POST: Add resource to constrained container that is not valid
        const response1 = await fetch(constrainedContainerURL, {
            method: 'POST',
            headers: { 'content-type': 'text/turtle' },
            body: '<a> <b> <c>.',
        });
        expect(response1.status).toBe(400);

        // PUT: Add container resource (invalid)
        const response2 = await fetch(`${constrainedContainerURL}container/`, {
            method: 'PUT',
            headers: { 'content-type': 'text/turtle' },
        });
        expect(response2.status).toBe(400);

        // DELETE
        expect(await deleteResource(postResponse.headers.get('location')!)).toBeUndefined();
        await cleanupShapeContainer(shapeURL, constrainedContainerURL);
    });

    it('can not validate non-RDF resources using SHACL shapes.', async(): Promise<void> => {
        const shapeURL = `${baseUrl}shape`;
        const constrainedContainerURL = `${baseUrl}constrained/`;

        await initialiseShapeContainer(shapeURL, constrainedContainerURL);

        // POST non-RDF resource
        const response = await fetch(constrainedContainerURL, {
            method: 'POST',
            headers: { 'content-type': 'text/plain' },
            body: 'Hello world!',
        });
        expect(response.status).toBe(400);

        // DELETE
        await cleanupShapeContainer(shapeURL, constrainedContainerURL);
    });

    it('can not created containers within a constrained container.', async (): Promise<void> => {
        const shapeURL = `${baseUrl}shape`;
        const constrainedContainerURL = `${baseUrl}constrained/`;

        await initialiseShapeContainer(shapeURL, constrainedContainerURL);

        // new container directly
        const newContainerURL = `${constrainedContainerURL}shouldNotBeAllowed/`;

        const containerCreateResponse = await fetch(newContainerURL,{
            method: "PUT"
        });

        expect(containerCreateResponse.status).toBe(400);
        const containerGetResponse = await fetch(newContainerURL);
        expect(containerGetResponse.status).toBe(404);

        // new container indirectly
        const resourceURL = `${newContainerURL}resource`;

        const resourceCreateResponse = await fetch(resourceURL,{
            method: "PUT",
            headers: {'content-type':'text/turtle'},
            body: '<a> <b> <c>.'
        });
        expect(resourceCreateResponse.status).toBe(400);
        const resourceGetResponse = await fetch(resourceURL);
        expect(resourceGetResponse.status).toBe(404);

        // DELETE
        await cleanupShapeContainer(shapeURL, constrainedContainerURL);
    });
});
