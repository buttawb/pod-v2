#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# aurora-migrate.sh
#
# Copies the live database out of the co-located Postgres container into
# Aurora, then proves the copy is faithful. It is the step between "the Aurora
# cluster exists" (terraform) and "the app is pointed at it" (deploy.sh with
# DB_HOST set). See infra/AURORA.md for the cutover and revert around it.
#
# THE SOURCE IS NEVER WRITTEN TO. Not dropped, not truncated, not updated, not
# vacuumed, and not locked beyond what a plain SELECT takes. That is not only a
# promise in a comment: every session this script opens against the source is
# opened with default_transaction_read_only=on, so the source server itself
# rejects any write, including one this script issued by mistake. Preflight
# proves the guard is in force before anything else runs. The container is the
# rollback target for the entire cutover and it has to still be there, byte for
# byte, if Aurora turns out to be wrong.
#
# Re-runnable. Phases 2 to 4 are idempotent: the role is created only if it is
# absent, migrations are tracked and skip what has already run, and the load
# truncates the TARGET tables before restoring, so a half finished run leaves
# nothing behind to double up. Running it twice produces the same database and
# the same report.
#
#   ./aurora-migrate.sh                 full run: preflight, role, migrate, copy, verify
#   ./aurora-migrate.sh --verify-only   read only against both sides, changes nothing
#   ./aurora-migrate.sh --skip-copy     schema and role only, no data
#   ./aurora-migrate.sh --skip-migrate  data only, into a schema already there
#
# Everything runs on the API instance over SSH, the same way deploy.sh does,
# for two reasons that are not convenience. The source container publishes no
# host port, so docker exec on the box is the only way to reach it. And Aurora
# admits exactly one security group, the API host's, so a laptop cannot reach
# the writer endpoint at all. The instance is the one place both ends are
# visible from, which is the same property that makes the cutover safe.
#
# No credential is ever an argument to any command, on either machine. They are
# written once into 0600 files on the instance, reached through PGPASSFILE and
# docker --env-file, and removed by the exit trap.
#
# Written for bash 3.2, which is still what /bin/bash is on macOS: no
# associative arrays, no mapfile, no ${var,,}.
# ---------------------------------------------------------------------------
set -euo pipefail

cd "$(dirname "$0")"

# ---------------------------------------------------------------------------
# Configuration. Every value is an environment variable or a terraform output.
# Nothing about the target is hardcoded, which is what lets this rehearse
# against a throwaway cluster and then run against the real one with no edit.
# ---------------------------------------------------------------------------
SSH_USER="${SSH_USER:-ec2-user}"
AWS_REGION="${AWS_REGION:-ap-southeast-1}"
REMOTE_DIR="${REMOTE_DIR:-/home/${SSH_USER:-ec2-user}/pod-v2}"

# Source: the container on the box. Read only, always.
SRC_CONTAINER="${SRC_CONTAINER:-pod-v2-postgres-1}"
SRC_DB="${SRC_DB:-pod}"
SRC_OWNER="${SRC_OWNER:-pod}"

# Target.
AURORA_PORT="${AURORA_PORT:-5432}"
AURORA_DB="${AURORA_DB:-pod}"
AURORA_OWNER_USER="${AURORA_OWNER_USER:-pod}"
# require encrypts the connection but does not verify the server certificate.
# verify-full is better and needs the RDS CA bundle mounted into the client
# container, which is why it is available here rather than assumed.
AURORA_SSLMODE="${AURORA_SSLMODE:-require}"

# The client image, deliberately the same image the source server runs, so
# pg_dump, pg_restore and psql are exactly the version of the server they read
# and match the 16.14 Aurora is pinned to. It is already on the box, so nothing
# is pulled.
PG_IMAGE="${PG_IMAGE:-postgres:16-alpine}"

# The API image, for the migration runner. Built by deploy.sh.
APP_IMAGE="${APP_IMAGE:-pod-backend:latest}"

REMOTE_WORK="/home/${SSH_USER}/.pod-aurora"

# Load order. Not alphabetical, and not negotiable: foreign keys stay enforced
# for the whole load, so a child row can only be inserted once its parent is
# there. The long comment above phase 4 is why that is the approach rather than
# turning the constraints off.
TABLE_ORDER="drivers devices office_users stops pods ai_summary_cache backfill_progress erasure_log delivery_attempts refresh_tokens attempt_photos ai_summaries"
TABLE_COUNT=12

# Every table this script is responsible for, plus migrations, which is rebuilt
# rather than copied. Verification asserts the live catalog holds exactly this
# set, so a migration that adds a thirteenth table cannot slip through
# uncopied and unnoticed.
ALL_TABLES_SORTED="ai_summaries ai_summary_cache attempt_photos backfill_progress delivery_attempts devices drivers erasure_log migrations office_users pods refresh_tokens stops"

SKIP_MIGRATE=0
SKIP_COPY=0
VERIFY_ONLY=0
KEEP_WORKDIR=0

for arg in "$@"; do
  case "$arg" in
    --verify-only)  VERIFY_ONLY=1; SKIP_MIGRATE=1; SKIP_COPY=1 ;;
    --skip-migrate) SKIP_MIGRATE=1 ;;
    --skip-copy)    SKIP_COPY=1 ;;
    --keep-workdir) KEEP_WORKDIR=1 ;;
    -h|--help)      sed -n '2,42p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)              echo "unknown argument: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# Reporting. Verification failures accumulate rather than abort, because the
# useful output of a bad run is the whole picture: three tables short-loaded
# and the grants also wrong is a different diagnosis from the first table
# alone. Preflight is the exception and dies on the spot, since every later
# check would be measuring nothing.
# ---------------------------------------------------------------------------
CHECKS_PASS=0
CHECKS_FAIL=0
CHECKS_WARN=0
FAILURES=""
WARNINGS=""

banner() { printf '\n==> %s\n' "$*"; }
step()   { printf '\n--- %s\n' "$*"; }
info()   { printf '      %s\n' "$*"; }
pass()   { CHECKS_PASS=$((CHECKS_PASS + 1)); printf '  PASS  %s\n' "$*"; }
warn()   { CHECKS_WARN=$((CHECKS_WARN + 1)); printf '  WARN  %s\n' "$*"; WARNINGS="${WARNINGS}    ${*}"$'\n'; }
fail()   { CHECKS_FAIL=$((CHECKS_FAIL + 1)); printf '  FAIL  %s\n' "$*"; FAILURES="${FAILURES}    ${*}"$'\n'; }
# Records a failure without printing it, for the row-count table, which prints
# its own FAIL column and would otherwise say the same thing twice.
fail_quiet() { CHECKS_FAIL=$((CHECKS_FAIL + 1)); FAILURES="${FAILURES}    ${*}"$'\n'; }
die()    { printf '\nPREFLIGHT REFUSED: %s\n' "$*" >&2; exit 2; }

LOCAL_WORK="$(mktemp -d "${TMPDIR:-/tmp}/aurora-migrate.XXXXXX")"
REMOTE_READY=0

