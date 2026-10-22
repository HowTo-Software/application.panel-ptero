#!/bin/sh
# Run ONLY in a disposable image-check container, overriding the normal entrypoint.
# Never mount production volumes or supply real environment files.
set -eu
cd /app

php .github/ci/assert-php-version.php
php -v
php-fpm -v
cli_version="$(php -r 'echo PHP_VERSION;')"
fpm_version="$(php-fpm -v | sed -n 's/^PHP \([^ ]*\).*/\1/p' | head -n 1)"
[ "$cli_version" = "$fpm_version" ] || {
    echo "PHP CLI and FPM versions differ." >&2
    exit 1
}

php -r '
foreach (["bcmath", "gd", "json", "mbstring", "openssl", "pdo", "pdo_mysql", "posix", "zip"] as $extension) {
    if (!extension_loaded($extension)) {
        fwrite(STDERR, "Missing required extension: " . $extension . PHP_EOL);
        exit(1);
    }
}
echo "Required PHP extensions verified.", PHP_EOL;
'
COMPOSER_ALLOW_SUPERUSER=1 composer --no-plugins --no-scripts check-platform-reqs --no-dev

# These paths exist only in this disposable container; no daemons are started.
mkdir -p /var/log/supervisord /var/log/nginx /var/run/php /var/run/nginx
php-fpm -t
nginx -t
python3 -c 'from supervisor.options import ServerOptions; ServerOptions().realize(args=["-c", "/etc/supervisord.conf"], doc="Validate shipped Supervisor configuration")'

test -s artisan
test -s vendor/autoload.php
test -s public/index.php
test -s public/assets/manifest.json
test ! -e /app/.env
test ! -e /app/var/.env
php -l artisan
php -l public/index.php

# An ephemeral test key, not the production APP_KEY. No entrypoint, migrations,
# seeding, workers, or external network are involved in this kernel boot check.
APP_KEY="base64:$(php -r 'echo base64_encode(random_bytes(32));')"
export APP_KEY APP_ENV=testing APP_DEBUG=false
export DB_HOST=127.0.0.1 DB_PORT=1 DB_DATABASE=testing
export CACHE_STORE=array CACHE_DRIVER=array SESSION_DRIVER=array
export QUEUE_CONNECTION=sync QUEUE_DRIVER=sync MAIL_MAILER=array MAIL_DRIVER=array
php artisan --version
