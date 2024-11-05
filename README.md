<img width="1230" alt="Screenshot 2023-11-17 at 09 04 27" src="https://github.com/solid-contrib/pivot/assets/408412/62dfdec2-eb7c-4d43-ad1b-4ea885b853fa">

A spec-compliant Solid server for use on the [Solid Community server](https://solidcommunity.net), based on a remix of building blocks from the [Community Solid Server](https://github.com/CommunitySolidServer/CommunitySolidServer) project.

Feel free to [open a feature request](https://github.com/solid-contrib/pivot/issues/new) if you think `solidcommunity.net` should implement some additional feature - because it's a missing spec feature, or because it's a new optional or experimental spec feature, or just because you want to show a novel way for your Solid project to interact with a Solid pod server.

You can also [join the Matrix chat for solidcommunity.net](https://matrix.to/#/#solid_solidcommunity.net:gitter.im).

### Under development

This server is still under active development, see [our first milestone](https://github.com/solid-contrib/pivot/milestone/1).
During this process, we are using [pivot.pondersource.com](https://pivot.pondersource.com) as a staging server.
These are the bash commands to run it there
```bash
certbot certonly --manual --preferred-challenges dns -d "pivot.pondersource.com" -d "*.pivot.pondersource.com"
git clone https://github.com/solid-contrib/pivot
cd pivot
npm install
npm run staging
```

In order to remove the [error from the domain root](https://github.com/solid-contrib/pivot/issues/15), make sure you have the following root ACL there:
```
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

In order to remove the [error from the domain root](https://github.com/solid-contrib/pivot/issues/15), make sure you have the following root ACL there:
```
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

### Why 'pivot'?
_Short answer:_ we needed a name. ;)

_Long answer:_ it comes from the role a Solid pod can play in a data portability scenario.
In traditional data portability, the user consents to organisation A transferring their data to organisation B.
A Solid pod, however, can act as a "pivot" for data sharing: data is first transferred from organisation A to the pod, and then from the pod to organisation B, without the two organisations ever interacting directly. The organisations only interact through the "pivot" that is owned by the user.
This greatly simplifies consent management and makes data access control user-centric. Hence the name "pivot" for this open source Solid server implementation. :)


Photo 138720473 © Leo Lintang | Dreamstime.com