cleanup() {
  # The remote working directory holds the pgpass file, the rendered owner URL
  # and a data-only dump of every row in the database. None of it should
  # outlive the run. --keep-workdir exists for debugging a failed load and says
  # so out loud, because leaving that behind is a real decision.
  if [ "$REMOTE_READY" -eq 1 ]; then
    if [ "$KEEP_WORKDIR" -eq 1 ]; then
      printf '\nworking directory kept at %s:%s (holds credentials and a full data dump)\n' \
        "$HOST" "$REMOTE_WORK"
    else
      "${SSH_CMD[@]}" "rm -rf ${REMOTE_WORK}" 2>/dev/null || true
    fi
  fi
  rm -rf "$LOCAL_WORK"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 1. PREFLIGHT
# ---------------------------------------------------------------------------
banner "1. Preflight"

command -v ssh >/dev/null 2>&1 || die "ssh is not on PATH"
command -v scp >/dev/null 2>&1 || die "scp is not on PATH"

HOST="${HOST:-$(terraform -chdir=terraform output -raw backend_public_ip 2>/dev/null || true)}"
[ -n "$HOST" ] || die "HOST is unset and 'terraform output backend_public_ip' produced nothing"

# The endpoint comes from the environment or from the terraform output that
# names it, never from a literal in this file. A hostname pasted into a script
# survives until the cluster is replaced, and then points somewhere that either
# does not answer or, worse, does.
AURORA_HOST="${AURORA_HOST:-$(terraform -chdir=terraform output -raw aurora_writer_endpoint 2>/dev/null || true)}"
[ -n "$AURORA_HOST" ] || die "AURORA_HOST is unset and 'terraform output aurora_writer_endpoint' produced nothing.
    Set it explicitly:
      AURORA_HOST=<cluster>.cluster-xxxx.${AWS_REGION}.rds.amazonaws.com ./aurora-migrate.sh"

# A guard against the single worst thing this script could do. The load phase
# truncates its target before restoring. Pointed at the source by an unlucky
# copy and paste, that would destroy the fallback the whole cutover plan rests
# on. An RDS endpoint is the only thing that can legitimately be the target, so
# anything else has to be asked for by name.
case "$AURORA_HOST" in
  postgres|localhost|127.0.0.1|"$SRC_CONTAINER")
    die "AURORA_HOST is '${AURORA_HOST}', which names the SOURCE database. The load phase truncates its target." ;;
  *.rds.amazonaws.com)
    : ;;
  *)
    if [ "${AURORA_ALLOW_NON_RDS_HOST:-0}" != "1" ]; then
      die "AURORA_HOST '${AURORA_HOST}' is not an *.rds.amazonaws.com endpoint.
    The load phase truncates its target, so a target that is not obviously Aurora has to be
    confirmed. Re-run with AURORA_ALLOW_NON_RDS_HOST=1 if that host really is the new cluster."
    fi
    warn "target ${AURORA_HOST} is not an RDS endpoint, accepted via AURORA_ALLOW_NON_RDS_HOST=1" ;;
esac

# ControlMaster because this script opens roughly twenty short SSH sessions and
# a new TCP and TLS handshake for each one turns a two minute run into a five
# minute one. The socket lives in the local working directory and goes with it.
SSH_CMD=(ssh
  -o StrictHostKeyChecking=accept-new
  -o ConnectTimeout=15
  -o ControlMaster=auto
  -o "ControlPath=${LOCAL_WORK}/ssh-%r@%h:%p"
  -o ControlPersist=120
  "${SSH_USER}@${HOST}")
remote() { "${SSH_CMD[@]}" bash -s; }

info "instance   ${SSH_USER}@${HOST}"
info "source     docker exec ${SRC_CONTAINER}, database ${SRC_DB}, read only"
info "target     ${AURORA_HOST}:${AURORA_PORT}/${AURORA_DB} as ${AURORA_OWNER_USER}"

# Passwords. Leaving them unset is the better path and therefore the default:
# the instance reads them from Secrets Manager with its own IAM role, so
# nothing is typed, nothing lands in a shell history, and nothing crosses the
# wire from here. Setting them explicitly is supported for a rehearsal cluster
# whose master password is not the one in Secrets Manager.
CRED_SOURCE="secretsmanager"
if [ -n "${AURORA_OWNER_PASSWORD:-}" ] || [ -n "${POD_APP_PASSWORD:-}" ]; then
  [ -n "${AURORA_OWNER_PASSWORD:-}" ] || die "POD_APP_PASSWORD is set but AURORA_OWNER_PASSWORD is not. Set both or neither."
  [ -n "${POD_APP_PASSWORD:-}" ]      || die "AURORA_OWNER_PASSWORD is set but POD_APP_PASSWORD is not. Set both or neither."
  CRED_SOURCE="env"
fi

# Both passwords end up inside a postgres:// URL in a rendered .env, so any
# character that terminates a URL component terminates the password with it.
# terraform's validation on the master password already rejects / " @ and
# space. These it does not cover, and they fail in a way that reads as an
# authentication problem rather than a parsing one, which is the worst way for
# a cutover to fail.
check_url_safe() {
  case "$2" in
    *"#"*|*"?"*|*"%"*|*" "*|*"/"*|*"@"*|*'"'*)
      die "${1} contains one of  # ? % / @ \"  or a space.
    deploy.sh renders it into postgres://user:PASSWORD@host/db, where those characters end the
    password early. Rotate the secret to a value without them." ;;
  esac
}
if [ "$CRED_SOURCE" = "env" ]; then
  check_url_safe AURORA_OWNER_PASSWORD "$AURORA_OWNER_PASSWORD"
  check_url_safe POD_APP_PASSWORD "$POD_APP_PASSWORD"
fi

SECRET_NAME="${SECRET_NAME:-$(terraform -chdir=terraform output -raw runtime_secret_name 2>/dev/null || echo pod-v2/runtime)}"

step "instance reachable"
remote >/dev/null <<'EOF' || die "cannot ssh to the instance, or docker is not usable there"
set -euo pipefail
docker version >/dev/null
EOF
pass "ssh and docker on ${HOST}"

# The load phase truncates every table on the target and reloads it from the
# container. That is safe exactly while the container is still the database of
# record, and it is data loss the moment it is not.
#
# After cutover the app writes evidence to Aurora and the container stops
# receiving it. A re-run then empties tables holding attempts that exist in no
# other copy, because the container is a stale fallback and not a backup of
# Aurora. Nothing in the append-only grants stops it: those constrain pod_app,
# and this script connects as the owner.
#
# So the check belongs here, in preflight, hundreds of lines before the
# TRUNCATE, rather than in the reporting at the end where it was only ever an
# informational line.
step "refusing to reload a cluster the app is already live on"
LIVE_ENV_HOST="$(remote 2>/dev/null <<EOF || true
set -euo pipefail
sed -n 's|^DATABASE_URL=postgres://[^@]*@\([^:]*\):.*|\1|p' ${REMOTE_DIR}/.env 2>/dev/null || true
EOF
)"
if [ "$LIVE_ENV_HOST" = "$AURORA_HOST" ] && [ "${ALLOW_RELOAD_AFTER_CUTOVER:-no}" != "yes" ]; then
  die "the deployed .env already points DATABASE_URL at ${AURORA_HOST}.

    The app is live on this cluster, so the truncate-and-reload in the load phase would
    delete evidence captured since the cutover and replace it with an older snapshot from
    the container. That evidence exists nowhere else.

    To verify the copy without touching data, re-run with --verify-only.
    If you genuinely intend to discard what Aurora holds and reload from the container,
    set ALLOW_RELOAD_AFTER_CUTOVER=yes and say so out loud to whoever owns the data."
fi
if [ -n "$LIVE_ENV_HOST" ]; then
  pass "app is on '${LIVE_ENV_HOST}', which is not the cluster being loaded"
else
  pass "no deployed DATABASE_URL host could be read, so nothing is live on the target yet"
fi

step "source database reachable, and refusing writes"
SRC_VERSION="$(remote <<EOF || true
set -euo pipefail
docker exec -e PGOPTIONS='-c default_transaction_read_only=on' ${SRC_CONTAINER} \
  psql -U ${SRC_OWNER} -d ${SRC_DB} -tAc 'SHOW server_version'
EOF
)"
[ -n "$SRC_VERSION" ] || die "container ${SRC_CONTAINER} did not answer.
    It is the rollback target for the whole cutover and has to be running before anything moves."
pass "source is PostgreSQL ${SRC_VERSION} in ${SRC_CONTAINER}"

# Prove the read-only guarantee rather than asserting it. A read-only
# transaction rejects all DDL, so a CREATE that is allowed through means
# PGOPTIONS is not reaching the server and the central safety property of this
# script is not actually in force. Better to find that out now than to find out
# by having written to the fallback.
SRC_RO="$(remote 2>&1 <<EOF || true
set -euo pipefail
docker exec -e PGOPTIONS='-c default_transaction_read_only=on' ${SRC_CONTAINER} \
  psql -U ${SRC_OWNER} -d ${SRC_DB} -tAc 'CREATE TEMP TABLE aurora_migrate_readonly_probe (x int)' 2>&1 || true
EOF
)"
case "$SRC_RO" in
  *"read-only transaction"*)
    pass "the source server itself refuses writes from this script's sessions" ;;
  *)
    die "the read-only guard is NOT in force on the source. The probe said:
      ${SRC_RO}
    Refusing to continue. The one property this script must never lose is that it cannot write
    to the database the rollback depends on." ;;
esac

