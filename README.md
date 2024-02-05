<img width="1230" alt="Screenshot 2023-11-17 at 09 04 27" src="https://github.com/solid-contrib/pivot/assets/408412/62dfdec2-eb7c-4d43-ad1b-4ea885b853fa">

A spec-compliant Solid server for use on the [Solid Community server](https://solidcommunity.net), based on a remix of building blocks from the [Community Solid Server](https://github.com/CommunitySolidServer/CommunitySolidServer) project.

Feel free to [open a feature request](https://github.com/solid-contrib/pivot/issues/new) if you think `solidcommunity.net` should implement some additional feature - because it's a missing spec feature, or because it's a new optional or experimental spec feature, or just because you want to show a novel way for your Solid project to interact with a Solid pod server.

You can also [join the Matrix chat for solidcommunity.net](https://matrix.to/#/#solid_solidcommunity.net:gitter.im).

### Example usage
These are the bash commands to run on for example https://cloud.pondersource.com:8086/
```bash
root@cloud:~# git clone https://github.com/solid-contrib/pivot
Cloning into 'pivot'...
remote: Enumerating objects: 76, done.
remote: Counting objects: 100% (76/76), done.
remote: Compressing objects: 100% (52/52), done.
remote: Total 76 (delta 31), reused 56 (delta 19), pack-reused 0
Receiving objects: 100% (76/76), 19.78 MiB | 17.21 MiB/s, done.
Resolving deltas: 100% (31/31), done.
root@cloud:~# cd pivot
root@cloud:~/pivot# npm ci --skip=dev

added 830 packages, and audited 1041 packages in 36s

150 packages are looking for funding
  run `npm fund` for details

13 moderate severity vulnerabilities

To address issues that do not require attention, run:
  npm audit fix

To address all issues (including breaking changes), run:
  npm audit fix --force

Run `npm audit` for details.
root@cloud:~/pivot# npx community-solid-server -c ./config/https-mashlib-subdomain-file.json -f ./data --httpsKey /etc/letsencrypt/live/cloud.pondersource.com/privkey.pem --httpsCert /etc/letsencrypt/live/cloud.pondersource.com/fullchain.pem -p 8086 -b https://cloud.pondersource.com:8086
2023-11-24T09:36:47.005Z [Components.js] info: Initiating component discovery from /root/pivot/node_modules/@solid/community-server/
2023-11-24T09:36:47.971Z [Components.js] info: Discovered 168 component packages within 1041 packages
2023-11-24T09:36:47.973Z [Components.js] info: Initiating component loading
2023-11-24T09:37:07.756Z [Components.js] info: Registered 890 components
2023-11-24T09:37:07.768Z [Components.js] info: Loaded configs
2023-11-24T09:37:13.220Z [ServerInitializer] {Primary} info: Listening to server at https://localhost:8086/
```

Or on localhost:
```
git clone https://github.com/solid-contrib/pivot
cd pivot
npm install
npx community-solid-server -c ./config/https-mashlib-subdomain-file.json -f ./data --httpsKey ./self-signed.key --httpsCert ./self-signed.crt -p 8086 -b https://localhost:8086
```

### Why 'pivot'?
_Short answer:_ we needed a name. ;)

_Long answer:_ it comes from the role a Solid pod can play in a data portability scenario.
In traditional data portability, the user consents to organisation A transferring their data to organisation B.
A Solid pod, however, can act as a "pivot" for data sharing: data is first transferred from organisation A to the pod, and then from the pod to organisation B, without the two organisations ever interacting directly. The organisations only interact through the "pivot" that is owned by the user.
This greatly simplifies consent management and makes data access control user-centric. Hence the name "pivot" for this open source Solid server implementation. :)


Photo 138720473 © Leo Lintang | Dreamstime.com
