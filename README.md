# Pivot

<img width="1230" alt="Screenshot 2023-11-17 at 09 04 27"
  src="https://github.com/solid-contrib/pivot/assets/408412/62dfdec2-eb7c-4d43-ad1b-4ea885b853fa">

A spec-compliant Solid server for use on the [Solid Community server](https://solidcommunity.net),
based on a remix of building blocks from the
[Community Solid Server](https://github.com/CommunitySolidServer/CommunitySolidServer) project.


This repo is a very thin wrapper around
[its four dependencies](https://github.com/solid-contrib/pivot/blob/70b0d5643d176ee90c70b955598973e3b97ab93d/package.json#L34-L39):
* [CSS](https://github.com/CommunitySolidServer/CommunitySolidServer)
* [mashlib](https://github.com/solidos/mashlib)
* [rdflib.js](https://github.com/linkeddata/rdflib.js)
* [css-mashlib](https://github.com/solidos/css-mashlib)

Apart from that, even for the code that this repo does add, some parts were
created using "copy, paste & edit" or in some cases also copied unchanged from the CSS repo,
which has the following copyright notice:

```
Copyright (c) 2019-2025 Inrupt Inc. and imec
```

and from the css-mashlib repo, which has the following copyright notice:
```
Copyright (c) 2022 SolidOS
```

Whereas npm dependencies don't require you to copy the copyright notice,
code copying and code remixing does. To honour the copyright involved in the
code contained in this repo, we hereby publish it under an MIT license,
with the following copyright notice:
```
Copyright (c) 2019-2025 Solid, CSS, and SolidOS Contributors, including Inrupt Inc. and imec
```

That is to say, this server implements a certain community flavour of Solid, namely:
* using [the Solid protocol](https://solidproject.org/TR/protocol)
* using WAC and not ACP
* but using an [older version of Solid OIDC](https://github.com/solid/solid-oidc/tree/a5a966c7342da01a57bfb316e5533ea7d82fd245), where storage access control is done with DPoP instead of with UMA
* ([under development](https://github.com/solid-contrib/pivot/issues/64)) using the PoP token issuer as an indication for app origin

Feel free to [open a feature request](https://github.com/solid-contrib/pivot/issues/new) if you think
`solidcommunity.net` should implement some
additional feature - because it's a missing spec feature, or because it's a new optional or experimental
spec feature, or just because you want
to show a novel way for your Solid project to interact with a Solid pod server.

You can also join the Matrix chat [for solidcommunity.net](https://matrix.to/#/#solid_solidcommunity.net:gitter.im)
or [for Pivot as piece of config+software](https://matrix.to/#/#solid_pivot:matrix.org).

## Warning
With Pivot's default settings, when a pod owner authenticates to a Solid app, this app can get full access to that user's data, on their own pod and elsewhere. This is not how we envision Solid's trinity of WebId's, Pods, and Solid apps, but it's what we have implemented so far. This is a problem that is not specific to Pivot, but that is shared among all WAC-based implementations of Solid.

See [this issue](https://github.com/solid-contrib/pivot/issues/78) for a discussion of how we might fix this situation.
In the meantime, we [warn the user](https://github.com/solid-contrib/pivot/pull/38) (in a much sterner way than most other WAC-based servers do) that in the Solid-OIDC flow they are not just sharing their identity with a Solid app, but are actually allowing that app to read and write any data on their behalf. Still, we are aware that the current situation is insecure.

## Example usage

These are the bash commands to run on for example [https://pivot.pondersource.com/](https://pivot.pondersource.com/).
* create an Ubuntu server
* set the DNS record for pivot.pondersource.com
* ssh into the server, `apt update`, `apt upgrade`
* get a wilcard cert
  * `apt install certbot`
  * `certbot certonly --manual --preferred-challenges dns --debug-challenges -v -d \*.pivot.pondersource.com -d pivot.pondersource.com`
  * add the `_acme-challenge.pivot` TXT record in DNS
  * check `dig txt _acme-challenge.pivot.pondersource.com`
  * continue certbot dialog
  * `ls /etc/letsencrypt/live/pivot.pondersource.com/`
* install node
  * `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash`
  * `source ~/.bashrc`
  * `nvm install 20`
* copy `config/customise-me.json`  to `./custom-config.json` and edit it:
  * email server settings (will need to at least fill in the auth pass here)
  * quota settings (defaults to 70 MB per pod)
  * pod template (defaults to `node_modules/css-mashlib`)
  * mashlib version (both data browser and static files; defaults to `node_modules/mashlib`)

```bash
root:~# git clone https://github.com/solid-contrib/pivot
root:~# cd pivot
root:~/pivot# npm ci --skip=dev
root:~/pivot# npm run build
root:~/pivot# mkdir -p data
root:~/pivot# cp -r www data/
root:~/pivot# cp config/customise-me.json custom-config.json
root:~/pivot# npx community-solid-server -c ./config/prod.json ./custom-config.json -f ./data --httpsKey /etc/letsencrypt/live/pivot.pondersource.com/privkey.pem --httpsCert /etc/letsencrypt/live/pivot.pondersource.com/fullchain.pem -p 443 -b https://pivot.pondersource.com -m .
2024-11-13T11:28:02.426Z [Components.js] info: Initiating component discovery from /root/pivot
2024-11-13T11:28:02.919Z [Components.js] info: Discovered 169 component packages within 1339 packages
2024-11-13T11:28:02.921Z [Components.js] info: Initiating component loading
2024-11-13T11:28:10.017Z [Components.js] info: Registered 904 components
2024-11-13T11:28:10.018Z [Components.js] info: Loaded configs
2024-11-13T11:28:12.002Z [ServerInitializer] {Primary} info: Listening to server at https://localhost/
```

Or on localhost:

```bash
git clone https://github.com/solid-contrib/pivot
cd pivot
npm install
npm run build
npm test
openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -sha256 -days 3650 -nodes -subj "/C=XX/ST=StateName/L=CityName/O=CompanyName/OU=CompanySectionName/CN=CommonNameOrHostname"
npm start
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