# A live source is a moving source. Counts and checksums are taken after the
# load, so anything the API writes in between shows up as a difference. Saying
# so up front is the difference between reading that as a fault and reading it
# as arithmetic.
BACKENDS_UP="$(remote <<'EOF' || true
set -euo pipefail
docker ps --filter 'name=pod-v2-backend' --format '{{.Names}}' | grep -c . || true
EOF
)"
if [ "${BACKENDS_UP:-0}" != "0" ]; then
  info "${BACKENDS_UP} backend container(s) are serving traffic right now."
  info "stops, devices, refresh_tokens and the ai_ tables can legitimately move during the copy."
  info "For a byte-exact copy, quiesce the API first. This script will not stop it for you."
fi

step "shipping the working directory"
# umask before anything is created, so no file is briefly world readable
# between being created and being chmodded.
remote <<EOF || die "could not create the working directory on the instance"
set -euo pipefail
umask 077
rm -rf ${REMOTE_WORK}
mkdir -p ${REMOTE_WORK}
EOF
REMOTE_READY=1

# When passwords come from the environment they travel inside this heredoc
# body, which is delivered on ssh's stdin to a remote bash. They are never an
# argument to any command on either machine, so they cannot show up in ps
# output or in a shell history. The inner delimiter is quoted so the remote
# shell does not touch the bytes.
if [ "$CRED_SOURCE" = "env" ]; then
  remote <<EOF || die "could not stage the supplied credentials"
set -euo pipefail
umask 077
cat > ${REMOTE_WORK}/creds <<'CREDS'
${AURORA_OWNER_PASSWORD}
${POD_APP_PASSWORD}
CREDS
EOF
fi

scp -q -o StrictHostKeyChecking=accept-new aurora-verify.sql \
  "${SSH_USER}@${HOST}:${REMOTE_WORK}/verify.sql" \
  || die "could not copy aurora-verify.sql to the instance"

# One place renders every file that holds a credential, so there is one place
# to read to know where a password can end up. Fingerprints come back. Values
# do not.
FINGERPRINTS="$(remote <<EOF || die "could not render the credential files on the instance"
set -euo pipefail
umask 077
python3 - '${AURORA_HOST}' '${AURORA_PORT}' '${AURORA_DB}' '${AURORA_OWNER_USER}' \
         '${REMOTE_WORK}' '${CRED_SOURCE}' '${SECRET_NAME}' '${AWS_REGION}' <<'PYEOF'
import hashlib, json, os, subprocess, sys

host, port, db, owner, work, source, secret_name, region = sys.argv[1:9]

def fingerprint(value):
    return hashlib.sha256(value.encode()).hexdigest()[:16]

def write_600(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as fh:
        fh.write(text)

secrets = {}
try:
    raw = subprocess.check_output([
        'aws', 'secretsmanager', 'get-secret-value',
        '--secret-id', secret_name, '--region', region,
        '--query', 'SecretString', '--output', 'text',
    ], stderr=subprocess.DEVNULL)
    secrets = json.loads(raw)
except Exception:
    pass

if source == 'env':
    creds = os.path.join(work, 'creds')
    with open(creds) as fh:
        owner_pw = fh.readline().rstrip('\n')
        app_pw = fh.readline().rstrip('\n')
    os.remove(creds)
elif secrets:
    owner_pw = secrets['POSTGRES_PASSWORD']
    app_pw = secrets['POD_APP_PASSWORD']
else:
    sys.exit('cannot read Secrets Manager and no passwords were supplied in the environment')

# pgpass fields are colon separated, so a colon or a backslash inside a
# password has to be escaped or psql reads the line as a different host and
# silently supplies no password at all. Backslashes first, or the escapes
# introduced for the colons get escaped a second time.
def pgpass_escape(value):
    return value.replace('\\\\', '\\\\\\\\').replace(':', '\\\\:')

write_600(os.path.join(work, 'pgpass'), '\n'.join([
    ':'.join([host, port, db, owner, pgpass_escape(owner_pw)]),
    ':'.join([host, port, db, 'pod_app', pgpass_escape(app_pw)]),
    ':'.join([host, port, 'postgres', owner, pgpass_escape(owner_pw)]),
]) + '\n')

# docker --env-file, so the owner URL reaches the migration runner without
# being an argument to docker. Values run to end of line, no quoting rules.
write_600(os.path.join(work, 'migrate.env'), ''.join([
    'NODE_ENV=production\n',
    'DATABASE_URL=postgres://', owner, ':', owner_pw, '@', host, ':', port, '/', db, '\n',
]))

# CREATE ROLE carries the password in its statement text, so it goes into a
# 0600 file rather than onto a command line. It is still visible to the server,
# which means it would reach the Aurora log if log_statement were set to ddl or
# all. The default parameter group leaves it at none. Worth knowing before
# turning statement logging on around a cutover.
#
# The dollar-quote tag is long on purpose: a password containing the tag would
# end the block early, and this one will not occur by accident.
write_600(os.path.join(work, 'create-role.sql'), ''.join([
    "DO \$aurora_migrate_role\$\n",
    "BEGIN\n",
    "  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pod_app') THEN\n",
    "    CREATE ROLE pod_app LOGIN PASSWORD '", app_pw.replace("'", "''"), "';\n",
    "    RAISE NOTICE 'created role pod_app';\n",
    "  ELSE\n",
    "    RAISE NOTICE 'role pod_app already exists, left alone';\n",
    "  END IF;\n",
    "END\n",
    "\$aurora_migrate_role\$;\n",
]))

print('FP_OWNER ' + fingerprint(owner_pw))
print('FP_APP ' + fingerprint(app_pw))
if secrets:
    print('FP_SM_OWNER ' + fingerprint(secrets.get('POSTGRES_PASSWORD', '')))
    print('FP_SM_APP ' + fingerprint(secrets.get('POD_APP_PASSWORD', '')))
PYEOF
EOF
)"

fp_of() { printf '%s\n' "$FINGERPRINTS" | awk -v k="$1" '$1 == k { print $2 }'; }
FP_OWNER="$(fp_of FP_OWNER)"
FP_APP="$(fp_of FP_APP)"
FP_SM_OWNER="$(fp_of FP_SM_OWNER)"
FP_SM_APP="$(fp_of FP_SM_APP)"

info "owner password fingerprint    ${FP_OWNER}"
info "pod_app password fingerprint  ${FP_APP}"

# Not pedantry. deploy.sh renders DATABASE_URL from the Secrets Manager
# POD_APP_PASSWORD, so a pod_app created here with any other password produces
# a cluster that passes every check below and then refuses every connection the
# API makes, thirty seconds after cutover, with the old database already
# behind us.
if [ -z "$FP_SM_OWNER" ]; then
  warn "could not read Secrets Manager entry ${SECRET_NAME}, so these cannot be confirmed as the passwords deploy.sh will render"
else
  if [ "$FP_OWNER" = "$FP_SM_OWNER" ]; then
    pass "owner password matches POSTGRES_PASSWORD in ${SECRET_NAME}"
  elif [ "${AURORA_ALLOW_PASSWORD_MISMATCH:-0}" = "1" ]; then
    warn "owner password differs from POSTGRES_PASSWORD in ${SECRET_NAME}, accepted via AURORA_ALLOW_PASSWORD_MISMATCH=1"
  else
    die "the owner password does not match POSTGRES_PASSWORD in ${SECRET_NAME} (${FP_OWNER} against ${FP_SM_OWNER}).
    terraform sets the Aurora master password from that key and deploy.sh renders DATABASE_OWNER_URL from it,
    so a different value here means migrations run against a cluster the next deploy cannot log into.
    Use AURORA_ALLOW_PASSWORD_MISMATCH=1 only for a throwaway rehearsal cluster."
  fi
  if [ "$FP_APP" = "$FP_SM_APP" ]; then
    pass "pod_app password matches POD_APP_PASSWORD in ${SECRET_NAME}"
  elif [ "${AURORA_ALLOW_PASSWORD_MISMATCH:-0}" = "1" ]; then
    warn "pod_app password differs from POD_APP_PASSWORD in ${SECRET_NAME}, accepted via AURORA_ALLOW_PASSWORD_MISMATCH=1"
  else
    die "the pod_app password does not match POD_APP_PASSWORD in ${SECRET_NAME} (${FP_APP} against ${FP_SM_APP}).
    deploy.sh renders DATABASE_URL from that key. A pod_app created with any other password gives you a cluster
    that passes every check in this script and refuses every connection the API makes after cutover."
  fi
fi

