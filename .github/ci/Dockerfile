# Toolchain for the PHP jobs in .github/workflows/checks.yaml.
#
# They run on the self-hosted runner (2htswebserver), which has no PHP and whose sudo
# needs a password, so shivammathur/setup-php cannot work there. This image supplies
# the same extension set the production Dockerfile builds.
# Keep the CI interpreter on the same patched 8.3 line as production.
FROM php:8.3.36-cli-bookworm@sha256:cdb77e306d6bb99db40e513fbe036ecc6c53b575cbcb7e581387845fef26d755

COPY --from=mlocati/php-extension-installer:2 /usr/bin/install-php-extensions /usr/local/bin/
COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer
# /opt too: the node image keeps yarn there and only symlinks it into /usr/local/bin.
COPY --from=node:24-bookworm /usr/local/ /usr/local/
COPY --from=node:24-bookworm /opt/ /opt/
COPY assert-php-version.php /usr/local/share/hts/assert-php-version.php
RUN php /usr/local/share/hts/assert-php-version.php

# default-mysql-client is not optional: phpunit boots bootstrap/tests.php, which runs
# migrate:fresh, and Laravel's MySqlSchemaState shells out to `mysql` to load
# database/schema/*.sql.
RUN install-php-extensions bcmath gd mbstring pdo_mysql zip \
    && apt-get update \
    && apt-get install -y --no-install-recommends git unzip default-mysql-client \
    && rm -rf /var/lib/apt/lists/*

ENV COMPOSER_ALLOW_SUPERUSER=1
