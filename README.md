# Pivot

<img width="1230" alt="Screenshot 2023-11-17 at 09 04 27"
  src="https://github.com/solid-contrib/pivot/assets/408412/62dfdec2-eb7c-4d43-ad1b-4ea885b853fa">

A spec-compliant Solid server for use on the [Solid Community server](https://solidcommunity.net),
based on a remix of building blocks from the
[Community Solid Server](https://github.com/CommunitySolidServer/CommunitySolidServer) project.

Feel free to [open a feature request](https://github.com/solid-contrib/pivot/issues/new) if you think
`solidcommunity.net` should implement some
additional feature - because it's a missing spec feature, or because it's a new optional or experimental
spec feature, or just because you want
to show a novel way for your Solid project to interact with a Solid pod server.

You can also [join the Matrix chat for solidcommunity.net](https://matrix.to/#/#solid_solidcommunity.net:gitter.im).

## Example usage

These are the bash commands to run on for example [https://cloud.pondersource.com:8086/](https://cloud.pondersource.com:8086/).

```bash
root@cloud:~# git clone https://github.com/solid-contrib/pivot
root@cloud:~# cd pivot
root@cloud:~/pivot# npm ci --skip=dev
root@cloud:~/pivot# npm run staging

> pivot@1.0.0 staging
> npx community-solid-server -c ./config/https-mashlib-subdomain-file.json -f ./data --httpsKey /etc/letsencrypt/live/pivot.pondersource.com-0001/privkey.pem --httpsCert /etc/letsencrypt/live/pivot.pondersource.com-0001/fullchain.pem -p 443 -b https://pivot.pondersource.com

2024-11-11T14:19:43.511Z [Components.js] info: Initiating component discovery from /root/pivot/node_modules/@solid/community-server/
2024-11-11T14:19:44.189Z [Components.js] info: Discovered 168 component packages within 1107 packages
2024-11-11T14:19:44.192Z [Components.js] info: Initiating component loading
2024-11-11T14:19:53.509Z [Components.js] info: Registered 897 components
2024-11-11T14:19:53.510Z [Components.js] info: Loaded configs
2024-11-11T14:19:55.897Z [ServerInitializer] {Primary} info: Listening to server at https://localhost/
```

Or on localhost:

```bash
git clone https://github.com/solid-contrib/pivot
cd pivot
npm install
npm run build
npm test
npm start
```

In order to remove the [error from the domain root](https://github.com/solid-contrib/pivot/issues/15),
make sure you have the following root ACL there:

```bash
root@ota:~# cat /root/pivot/data/www/.acl
# Root ACL resource for the agent account
@prefix acl: <http://www.w3.org/ns/auth/acl#>.
@prefix foaf: <http://xmlns.com/foaf/0.1/>.

# The homepage is readable by the public
<#public>
    a acl:Authorization;
    acl:agentClass foaf:Agent;
    acl:accessTo <./>;
    acl:mode acl:Read.
```

## Why 'pivot'?

_Short answer:_ we needed a name. ;)

_Long answer:_ it comes from the role a Solid pod can play in a data portability scenario.
In traditional data portability, the user consents to organisation A transferring their data to organisation B.
A Solid pod, however, can act as a "pivot" for data sharing: data is first transferred from organisation A to the pod,
and then from the pod to organisation B, without the two organisations ever interacting directly. The organisations only
interact through the "pivot" that is owned by the user.
This greatly simplifies consent management and makes data access control user-centric. Hence the name "pivot" for this
open source Solid server implementation. :)

Photo 138720473 © Leo Lintang | Dreamstime.com