# Command fragments, built once. The pgpass directory is mounted read only and
# reached through PGPASSFILE, so no password is ever an argument to psql,
# pg_restore or docker.
DST_RUN="docker run -i --rm -v ${REMOTE_WORK}:/w:ro -e PGPASSFILE=/w/pgpass -e PGSSLMODE=${AURORA_SSLMODE} -e PGCONNECT_TIMEOUT=20 ${PG_IMAGE}"
DST_PSQL="${DST_RUN} psql -h ${AURORA_HOST} -p ${AURORA_PORT} -U ${AURORA_OWNER_USER} -d ${AURORA_DB} -v ON_ERROR_STOP=1"
DST_PSQL_APP="${DST_RUN} psql -h ${AURORA_HOST} -p ${AURORA_PORT} -U pod_app -d ${AURORA_DB}"
SRC_PSQL="docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on' ${SRC_CONTAINER} psql -U ${SRC_OWNER} -d ${SRC_DB} -v ON_ERROR_STOP=1"

step "Aurora reachable"
DST_PROBE="$(remote 2>&1 <<EOF || true
set -euo pipefail
${DST_PSQL} -tA -F'|' -c "SELECT current_setting('server_version'), current_user, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user), has_schema_privilege(current_user, 'public', 'CREATE'), current_database()"
EOF
)"
case "$DST_PROBE" in
  *"|"*) : ;;
  *)
    die "the Aurora writer endpoint did not answer as ${AURORA_OWNER_USER}:

      ${DST_PROBE}

    Worth checking, in the order these are usually wrong:
      the cluster security group admits the API host's security group on ${AURORA_PORT}
      the database '${AURORA_DB}' exists (module database, var.database_name)
      the master username is '${AURORA_OWNER_USER}' (var.master_username)
      the master password matches POSTGRES_PASSWORD in ${SECRET_NAME}" ;;
esac

DST_VERSION="$(printf '%s' "$DST_PROBE" | cut -d'|' -f1)"
DST_USER="$(printf '%s' "$DST_PROBE" | cut -d'|' -f2)"
DST_SUPER="$(printf '%s' "$DST_PROBE" | cut -d'|' -f3)"
DST_CANCREATE="$(printf '%s' "$DST_PROBE" | cut -d'|' -f4)"
pass "Aurora is PostgreSQL ${DST_VERSION}, connected as ${DST_USER}"

if [ "${SRC_VERSION%%.*}" = "${DST_VERSION%%.*}" ]; then
  if [ "$SRC_VERSION" = "$DST_VERSION" ]; then
    pass "server versions are identical (${SRC_VERSION})"
  else
    warn "minor version differs: source ${SRC_VERSION}, Aurora ${DST_VERSION}. Same major, so the row checksums stay comparable."
  fi
else
  fail "major version differs: source ${SRC_VERSION}, Aurora ${DST_VERSION}. Row text rendering is not comparable across majors, so the checksums below prove nothing."
fi

# Stated out loud because it is the constraint that shapes everything after it.
# Aurora's master user is a member of rds_superuser and is not a superuser, so
# anything in a normal Postgres migration path that quietly assumes superuser
# has to be found here rather than discovered mid-cutover.
if [ "$DST_SUPER" = "f" ]; then
  info "master user is NOT a superuser (rolsuper=f), as expected on Aurora. Every step below is owner-level only."
else
  info "master user reports rolsuper=${DST_SUPER}"
fi

# PostgreSQL 15 stopped granting CREATE on schema public to PUBLIC, so this is
# only true if the master user owns the database or was granted it. It is the
# first thing migrations need, and when it is missing the error lands on CREATE
# TABLE rather than on connect, which sends people looking at the wrong thing.
if [ "$DST_CANCREATE" = "t" ]; then
  pass "owner can CREATE in schema public"
else
  die "the connected user cannot CREATE in schema public on Aurora, so migrations cannot run.
    Since PostgreSQL 15, CREATE on public is no longer granted to PUBLIC.
    Either  GRANT CREATE ON SCHEMA public TO ${AURORA_OWNER_USER};
    or make sure database '${AURORA_DB}' was created with ${AURORA_OWNER_USER} as its owner."
fi

# ---------------------------------------------------------------------------
# 2. THE pod_app ROLE
#
# infra/init-db/01-create-app-role.sh creates this role, and it will never run
# against Aurora. It is a docker-entrypoint-initdb.d hook, which the Postgres
# image executes exactly once, on the first initialisation of an empty data
# directory. Aurora has neither the hook nor the data directory.
#
# The role has to exist before the migrations run, or migration 0003 finds no
# pod_app, takes its no-op branch, and produces a database with the right
# schema, the right rows, and no append-only posture at all. 0003 is written to
# skip silently because a reviewer running the stack locally should not need
# the role. That is right for a quick start and exactly wrong here, which is
# why this phase comes first.
#
# On the superuser question: CREATE ROLE needs the CREATEROLE attribute, not
# superuser, and rds_superuser carries it. The GRANT statements inside the
# migrations are issued by the table owner, and an owner may always grant on
# what it owns. Neither needs anything Aurora withholds. The one thing in this
# whole path that does need real superuser is pg_dump --disable-triggers, and
# phase 4 is built so as not to want it.
# ---------------------------------------------------------------------------
if [ "$VERIFY_ONLY" -eq 0 ]; then
  banner "2. Creating the pod_app role on Aurora"
  remote <<EOF || die "could not create the pod_app role"
set -euo pipefail
${DST_PSQL} -f /w/create-role.sql
EOF
  # Prove the role can log in with the password that was set, rather than
  # trusting CREATE ROLE to have done what it was asked. A role that exists and
  # rejects its own password fails at cutover, not here, and by then the
  # interesting logs are on the other side of a deploy.
  APP_LOGIN="$(remote 2>&1 <<EOF || true
set -euo pipefail
${DST_PSQL_APP} -tAc 'SELECT current_user' 2>&1
EOF
)"
  if [ "$APP_LOGIN" = "pod_app" ]; then
    pass "pod_app exists and can log in with the password deploy.sh will render into DATABASE_URL"
  else
    fail "pod_app could not log in: ${APP_LOGIN}"
  fi
else
  banner "2. Creating the pod_app role on Aurora (skipped: --verify-only)"
fi

# ---------------------------------------------------------------------------
# 3. MIGRATIONS
#
# The schema is not hand written and not dumped. It is produced by running the
# same TypeORM migrations from zero, out of the same image the API runs, with
# DATABASE_URL overridden to the owner URL. That is what deploy.sh does, and
# any other way produces a schema that is correct today and diverges the first
# time somebody adds a migration.
#
# Running from zero is also what recreates the append-only grants, because
# migrations 0003, 0005, 0006 and 0011 are where they live. No grant in this
# script is copied or re-applied by hand.
#
# docker run rather than docker compose run is the one place this deliberately
# differs from deploy.sh, for two reasons that are both about safety.
#
# compose run has no way to be handed a connection string that is not either an
# argument to docker or already in the ambient environment. docker run takes
# --env-file, so the owner URL is read from a 0600 file and never appears in ps
# on a box that other things run on.
#
# And a plain docker run lands on the default bridge network, where the
# hostname 'postgres' does not resolve. If the URL in that env file were
# somehow still pointing at the co-located container, this fails to connect
# rather than quietly migrating the database we are migrating away from.
# compose run would have resolved it and succeeded.
# ---------------------------------------------------------------------------
MIGRATE_OUTPUT=""
if [ "$SKIP_MIGRATE" -eq 0 ]; then
  banner "3. Running migrations against Aurora, from zero"
  MIGRATE_OUTPUT="$(remote 2>&1 <<EOF || true
set -euo pipefail
docker run --rm --env-file ${REMOTE_WORK}/migrate.env ${APP_IMAGE} node dist/database/migrate.js 2>&1
EOF
)"
  printf '%s\n' "$MIGRATE_OUTPUT" | sed 's/^/      /'
  case "$MIGRATE_OUTPUT" in
    *"applied:"*|*"no pending migrations"*) pass "migration runner completed" ;;
    *) fail "the migration runner did not report success, see its output above" ;;
  esac
else
  banner "3. Running migrations against Aurora (skipped)"
fi

