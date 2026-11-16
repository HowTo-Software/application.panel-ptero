# Stage 0:
# Build the assets that are needed for the frontend. This build stage is then discarded
# since we won't need NodeJS anymore in the future. This Docker image ships a final production
# level distribution of Pterodactyl.
FROM --platform=$TARGETOS/$TARGETARCH node:22-alpine
WORKDIR /app
COPY . ./
RUN yarn install --frozen-lockfile \
    && yarn run build:production

FROM mcr.microsoft.com/dotnet/runtime:10.0-alpine@sha256:7518aaad9e4328001518006a7e8b3fcf6ce8f8816355574f7264c1fa0a0ce188 AS workshop-runtime

# Stage 1:
# Build the actual container with all of the needed PHP dependencies that will run the application.
# PHP2Shell fixed in 8.3.36; pin the verified multi-platform OCI index.
FROM --platform=$TARGETOS/$TARGETARCH php:8.3.36-fpm-alpine@sha256:cc6ceb9613967cac41a56240c27f9b134bf9fc0313afa8a004ed2ca717cffa5a
WORKDIR /app
COPY . ./
RUN php .github/ci/assert-php-version.php
COPY --from=0 /app/public/assets ./public/assets
COPY --from=workshop-runtime /usr/share/dotnet /usr/share/dotnet
COPY .github/docker/workshop/download /usr/local/bin/hts-workshop-download
COPY .github/docker/workshop/mod-info-files.txt /opt/workshop/mod-info-files.txt
RUN apk add --no-cache ca-certificates curl unzip libgcc libstdc++ libssl3 libcrypto3 zlib \
    && curl -fsSL --retry 3 https://github.com/SteamRE/DepotDownloader/releases/download/DepotDownloader_3.4.0/DepotDownloader-framework.zip -o /tmp/depot-downloader.zip \
    && echo "7419f65efb7eb16b6e56987ed1b76475f29c02475c0016166c84798388e796bc  /tmp/depot-downloader.zip" | sha256sum -c \
    && unzip -oq /tmp/depot-downloader.zip -d /opt/workshop \
    && rm /tmp/depot-downloader.zip
RUN apk add --no-cache --update ca-certificates dcron curl git supervisor tar unzip nginx libpng-dev libxml2-dev libzip-dev certbot certbot-nginx mysql-client \
    && docker-php-ext-configure zip \
    && docker-php-ext-install bcmath gd pdo_mysql zip \
    && curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer \
    && cp .env.example .env \
    && mkdir -p bootstrap/cache/ storage/logs storage/framework/sessions storage/framework/views storage/framework/cache \
    && chmod 777 -R bootstrap storage \
    && composer install --no-dev --optimize-autoloader \
    && rm -rf .env bootstrap/cache/*.php \
    && mkdir -p /app/storage/logs/ \
    && chown -R nginx:nginx .

RUN rm /usr/local/etc/php-fpm.conf \
    && echo "* * * * * /usr/local/bin/php /app/artisan schedule:run >> /dev/null 2>&1" >> /var/spool/cron/crontabs/root \
    && echo "0 23 * * * certbot renew --nginx --quiet" >> /var/spool/cron/crontabs/root \
    && sed -i s/ssl_session_cache/#ssl_session_cache/g /etc/nginx/nginx.conf \
    && mkdir -p /var/run/php /var/run/nginx

# .dockerignore strips .git, so the footer falls back to config('app.version').
ARG APP_VERSION=canary
RUN sed -i "s|'version' => 'canary',|'version' => '${APP_VERSION}',|" config/app.php

COPY .github/docker/default.conf /etc/nginx/http.d/default.conf
COPY .github/docker/www.conf /usr/local/etc/php-fpm.conf
COPY .github/docker/supervisord.conf /etc/supervisord.conf

EXPOSE 80 443
ENTRYPOINT [ "/bin/ash", ".github/docker/entrypoint.sh" ]
CMD [ "supervisord", "-n", "-c", "/etc/supervisord.conf" ]
