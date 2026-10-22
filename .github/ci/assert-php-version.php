<?php

// Do not infer safety from a Dockerfile tag or Composer's simulated platform.
// Keep this independent of Laravel, dotenv, databases, and application secrets.
if (PHP_MAJOR_VERSION !== 8 || PHP_MINOR_VERSION !== 3 || PHP_VERSION_ID < 80336) {
    fwrite(STDERR, sprintf("Patched PHP 8.3.36+ (8.3 line) required; running %s.\n", PHP_VERSION));
    exit(1);
}

fwrite(STDOUT, sprintf("Patched PHP runtime verified: %s.\n", PHP_VERSION));
