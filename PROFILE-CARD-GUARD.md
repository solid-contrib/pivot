# Profile Card Guard

Pivot can protect the **profile card of the WebIDs that are registered on this server**.

A WebID such as `https://example.com/alice/profile/card#me` is the identity an account
logs in with. Solid-OIDC requires the card to state that the account's identity
provider (this server) is allowed to issue tokens for it:

```turtle
<https://example.com/alice/profile/card#me> solid:oidcIssuer <https://example.com/>.
```

If the card is deleted, or that triple is removed, the account can no longer log in.
The guard prevents exactly that, and leaves everything else on the pod untouched.

---

## What is protected

* The profile card document of a WebID that is **registered to an account on this
  server** — for the default layout, `/<pod>/profile/card`.
* Nothing else: other documents and containers, and cards of WebIDs from elsewhere,
  are read and written as usual. Deleting `/<pod>/profile/card` of a *registered*
  WebID is an error; the same file for an unregistered WebID is an ordinary document.

Writes affected: `PUT`, `POST` (when the target URL is already known) and `PATCH`
results. Reads are never affected: `GET`, `HEAD` and `OPTIONS` behave as usual.

---

## REST error codes

Both errors are raised **before** the write reaches the storage backend, so a rejected
request leaves the stored card exactly as it was.

| Response | Meaning | Typical cause |
| --- | --- | --- |
| `400 Bad Request` | The new content of the card is not usable as a WebID card. | The body cannot be parsed as RDF, or the resulting document no longer contains the `<webId> solid:oidcIssuer <server>` triple. |
| `403 Forbidden` | The card of a registered WebID cannot be removed. | `DELETE /<pod>/profile/card` while the WebID is still registered to an account. |

`401 Unauthorized` is **not** from the guard: authentication happens first, so an
unauthenticated write is rejected before the guard ever sees it.

A write that keeps the card valid succeeds normally — `205 Reset Content` for an
update, `201 Created` for a new document, `205` for a delete.

Note that a card keeps advertising `DELETE` in its `Allow` header, and the refusal is
not announced anywhere else: a client simply has to be ready for the `403`.

### Examples

```bash
# accepted: the card keeps its issuer triple → 205
curl -X PUT https://example.com/alice/profile/card \
     -H 'content-type: text/turtle' \
     --data '@prefix solid: <http://www.w3.org/ns/solid/terms#>.
<https://example.com/alice/profile/card#me> solid:oidcIssuer <https://example.com/>;
                                           solid:name "Alice".'

# rejected: the issuer triple is gone → 400
curl -X PUT https://example.com/alice/profile/card \
     -H 'content-type: text/turtle' \
     --data '<https://example.com/alice/profile/card#me> solid:name "Alice".'

# rejected: the identity is in use → 403
curl -X DELETE https://example.com/alice/profile/card
```

---

## The `relativeWebIdPaths` array and the WebID index

The guard does not decide on its own which files are cards. It uses two things:

* the **WebID index** — the server's own record of which WebIDs are registered to an
  account (`WebIdStore.hasWebId()`, stored as an indexed lookup in the account storage).
  This is the source of truth.
* the **`relativeWebIdPaths` array** — a list of *path shapes* the server uses for the
  WebIDs it creates, e.g. `/profile/card#me`.

On every write, the request path is turned into a candidate WebID with each array entry
that matches it, and the guard asks the WebID index whether that candidate is registered.
Only registered candidates are protected.

The array is therefore a list of **candidates, not a list of protected files**:

* adding an entry protects nothing by itself — a `/profile/card` that hosts no
  registered WebID stays an ordinary document;
* two entries are useful when the server changed its layout, e.g. `/profile/card#me`
  for pods created now and an older path that is still in use for existing accounts;
* the fragment is optional: `/profile/card#me` protects the document `/<pod>/profile/card`
  and derives the WebID `…#me`; `/profile/card` derives the WebID from the document URL
  itself.

---

## Allowing a card to be deleted

A registered WebID's card can be removed once the WebID is no longer registered — for
example when the account is cleaned up or the identity is moved elsewhere:

