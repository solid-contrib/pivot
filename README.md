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

You can also join the Matrix chat [for solidcommunity.net](https://matrix.to/#/#solid_solidcommunity.net:gitter.im)
or [for Pivot as piece of config+software](https://matrix.to/#/#solid_pivot:matrix.org).

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

```bash
root:~# git clone https://github.com/solid-contrib/pivot
root:~# cd pivot
root:~/pivot# npm ci --skip=dev
root:~/pivot# npm run build
root:~/pivot# npx community-solid-server -c ./config/prod.json -f ./data --httpsKey /etc/letsencrypt/live/pivot.pondersource.com/privkey.pem --httpsCert /etc/letsencrypt/live/pivot.pondersource.com/fullchain.pem -p 443 -b https://pivot.pondersource.com -m .
2024-11-13T11:28:02.426Z [Components.js] info: Initiating component discovery from /root/pivot
2024-11-13T11:28:02.919Z [Components.js] info: Discovered 169 component packages within 1345 packages
2024-11-13T11:28:02.921Z [Components.js] info: Initiating component loading
2024-11-13T11:28:10.017Z [Components.js] info: Registered 901 components
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
