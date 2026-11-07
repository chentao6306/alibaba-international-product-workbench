#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 ]] || exit 1
cd "$(dirname "$0")/../.."
[[ $(pwd -P) == /var/tmp/kua-yipu-announcements-* ]] || exit 1
export PATH=/opt/kua-yipu-runtime/node-v22.23.2-linux-x64/bin:$PATH
for suite in announcement-media auth-dev auth-security; do
database="auth_qa_announcements_$(date +%s)_${RANDOM}"
cleanup() { runuser -u postgres -- dropdb --if-exists "$database"; }
trap cleanup EXIT
runuser -u postgres -- createdb --owner=kua_yipu "$database"
runuser -u postgres -- psql --set ON_ERROR_STOP=1 --dbname "$database" < auth-server/schema.sql >/dev/null
runuser -u postgres -- psql --set ON_ERROR_STOP=1 --dbname "$database" --command 'GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO kua_yipu' >/dev/null
set -a
source /etc/kua-yipu/auth.env
set +a
DATABASE_URL=$(QA_DB_NAME="$database" node --input-type=module -e 'const url=new URL(process.env.DATABASE_URL);url.pathname="/"+process.env.QA_DB_NAME;console.log(url.href)')
export DATABASE_URL AUTH_TEST_DATABASE_URL="$DATABASE_URL" KUA_YIPU_ADMIN_USERNAME=test KUA_YIPU_ADMIN_PASSWORD=local-test-password
export KUA_YIPU_AUTH_SECRET=isolated-auth-test-signing-secret-2026
node auth-server/bootstrap-admin.js
node --test "test/$suite.test.js"
unset AUTH_TEST_DATABASE_URL
cleanup
trap - EXIT
done
echo 'Isolated PostgreSQL announcement tests passed.'