# ---------------------------------------------------------------------------
# 4. THE DATA
#
# On --disable-triggers, which is the obvious answer and the wrong one here.
#
# pg_dump --data-only --disable-triggers emits ALTER TABLE ... DISABLE TRIGGER
# ALL around each table. Foreign keys are enforced by internal system triggers,
# and disabling a system trigger requires a real superuser. Aurora's master is
# rds_superuser, which is not one, so that restore fails with "permission
# denied: RI_ConstraintTrigger_... is a system trigger". The first probe below
# runs that exact statement against the live cluster and prints what it says,
# so this is demonstrated rather than asserted.
#
# The RDS-sanctioned equivalent is session_replication_role = replica, which
# rds_superuser is normally permitted to set and which also skips foreign key
# triggers. The second probe reports whether this cluster allows it. It is not
# used, and the reason is not that it would fail. It turns referential
# integrity off for the duration of the load, so a source that was already
# inconsistent, or a load that dropped a parent row, arrives looking perfect.
# The entire point of this exercise is being able to say the copy is faithful,
# and a check switched off during the copy is a check not performed.
#
# Deferring instead does not work either, and not for a reason of privilege:
# SET CONSTRAINTS ALL DEFERRED affects only constraints declared DEFERRABLE,
# and none of the six foreign keys in this schema are.
#
# So: load in dependency order, every constraint enforced, needing no privilege
# beyond ownership. Parents before children, so no check ever looks for a row
# that has not arrived. The load is then itself a referential integrity test of
# the source data, which is a check gained rather than a check waived.
#
# One dump, custom format, so all twelve tables come from a single snapshot and
# cannot disagree with each other even if the API writes mid-copy.
#
# pg_restore is then invoked once per table, and that is not busywork. Given
# several -t flags in one invocation, pg_restore restores in the archive's own
# table-of-contents order and ignores the order the flags were written in
# entirely. So the load order would be pg_dump's, not ours. pg_dump's order
# happens to be dependency-safe for this schema today, but nothing promises
# that: a normal restore creates foreign keys after all the data, so pg_dump
# has no reason to order data entries for a schema that already has them.
# Relying on it would mean relying on an accident that a future table could
# quietly end. One invocation per table makes the order ours, explicit, and
# the same order the comment above describes.
#
# migrations is excluded at dump time. Phase 3 rebuilds it, its id is the only
# serial in the schema, and copying it over what the runner wrote would
# duplicate every row and leave the sequence behind the data.
#
# TRUNCATE is what makes a re-run safe, and it only ever touches Aurora. All
# twelve tables are named in one statement, deliberately without CASCADE: every
# table that references them is already in the list, so if a future migration
# adds a thirteenth that references one of these, the TRUNCATE fails loudly
# instead of silently emptying that one too.
# ---------------------------------------------------------------------------
if [ "$SKIP_COPY" -eq 0 ]; then
  banner "4. Copying data into Aurora"

  step "what Aurora says about switching foreign keys off"
  TRIGGER_PROBE="$(remote 2>&1 <<EOF || true
set -euo pipefail
${DST_PSQL} -f - <<'SQL' 2>&1 || true
BEGIN;
ALTER TABLE delivery_attempts DISABLE TRIGGER ALL;
ROLLBACK;
SQL
EOF
)"
  case "$TRIGGER_PROBE" in
    *"permission denied"*|*"must be superuser"*|*"is a system trigger"*)
      pass "ALTER TABLE ... DISABLE TRIGGER ALL is refused, which is why --disable-triggers is not used" ;;
    *)
      info "DISABLE TRIGGER ALL was not refused on this cluster. Dependency-ordered loading is used regardless." ;;
  esac
  info "$(printf '%s' "$TRIGGER_PROBE" | grep -i 'error' | head -1 || printf 'no error reported')"

  step "whether rds_superuser may set session_replication_role"
  SRR_PROBE="$(remote 2>&1 <<EOF || true
set -euo pipefail
${DST_PSQL} -f - <<'SQL' 2>&1 || true
BEGIN;
SET LOCAL session_replication_role = 'replica';
SELECT current_setting('session_replication_role');
ROLLBACK;
SQL
EOF
)"
  case "$SRR_PROBE" in
    *replica*) info "permitted. Recorded as the escape hatch if a circular foreign key ever makes ordering impossible. Not used here." ;;
    *)         info "not permitted on this cluster, so dependency ordering is the only workable approach, which is the one used." ;;
  esac

  step "dumping, data only, single snapshot, source untouched"
  remote <<EOF || die "pg_dump failed against the source"
set -euo pipefail
umask 077
docker exec -e PGOPTIONS='-c default_transaction_read_only=on' ${SRC_CONTAINER} \
  pg_dump -U ${SRC_OWNER} -d ${SRC_DB} \
    --data-only --format=custom \
    --no-owner --no-privileges --no-comments \
    --exclude-table=public.migrations \
  > ${REMOTE_WORK}/pod-data.dump
chmod 600 ${REMOTE_WORK}/pod-data.dump
ls -l ${REMOTE_WORK}/pod-data.dump | awk '{ print "      dump is " \$5 " bytes" }'
EOF
  pass "dump taken from one snapshot, migrations excluded, nothing written to the source"

  step "emptying the target, then loading parents before children"
  remote <<EOF || die "the load failed. Aurora is now partly loaded; the source is untouched.
    Fix the cause and re-run. The truncate at the start of the load makes that safe while the
    container is still the database of record, which preflight has already confirmed. It stops
    being safe the moment the app is cut over, which is why preflight refuses to get this far."
set -euo pipefail
# Every docker run here carries -i, and this whole block reaches the remote
# shell as its stdin. A container with stdin attached therefore reads the rest
# of this script as input and consumes it. Without the redirects below, the
# TRUNCATE swallowed the loop that was supposed to repopulate the tables it had
# just emptied, the shell hit end of input, and it all exited 0. The outer pass
# then reported "12 tables loaded" over an empty database. The missing
# "target truncated" and "loaded ..." lines were the only visible symptom.
${DST_PSQL} -q -c "TRUNCATE TABLE ai_summaries, attempt_photos, refresh_tokens, delivery_attempts, erasure_log, backfill_progress, ai_summary_cache, pods, stops, office_users, devices, drivers;" < /dev/null
echo "      target truncated"
LOADED=0
for t in ${TABLE_ORDER}; do
  ${DST_RUN} pg_restore \
    -h ${AURORA_HOST} -p ${AURORA_PORT} -U ${AURORA_OWNER_USER} -d ${AURORA_DB} \
    --data-only --no-owner --no-privileges --single-transaction \
    --schema=public --table="\$t" /w/pod-data.dump < /dev/null
  LOADED=\$((LOADED + 1))
  echo "      loaded \$t"
done
# The loop reporting fewer tables than it was given is the signature of the bug
# above coming back. Fail here rather than let verification describe it as a
# copy that lost rows.
[ "\$LOADED" -eq ${TABLE_COUNT} ] || { echo "      only \$LOADED of ${TABLE_COUNT} tables were loaded"; exit 1; }
EOF
  pass "${TABLE_COUNT} tables loaded in dependency order with every foreign key enforced throughout"

  # A freshly loaded Aurora has no statistics at all, so the planner falls back
  # on its defaults and picks sequential scans over the indexes the migrations
  # just built. At this row count nothing would look broken, which is exactly
  # why it would go unnoticed until the table has grown enough to hurt.
  step "ANALYZE, target only"
  remote <<EOF || warn "ANALYZE did not complete. Run it before serving traffic from Aurora."
set -euo pipefail
${DST_PSQL} -q -c 'ANALYZE;'
EOF
  pass "statistics gathered on Aurora"
else
  banner "4. Copying data into Aurora (skipped)"
fi

# ---------------------------------------------------------------------------
# 5. VERIFICATION
# ---------------------------------------------------------------------------
banner "5. Verification"

step "collecting the same evidence from both databases"
remote > "$LOCAL_WORK/src.txt" <<EOF || die "the verification query failed against the source"
set -euo pipefail
${SRC_PSQL} -tA -F'|' -f - < ${REMOTE_WORK}/verify.sql
EOF
remote > "$LOCAL_WORK/dst.txt" <<EOF || die "the verification query failed against Aurora"
set -euo pipefail
${DST_PSQL} -tA -F'|' -f /w/verify.sql
EOF
info "source $(grep -c . "$LOCAL_WORK/src.txt" || true) records, aurora $(grep -c . "$LOCAL_WORK/dst.txt" || true) records, from the same file"

sect()  { grep "^$1|" "$2" 2>/dev/null || true; }
field() { printf '%s\n' "$1" | awk -F'|' -v t="$2" -v n="$3" '$2 == t { print $n }'; }

