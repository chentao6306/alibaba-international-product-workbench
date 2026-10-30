#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run with sudo'; exit 1; }
cd "$(dirname "$0")/../.."
qa_root=$(pwd -P)
[[ "$qa_root" == /var/tmp/kua-yipu-security-qa-* ]] || { echo 'Use an isolated /var/tmp/kua-yipu-security-qa-* staging directory'; exit 1; }
ln -s /opt/kua-yipu-auth/node_modules node_modules
chown -R kua-yipu:kua-yipu "$qa_root"
runuser -u kua-yipu -- test -r node_modules/pg/package.json
for suite in auth-dev auth-security; do
  database="auth_qa_security_$(date +%s)_${RANDOM}"
  [[ "$database" =~ ^auth_qa_[a-z0-9_]+$ ]] || exit 1
  cleanup() { runuser -u postgres -- dropdb --if-exists "$database"; }
  trap cleanup EXIT
  # Local peer authentication creates the isolated database, never production data.
  runuser -u postgres -- createdb --owner=kua_yipu "$database"
  runuser -u postgres -- psql --set ON_ERROR_STOP=1 --dbname "$database" < auth-server/schema.sql >/dev/null
  runuser -u postgres -- psql --set ON_ERROR_STOP=1 --dbname "$database" --command 'GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO kua_yipu' >/dev/null
  set -a
  source /etc/kua-yipu/auth.env
  set +a
  DATABASE_URL=$(QA_DB_NAME="$database" node --input-type=module -e 'const u=new URL(process.env.DATABASE_URL);u.pathname="/"+process.env.QA_DB_NAME;console.log(u.href)')
  export DATABASE_URL AUTH_TEST_DATABASE_URL="$DATABASE_URL" KUA_YIPU_ADMIN_USERNAME=test KUA_YIPU_ADMIN_PASSWORD=local-test-password
  runuser -u kua-yipu --preserve-environment -- node auth-server/bootstrap-admin.js
  runuser -u kua-yipu --preserve-environment -- node --test "test/$suite.test.js"
  unset DATABASE_URL AUTH_TEST_DATABASE_URL KUA_YIPU_AUTH_SECRET KUA_YIPU_ADMIN_PASSWORD
  cleanup
  trap - EXIT
done
echo 'Isolated PostgreSQL functional and security tests passed.'
