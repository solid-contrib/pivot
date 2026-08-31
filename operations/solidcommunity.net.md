# solidcommunity.net deployment

The production server is a single-process Pivot deployment behind the existing
TLS proxy. Runtime state stays outside the release checkout:

- pod and internal storage: `/mnt/volume_lon1_01/solidcommunity.net`
- SMTP configuration: `/home/solid/shared/solidcommunity.net-secrets.json`
- immutable checkouts: `/home/solid/releases/pivot-<git-sha>`
- active checkout symlink: `/home/solid/pivot-current`

The runtime dependencies are intentionally pinned in `package.json` and
`package-lock.json`. In particular, the deployment uses:

- `@jeswr/community-solid-server@7.1.10-alpha.1`
- `@jeswr/css-cached-storage@0.2.0`
- `mashlib@2.3.3`

## One-time host preparation

Create the shared directories and copy the existing live SMTP override to the
ignored shared config path. Do not print or copy its password into a checkout.

```bash
install -d -m 0755 /home/solid/releases /home/solid/shared
install -m 0600 /home/solid/test-pivot/config-override-solidcommunity.net.json \
  /home/solid/shared/solidcommunity.net-secrets.json
```

The copied legacy file contains non-secret overrides as well as the SMTP
override. Replace it with a file shaped like
`config/solidcommunity.net-secrets.example.json`, preserving the existing SMTP
password, before activating the new release.

## Prepare a release

Resolve the commit first and name the checkout after it. Never install over the
currently active directory.

```bash
git clone https://github.com/solid-contrib/pivot.git /home/solid/releases/pivot-new
cd /home/solid/releases/pivot-new
git checkout <reviewed-git-sha>
export PATH=/root/.nvm/versions/node/v20.18.0/bin:$PATH
npm ci
npm run build
npm ls @solid/community-server @jeswr/community-solid-server \
  @jeswr/css-cached-storage mashlib --depth=0
```

Rename `pivot-new` to `pivot-<git-sha>` after the install succeeds. Confirm the
secret file exists with mode `0600`; never log its contents.

## Activate

Keep the old PM2 definition available until the new release passes smoke tests.

```bash
ln -sfn /home/solid/releases/pivot-<git-sha> /home/solid/pivot-current
export PATH=/root/.nvm/versions/node/v20.18.0/bin:$PATH
pm2 startOrReload \
  /home/solid/pivot-current/ecosystem.solidcommunity.net.config.cjs \
  --only pivot --update-env
pm2 save
```

Verify the origin and public service, a representative pod container, Mashlib,
OIDC discovery, and PM2 stability. The restart count must not increase during a
15-minute observation window.

```bash
curl --fail --silent --show-error \
  http://127.0.0.1:3333/.well-known/openid-configuration \
  -H 'Host: solidcommunity.net'
curl --fail --silent --show-error https://solidcommunity.net/.well-known/openid-configuration
curl --fail --silent --show-error https://solidcommunity.net/mashlib.min.js >/dev/null
pm2 describe pivot
pm2 logs pivot --lines 200 --nostream
```

## Roll back

Point `pivot-current` at the previous immutable release and reload its ecosystem
file. This changes code and configuration only; it never rewinds pod data.

```bash
ln -sfn /home/solid/releases/pivot-<previous-git-sha> /home/solid/pivot-current
pm2 startOrReload \
  /home/solid/pivot-current/ecosystem.solidcommunity.net.config.cjs \
  --only pivot --update-env
pm2 save
```

For the first migration only, the legacy rollback target is
`/home/solid/test-pivot`, using the PM2 command recorded in the administrator
runbook. Keep that directory and its hotfix backups unchanged until the new
release has been stable for at least one day.