1. Unlink the WebID from the account through the account API (the controls advertised at
   `/.account/`; the pod-management UI does the same):
   `GET` the account's WebID list, then `DELETE` the link of that WebID.
2. The WebID is now absent from the WebID index, so the card is no longer protected.
3. `DELETE` the card as usual → `205 Reset Content`.

### Status codes around the account API

The account API is an API of its own and does not answer like a pod resource. Measured
on Pivot with the guard enabled (in-memory test server, CSS 7.2.0):

| Request | Response |
| --- | --- |
| `GET <account/webid/>` | `200` with `{"webIdLinks":{"<webid>":"<link url>"}}`; `401` without a session |
| `POST <account/webid/>` | links another WebID to the account; needs a JSON body with the WebID (`400` without one) |
| `DELETE <account/webid/<id>/>` | `200` — the WebID is unlinked and its card is free again |
| `GET`/`HEAD`/`POST <account/webid/<id>/>` | **not implemented** — a link resource only accepts `DELETE`. The server answers `501 Not Implemented` ("Cannot determine permissions of GET, only DELETE"), which CSS wraps in an aggregate error, so some configurations report it as `500`. |
| `DELETE <card>` after unlinking | `205 Reset Content` |
| `DELETE <card>` a second time | `404 Not Found`, with `Allow: PATCH, PUT` |

---

## Where it is configured

The guard is a Pivot module: `config/storage/profile-card-guard.json`.

```json
{
  "@id": "urn:solid-server:default:ResourceStore_CardGuard",
  "@type": "ProfileCardGuard",
  "source": { "@id": "urn:solid-server:default:ResourceStore_Converting" },
  "webIdStore": { "@id": "urn:solid-server:default:WebIdStore" },
  "baseUrl": { "@id": "urn:solid-server:default:variable:baseUrl" },
  "converter": { "@id": "urn:solid-server:default:RepresentationConverter" },
  "relativeWebIdPaths": [ "/profile/card#me" ]
}
```

The module is imported once by the server configurations (`config/prod.json`,
`config/suffix.json`, `config/dev-http-suffix.json`, `config/dev-http-subdomain.json`).

Notes:

* the issuer triple is compared against the server's root `baseUrl`, so the same
  configuration works in suffix and subdomain mode;
* writes to the account storage itself (accounts, WebID links, …) bypass the guard;
* a `POST` that creates a brand-new document is only validated when its final URL is
  already known — a resource that did not exist yet cannot host a registered WebID.

### Supporting another card layout

Do not edit the module — **override it** from your own server configuration (the file
you start the server with, next to the one that imports the guard):

```json
{
  "@context": [
    "https://linkedsoftwaredependencies.org/bundles/npm/@solid/community-server/^7.0.0/components/context.jsonld",
    "https://linkedsoftwaredependencies.org/bundles/npm/@solid/pivot/^1.0.0/components/context.jsonld"
  ],
  "@graph": [
    {
      "@type": "Override",
      "overrideInstance": { "@id": "urn:solid-server:default:ResourceStore_CardGuard" },
      "overrideParameters": {
        "relativeWebIdPaths": [ "/profile/card#me", "/card#me" ]
      }
    }
  ]
}
```

What to know:

* the `@context` lists the Pivot components context as well, because `ProfileCardGuard`
  (and the module's other type names) live there — the CSS context alone resolves
  `Override`, but not the guard's own types;
* only the parameters you list are replaced — `source`, `webIdStore`, `baseUrl` and
  `converter` keep the values from `config/storage/profile-card-guard.json`;
* the array **replaces** the configured list, so repeat every path you still want
  (the example keeps `/profile/card#me` and adds an older layout `/card#me`);
* if you pass a `@type` in `overrideParameters` as well, the instance counts as fully
  replaced and you then have to repeat **all** its parameters;
* a listed path only *recognises* cards — whether a document is protected is still
  decided by the WebID index, so adding a path protects nothing on its own, and WebIDs
  of the old layout stay protected as long as they are registered;
* quick check after the change: as the owner of a registered WebID,
  `DELETE <pod>/<that path>` → `403`; the same request on a document hosting no
  registered WebID → `205`.