# The source counts recorded when this script was written. They are here so a
# source that has moved says so, rather than the report comparing a changed
# source against a faithful copy of it and calling that a pass.
expected_rows() {
  case "$1" in
    stops)             echo 8320 ;;
    delivery_attempts) echo 134 ;;
    attempt_photos)    echo 5 ;;
    pods)              echo 3151 ;;
    drivers)           echo 41 ;;
    refresh_tokens)    echo 372 ;;
    devices)           echo 132 ;;
    ai_summary_cache)  echo 22 ;;
    ai_summaries)      echo 13 ;;
    erasure_log)       echo 1 ;;
    office_users)      echo 1 ;;
    backfill_progress) echo 0 ;;
    migrations)        echo 12 ;;
    *)                 echo "" ;;
  esac
}

SRC_COUNTS="$(sect COUNT "$LOCAL_WORK/src.txt")"
DST_COUNTS="$(sect COUNT "$LOCAL_WORK/dst.txt")"
SRC_CKSUMS="$(sect CKSUM "$LOCAL_WORK/src.txt")"
DST_CKSUMS="$(sect CKSUM "$LOCAL_WORK/dst.txt")"

# --- table inventory -------------------------------------------------------
step "table inventory"
for side in src dst; do
  found="$(sect TABLE "$LOCAL_WORK/${side}.txt" | cut -d'|' -f2 | sort | tr '\n' ' ' | sed 's/ $//')"
  if [ "$found" = "$ALL_TABLES_SORTED" ]; then
    pass "${side}: the 13 known tables and nothing else"
  else
    fail "${side}: the table inventory is not what this script copies.
        expected: ${ALL_TABLES_SORTED}
        found:    ${found}
        A table this script does not know about is a table it does not copy."
  fi
done

# --- row counts ------------------------------------------------------------
step "row counts, both sides, every table"
printf '      %-20s %9s %9s %9s   %s\n' "table" "expected" "source" "aurora" "result"
printf '      %-20s %9s %9s %9s   %s\n' "--------------------" "--------" "--------" "--------" "------"
DRIFTED=""
TOTAL_COPIED=0
for t in $ALL_TABLES_SORTED; do
  s="$(field "$SRC_COUNTS" "$t" 3)"; [ -n "$s" ] || s="-"
  d="$(field "$DST_COUNTS" "$t" 3)"; [ -n "$d" ] || d="-"
  e="$(expected_rows "$t")";         [ -n "$e" ] || e="-"

  if [ "$t" = "migrations" ]; then
    # The one table allowed to differ. It is rebuilt by the migration runner
    # rather than copied, and the repo can legitimately be ahead of the live
    # database. Compared by name a few checks below instead.
    result="n/a"
  elif [ "$s" = "-" ] || [ "$d" = "-" ]; then
    result="FAIL"
    fail_quiet "no row count came back for ${t} (source '${s}', aurora '${d}')"
  elif [ "$s" = "$d" ]; then
    result="PASS"
    CHECKS_PASS=$((CHECKS_PASS + 1))
    TOTAL_COPIED=$((TOTAL_COPIED + s))
  else
    result="FAIL"
    fail_quiet "row count mismatch on ${t}: source ${s}, aurora ${d}"
  fi

  if [ "$t" != "migrations" ] && [ "$e" != "-" ] && [ "$s" != "$e" ]; then
    DRIFTED="${DRIFTED}${t} "
  fi
  printf '      %-20s %9s %9s %9s   %s\n' "$t" "$e" "$s" "$d" "$result"
done
printf '\n'

if [ -n "$DRIFTED" ]; then
  warn "source counts have moved since these expectations were recorded: ${DRIFTED}
        That is drift in the SOURCE, not a fault in the copy. Normal if the API has been serving
        traffic through the run. Worth a second look if it has not."
else
  pass "every source table still holds the number of rows this script expects"
fi

# --- checksums -------------------------------------------------------------
step "content checksums, order independent, over every column of every row"
for t in $TABLE_ORDER; do
  s="$(field "$SRC_CKSUMS" "$t" 3)"
  d="$(field "$DST_CKSUMS" "$t" 3)"
  if [ -z "$s" ] || [ -z "$d" ]; then
    fail "no checksum came back for ${t} (source '${s}', aurora '${d}')"
  elif [ "$s" = "$d" ]; then
    pass "$(printf '%-20s %s' "$t" "$s")"
  else
    fail "$(printf '%-20s source %s  aurora %s  CONTENT DIFFERS' "$t" "$s" "$d")"
  fi
done

# --- schema shape ----------------------------------------------------------
step "schema shape"
if diff -u <(sect COLUMN "$LOCAL_WORK/src.txt") <(sect COLUMN "$LOCAL_WORK/dst.txt") > "$LOCAL_WORK/columns.diff"; then
  pass "columns: same names, same order, same types, same nullability on both sides"
else
  fail "column definitions differ, so the checksums above are not comparing like with like:"
  sed 's/^/        /' "$LOCAL_WORK/columns.diff" | head -40
fi

if diff -u <(sect CONSTRAINT "$LOCAL_WORK/src.txt") <(sect CONSTRAINT "$LOCAL_WORK/dst.txt") > "$LOCAL_WORK/constraints.diff"; then
  pass "constraints: every check, foreign key and unique arrived identically"
else
  warn "constraint definitions differ. Expected if the repo carries migrations the source has not run:"
  sed 's/^/        /' "$LOCAL_WORK/constraints.diff" | head -40
fi

# --- indexes ---------------------------------------------------------------
step "indexes"
INVALID="$(sect INDEX "$LOCAL_WORK/dst.txt" | awk -F'|' '$4 != "true" || $5 != "true" { print $2 }' | tr '\n' ' ')"
IDX_TOTAL="$(sect INDEX "$LOCAL_WORK/dst.txt" | grep -c . || true)"
if [ -z "$INVALID" ]; then
  pass "all ${IDX_TOTAL} indexes on Aurora report indisvalid and indisready true"
else
  fail "these indexes on Aurora are INVALID or not ready, so the planner silently ignores them: ${INVALID}
        A CREATE INDEX CONCURRENTLY that failed part way leaves exactly this: the index is present,
        nothing errored, and the query it was built for went back to a sequential scan."
fi

SRC_IDX="$(sect INDEX "$LOCAL_WORK/src.txt" | cut -d'|' -f2 | sort)"
DST_IDX="$(sect INDEX "$LOCAL_WORK/dst.txt" | cut -d'|' -f2 | sort)"
MISSING_IDX="$(comm -23 <(printf '%s\n' "$SRC_IDX") <(printf '%s\n' "$DST_IDX") | grep . | tr '\n' ' ' || true)"
EXTRA_IDX="$(comm -13 <(printf '%s\n' "$SRC_IDX") <(printf '%s\n' "$DST_IDX") | grep . | tr '\n' ' ' || true)"
# Drift runs both ways, because the repo's own migrations delete indexes as well
# as create them. The source stopped at migration 12; Aurora runs all of them,
# and 13 and 14 drop these two on purpose:
#
#   1755000000013-AttemptsReceivedTieOrder  drops idx_attempts_received, replaced
#     by a (received_at DESC, id DESC) index whose tie order matches the keyset
#     cursor, which is what removed the Incremental Sort.
#   1755000000014-DropPendingMediaIndex     drops idx_attempts_pending_media,
#     an orphan no query referenced.
#
# So their absence on Aurora is the migrations working. Treating it as a hard
# failure made a correct copy report FAIL, and the printed advice on failure was
# to re-run, which is the one thing that must not happen after cutover.
INTENTIONALLY_DROPPED="idx_attempts_received idx_attempts_pending_media"
EXPECTED_GONE=""
for i in $MISSING_IDX; do
  case " $INTENTIONALLY_DROPPED " in
    *" $i "*) EXPECTED_GONE="${EXPECTED_GONE}${i} " ;;
    *)        REAL_MISSING="${REAL_MISSING:-}${i} " ;;
  esac
done
MISSING_IDX="${REAL_MISSING:-}"
if [ -n "$EXPECTED_GONE" ]; then
  info "absent from Aurora because a later migration drops them, which is correct: ${EXPECTED_GONE}"
fi

if [ -z "$MISSING_IDX" ] && [ -z "$EXTRA_IDX" ]; then
  pass "both databases carry the same set of indexes, allowing for the ones later migrations drop"
