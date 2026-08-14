# Aurora cutover and revert

The database host is a single variable, `DB_HOST`, read by `deploy.sh`. Unset,
it renders `postgres`, the compose service name of the co-located container,
which is what every deploy before Aurora produced. Set, it renders the Aurora
writer endpoint into both `DATABASE_URL` (runtime, `pod_app`) and
`DATABASE_OWNER_URL` (migrations and seed, `pod`). The two always move together.

Every deploy prints which database it is deploying against, before it touches
anything. If that line says anything other than the co-located container, the
app is on Aurora.

## Cut over

```bash
cd infra
DB_HOST="$(terraform -chdir=terraform output -raw aurora_writer_endpoint)" ./deploy.sh
```

The writer endpoint, not the reader: migrations and every write go through this
one URL. `DB_HOST` carries the host only. The port stays 5432 on both sides,
which is the Aurora default and what the cluster's security group opens, so
there is nothing else to parameterise.

## Revert, one step

```bash
cd infra
env -u DB_HOST ./deploy.sh
```

`env -u` rather than a plain `./deploy.sh` because it also covers the case where
`DB_HOST` is exported in the current shell. That is the whole revert. Nothing
else is pinned to the Aurora endpoint: no unit file, no compose file, no
application config. The next deploy re-renders `.env` from Secrets Manager with
the host back to `postgres`, restarts the stack against it, and the demo-roll
timer follows on its own because it reads the same `.env`.

Migrations do not need re-running on the way back. The co-located database was
never taken out of service, so it still holds the schema and the rows it had at
cutover, minus anything written to Aurora in the meantime. That gap is the real
cost of a revert, and it is why the revert is worth doing early rather than late.

## Where the old connection string is recorded

Three places, in order of how much you should trust them.

1. **Reproduced, not stored.** `deploy.sh` with `DB_HOST` unset regenerates the
   pre-Aurora URLs exactly. The passwords come from the Secrets Manager entry
   `pod-v2/runtime` (`POSTGRES_PASSWORD`, `POD_APP_PASSWORD`), which the cutover
   never touched. This is the authority.
2. **`/home/ec2-user/pod-v2/.env.prev`** on the instance, mode 0600. `deploy.sh`
   copies the outgoing `.env` here before writing the new one, so immediately
   after a cutover this file is the literal pre-Aurora render. `diff .env.prev
   .env` is how you confirm a cutover, or a revert, actually changed the one
   line you expected.
3. **`/home/ec2-user/pod-v2/.env`** is always the live truth for what the app is
   using right now. It is not history: every deploy overwrites it.

## The old database is the fallback

The co-located `postgres` container is deliberately left running after cutover.
It keeps its named volume `pod-v2_pod_pg`, it keeps its data, and it stays in
`docker-compose.prod.yml`. It is not orphaned, and it is not waiting to be
cleaned up. It is the rollback target, and the revert above only works because
it is still there. Do not stop it, do not remove the volume, and do not prune it
out of compose until Aurora has been the live database long enough that going
back is no longer a plan you would act on.

## Demo-roll timer

The nightly demo roll used to name the co-located container directly
(`docker exec -i pod-v2-postgres-1 psql ...`), which after a cutover would have
kept succeeding against the database nobody reads while the demo logins opened
on an empty round. That unit was created by hand on the instance and was never
in this repo. It now is, at `infra/systemd/`, rewritten to read
`DATABASE_OWNER_URL` out of the deployed `.env` so it follows the app.

Install it once, as root on the instance, **before** the cutover. `deploy.sh`
rsyncs the files to `~/pod-v2/systemd/` but does not install them:

```bash
sudo install -m 644 /home/ec2-user/pod-v2/systemd/pod-demo-roll.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pod-demo-roll.timer
sudo systemctl start pod-demo-roll.service   # roll once now to prove it works
journalctl -u pod-demo-roll.service -n 30 --no-pager
```

The final `SELECT` in the roll prints `stops_today` and `pending`, so the
journal shows which database it actually reached. Check it once after cutover
and once after revert. No reinstall is needed on either transition.