else
  if [ -n "$MISSING_IDX" ]; then
    fail "indexes on the source that are missing from Aurora: ${MISSING_IDX}"
  fi
  if [ -n "$EXTRA_IDX" ]; then
    warn "indexes on Aurora that the source does not have: ${EXTRA_IDX}
        Expected when the repo carries index migrations the live database has not run yet."
  fi
fi

# --- sequences -------------------------------------------------------------
step "sequences"
DST_SEQ="$(sect SEQUENCE "$LOCAL_WORK/dst.txt" | cut -d'|' -f2 | sort | tr '\n' ' ' | sed 's/ $//')"
if [ "$DST_SEQ" = "migrations_id_seq" ] || [ -z "$DST_SEQ" ]; then
  pass "nothing needs resynchronising after a data-only copy: every business key is a uuid"
else
  fail "sequences other than migrations_id_seq exist: ${DST_SEQ}
        A data-only copy leaves them at 1 while the copied rows already hold higher values, so the
        first insert after cutover collides. This script has no setval step and now needs one."
fi

# --- migrations ------------------------------------------------------------
step "migrations"
SRC_MIG="$(sect MIGRATION "$LOCAL_WORK/src.txt" | cut -d'|' -f3 | sort)"
DST_MIG="$(sect MIGRATION "$LOCAL_WORK/dst.txt" | cut -d'|' -f3 | sort)"
SRC_MIG_N="$(printf '%s\n' "$SRC_MIG" | grep -c . || true)"
DST_MIG_N="$(printf '%s\n' "$DST_MIG" | grep -c . || true)"
FILE_MIG_N=0
for migration_file in ../backend/src/database/migrations/*.ts; do
  if [ -f "$migration_file" ]; then
    FILE_MIG_N=$((FILE_MIG_N + 1))
  fi
done

# A fixed number is the wrong assertion here, and the reason is worth keeping.
#
# The survey taken before this move recorded 12 rows in the live migrations
# table while the repo held 15 files: three index migrations were committed but
# had never been deployed. The next deploy ran them, so the source is now at 15
# and the gap is closed. Pinning 12, or pinning 15, would each have been right
# for about half a day.
#
# The durable assertions are that Aurora is missing nothing the source has, and
# that its count matches the number of migrations there were to run. Note that
# FILE_MIG_N counts this checkout, while what actually ran came from the image
# on the instance, so a stale image shows up here as a mismatch rather than
# being silently accepted. EXPECTED_MIGRATIONS pins an exact figure when a run
# needs to be stricter than that.
EXPECTED_MIGRATIONS="${EXPECTED_MIGRATIONS:-$FILE_MIG_N}"
info "migration files in this checkout ${FILE_MIG_N}  |  applied on source ${SRC_MIG_N}  |  applied on Aurora ${DST_MIG_N}"

if [ "$DST_MIG_N" = "$EXPECTED_MIGRATIONS" ]; then
  pass "Aurora's migrations table holds ${DST_MIG_N} rows, matching the ${EXPECTED_MIGRATIONS} expected"
else
  fail "Aurora's migrations table holds ${DST_MIG_N} rows, expected ${EXPECTED_MIGRATIONS}.
        Every migration file in ${APP_IMAGE} is applied from zero, so set EXPECTED_MIGRATIONS if the
        repo has legitimately moved on."
fi

MISSING_MIG="$(comm -23 <(printf '%s\n' "$SRC_MIG") <(printf '%s\n' "$DST_MIG") | grep . | tr '\n' ' ' || true)"
if [ -z "$MISSING_MIG" ]; then
  pass "every migration applied on the source is applied on Aurora"
else
  fail "Aurora is missing migrations the source has already run: ${MISSING_MIG}"
fi

if [ "$SRC_MIG_N" != "$DST_MIG_N" ]; then
  info "Aurora is ahead by: $(comm -13 <(printf '%s\n' "$SRC_MIG") <(printf '%s\n' "$DST_MIG") | grep . | tr '\n' ' ' || true)"
  info "Deploy that same code at cutover, or the app runs against a schema its image does not know about."
fi

# --- the append-only posture, from the catalog -----------------------------
step "append-only posture, read from the catalog on both sides"
if diff -u <(sect GRANT "$LOCAL_WORK/src.txt") <(sect GRANT "$LOCAL_WORK/dst.txt") > "$LOCAL_WORK/grants.diff"; then
  pass "pod_app has exactly the privileges on Aurora that it has on the source, table by table and column by column"
else
  fail "the pod_app privilege matrix differs between the two databases:"
  sed 's/^/        /' "$LOCAL_WORK/grants.diff" | head -40
  info "If pod_app has NO privileges at all on Aurora, the cause is ordering: migrations 0003, 0005,"
  info "0006 and 0011 skip their GRANT block when the role is absent, and are then recorded as"
  info "applied and never run again. Re-apply them on Aurora with:"
  info "    DELETE FROM migrations WHERE name LIKE 'AppendOnlyGrants%' OR name LIKE 'SignatureDeclaredSize%'"
  info "                              OR name LIKE 'DriverEmail%' OR name LIKE 'ExpectedBarcodeAndErasureLog%';"
  info "then re-run this script, which creates the role before it migrates."
fi

DST_GRANTS="$(sect GRANT "$LOCAL_WORK/dst.txt")"
CAN_DELETE="$(printf '%s\n' "$DST_GRANTS" | awk -F'|' '$6 == "1" { print $2 }' | tr '\n' ' ')"
if [ -z "$CAN_DELETE" ]; then
  pass "pod_app holds DELETE on no table anywhere in the database"
else
  fail "pod_app can DELETE from: ${CAN_DELETE}"
fi

check_evidence_table() {
  local tbl="$1" want_cols="$2" row sel ins upd del anycol cols
  row="$(printf '%s\n' "$DST_GRANTS" | awk -F'|' -v t="$tbl" '$2 == t')"
  sel="$(printf '%s' "$row" | cut -d'|' -f3)"
  ins="$(printf '%s' "$row" | cut -d'|' -f4)"
  upd="$(printf '%s' "$row" | cut -d'|' -f5)"
  del="$(printf '%s' "$row" | cut -d'|' -f6)"
  anycol="$(printf '%s' "$row" | cut -d'|' -f8)"
  cols="$(printf '%s' "$row" | cut -d'|' -f9)"

  if [ "$sel" = "1" ] && [ "$ins" = "1" ] && [ "$upd" = "0" ] && [ "$del" = "0" ]; then
    pass "${tbl}: SELECT and INSERT at table level, no table-level UPDATE, no DELETE"
  else
    fail "${tbl}: expected select=1 insert=1 update=0 delete=0, got select=${sel} insert=${ins} update=${upd} delete=${del}"
  fi
  if [ "$anycol" = "1" ] && [ "$cols" = "$want_cols" ]; then
    pass "${tbl}: updatable columns are exactly ${cols}"
  else
    fail "${tbl}: updatable columns are '${cols}', expected '${want_cols}'"
  fi
}
check_evidence_table delivery_attempts "evidence_status,signature_declared_size_bytes,signature_size_bytes,signature_verified_at,updated_at"
check_evidence_table attempt_photos "etag,size_bytes,status,verified_at"

# --- the append-only posture, proved by trying it --------------------------
#
# The catalog says what pod_app may do. This says what the database actually
# does when pod_app tries it, which is the claim that matters and the only one
# a reviewer has to take nobody's word for.
#
# Every probe runs inside BEGIN ... ROLLBACK. For the ones expected to be
# refused that is belt and braces: if a grant had somehow crept in and the
# DELETE succeeded, the transaction still rolls back and no evidence row is
# lost. These checks are written so that success is the failure.
step "append-only posture, proved against the live cluster as pod_app"

probe() {
  local label="$1" sql="$2" want="$3" out err
  out="$(remote 2>&1 <<EOF || true
set -euo pipefail
${DST_PSQL_APP} -v ON_ERROR_STOP=1 -f - <<'SQL' 2>&1 || true
BEGIN;
${sql}
ROLLBACK;
SQL
EOF
)"
  err="$(printf '%s' "$out" | grep -i 'ERROR' | head -1 || true)"
  case "$want" in
    denied)
      # Match the specific Postgres error, not the words "permission denied"
      # anywhere in combined output. A docker or ssh permission problem prints
      # that phrase too, and would have been reported here as proof that the
      # database refused a DELETE it never actually saw. This is the single
      # most important claim the script makes, so it gets the narrow pattern.
      case "$out" in
        *"permission denied for table"*|*"permission denied for relation"*)
          pass "refused: ${label}"
          info "${err}" ;;
        *"permission denied"*)
          fail "${label} produced a 'permission denied' that did not come from the table.
        This is most likely ssh or docker, not the grants, so it proves nothing about
        the append-only posture. Full output: ${out}" ;;
        *)
          fail "NOT refused: ${label}. The append-only guarantee is not in force on Aurora."
          info "$(printf '%s' "$out" | head -3 | tr '\n' ' ')" ;;
      esac ;;
    allowed)
      case "$out" in
        *"permission denied"*)
          fail "refused, but pod_app is supposed to be able to do this: ${label}"
          info "${err}" ;;
        *UPDATE*)
          pass "allowed then rolled back: ${label}"
          info "$(printf '%s' "$out" | grep '^UPDATE' | head -1 || true)" ;;
        *)
          fail "neither refused nor an UPDATE tag: ${label}"
          info "$(printf '%s' "$out" | head -3 | tr '\n' ' ')" ;;
      esac ;;
  esac
}

probe "DELETE FROM delivery_attempts" \
      "DELETE FROM delivery_attempts;" denied
probe "UPDATE delivery_attempts SET outcome = 'refused'" \
      "UPDATE delivery_attempts SET outcome = 'refused';" denied
probe "DELETE FROM attempt_photos" \
      "DELETE FROM attempt_photos;" denied
probe "UPDATE attempt_photos SET s3_key = 'x'" \
      "UPDATE attempt_photos SET s3_key = 'x';" denied
probe "UPDATE delivery_attempts SET evidence_status, the one bookkeeping column that may move" \
      "UPDATE delivery_attempts SET evidence_status = 'complete' WHERE id = (SELECT id FROM delivery_attempts ORDER BY id LIMIT 1);" allowed

# The rollback is only a claim until the data is looked at again. Recomputing
# the delivery_attempts checksum after the probes and comparing it against the
# one taken before them is what proves the update that was allowed to run left
# nothing behind. Same expression as aurora-verify.sql, same pinned settings.
step "confirming the probes left no trace"
POST_CKSUM="$(remote <<EOF || true
set -euo pipefail
${DST_PSQL} -tAc "SET TimeZone='UTC'; SET DateStyle='ISO, MDY'; SET IntervalStyle='postgres'; SET extra_float_digits=3; SET bytea_output='hex'; SELECT coalesce(md5(string_agg(h,'' ORDER BY h)),'EMPTY') FROM (SELECT md5(x::text) AS h FROM delivery_attempts x) q"
EOF
)"
# psql prints a command tag for each statement, so the SETs that pin the output
# format contribute four lines of "SET" before the hash. Comparing the whole
# capture reported a table that had not moved as having changed, with the two
# identical hashes visible in the failure message. Only the last line is the
# result.
POST_CKSUM="$(printf '%s\n' "$POST_CKSUM" | tail -n 1)"
PRE_CKSUM="$(field "$DST_CKSUMS" delivery_attempts 3)"
if [ -n "$POST_CKSUM" ] && [ "$POST_CKSUM" = "$PRE_CKSUM" ]; then
  pass "delivery_attempts is byte for byte what it was before the probes ran (${POST_CKSUM})"
else
  fail "delivery_attempts changed across the probes: before ${PRE_CKSUM}, after ${POST_CKSUM}"
fi

# --- the two things outside the database that have to follow it ------------
step "things outside the database that move with it"

# The nightly demo roll used to name the container directly. Left that way it
# keeps succeeding, against the database nobody reads, while the demo logins
# open on an empty round the morning after cutover. Nothing errors, which is
# exactly why it is checked here rather than trusted.
ROLL_UNIT="$(remote 2>&1 <<'EOF' || true
set -euo pipefail
cat /etc/systemd/system/pod-demo-roll.service 2>/dev/null || echo "__NOT_INSTALLED__"
EOF
)"
# Strip comments, then look at what is left. Two different false readings live
# here and this is the one line that avoids both.
#
# Matching the whole file failed the CORRECT replacement unit, because that unit
# quotes the old docker exec command in a comment to explain what it replaced. A
# check that fails on well documented work teaches people to delete the
# documentation.
#
# Matching only lines starting with ExecStart= failed it the other way: that
# unit's ExecStart is four lines joined by backslashes, and DATABASE_OWNER_URL
# is on the last of them, so the correct unit read as "does not obviously read
# DATABASE_OWNER_URL".
ROLL_EXEC="$(printf '%s\n' "$ROLL_UNIT" | grep -vE '^[[:space:]]*#' || true)"
case "$ROLL_UNIT" in
  *__NOT_INSTALLED__*)
    warn "pod-demo-roll.service is not installed on the instance. infra/AURORA.md has the install line, and it should go in before the cutover." ;;
esac
case "${ROLL_EXEC:-none}" in
  none) : ;;
  *"docker exec"*"$SRC_CONTAINER"*)
    fail "pod-demo-roll.service still targets ${SRC_CONTAINER} directly.
        After cutover it keeps rolling the OLD database, silently, and the demo route on Aurora stops
        advancing. Install the unit from infra/systemd/, which reads DATABASE_OWNER_URL out of the
        deployed .env and therefore follows the app." ;;
  *DATABASE_OWNER_URL*)
    pass "pod-demo-roll.service reads DATABASE_OWNER_URL from .env, so it follows the cutover on its own" ;;
  *)
    warn "pod-demo-roll.service does not obviously read DATABASE_OWNER_URL. Check it by hand before cutover." ;;
esac

ENV_HOST="$(remote 2>&1 <<EOF || true
set -euo pipefail
sed -n 's|^DATABASE_URL=postgres://[^@]*@\([^:]*\):.*|\1|p' ${REMOTE_DIR}/.env 2>/dev/null || true
EOF
)"
if [ "$ENV_HOST" = "$AURORA_HOST" ]; then
  info "the deployed .env already points at Aurora, so the app is live on the cluster just verified"
elif [ -n "$ENV_HOST" ]; then
  info "the app is still on '${ENV_HOST}'. Cutover is a separate, deliberate step."
fi

# ---------------------------------------------------------------------------
# 6. SUMMARY
# ---------------------------------------------------------------------------
banner "6. Summary"
printf '\n'
printf '      source          PostgreSQL %s in %s on %s\n' "$SRC_VERSION" "$SRC_CONTAINER" "$HOST"
printf '      target          PostgreSQL %s at %s:%s/%s\n' "$DST_VERSION" "$AURORA_HOST" "$AURORA_PORT" "$AURORA_DB"
printf '      credentials     from %s (owner %s, pod_app %s)\n' "$CRED_SOURCE" "$FP_OWNER" "$FP_APP"
printf '      rows matched    %s across %s tables\n' "$TOTAL_COPIED" "$TABLE_COUNT"
printf '      migrations      %s applied on Aurora\n' "$DST_MIG_N"
printf '      checks          %s passed, %s failed, %s warnings\n' "$CHECKS_PASS" "$CHECKS_FAIL" "$CHECKS_WARN"
printf '      source          not written to at any point, enforced by the source server\n'
printf '\n'

if [ -n "$WARNINGS" ]; then
  printf '      WARNINGS\n%s\n' "$WARNINGS"
fi

if [ "$CHECKS_FAIL" -gt 0 ]; then
  printf '      FAILURES\n%s\n' "$FAILURES"
  printf '      RESULT: FAIL\n\n'
  printf '      Aurora is NOT ready to be cut over to. The container is untouched and still serving.\n'
  printf '      Nothing needs undoing. Fix the cause and re-run: the load truncates its target first.\n\n'
  exit 1
fi

printf '      RESULT: PASS\n\n'
printf '      Aurora holds the same rows as the container, with the same schema, the same indexes,\n'
printf '      and a pod_app role the database itself refuses to let delete or rewrite evidence.\n\n'
if [ "$VERIFY_ONLY" -eq 1 ]; then
  printf '      Read-only run. Nothing was changed on either side.\n\n'
else
  printf '      Cut over when ready:  cd infra && DB_HOST=%s ./deploy.sh\n' "$AURORA_HOST"
  printf '      Revert, one step:     cd infra && env -u DB_HOST ./deploy.sh\n'
  printf '      Leave the container running either way. It is the fallback.\n\n'
fi
