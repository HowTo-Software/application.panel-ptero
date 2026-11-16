<?php

return [
    'assistant' => [
        'total_timeout_seconds' => (int) env('AI_TOTAL_TIMEOUT_SECONDS', 90),
        'input_character_budget' => (int) env('AI_INPUT_CHARACTER_BUDGET', 20000),
        'system_character_budget' => (int) env('AI_SYSTEM_CHARACTER_BUDGET', 12000),
        'max_output_tokens' => (int) env('AI_MAX_OUTPUT_TOKENS', 1000),
    ],
    'workshop' => [
        // Wrapper around DepotDownloader that fetches only mod.info files: `<script> <ugc manifest> <dir>`.
        'downloader' => env('STEAM_WORKSHOP_DOWNLOADER', '/usr/local/bin/hts-workshop-download'),
        // Queue consumed by the dedicated workshop worker (see .github/docker/supervisord.conf).
        'queue' => env('STEAM_WORKSHOP_QUEUE', 'workshop'),
    ],
    'providers' => [
        'ollama' => [
            'enabled' => env('FEATURE_OLLAMA', true),
            'priority' => 10,
            'timeout_seconds' => (int) env('OLLAMA_TIMEOUT_SECONDS', 90),
            'secret' => env('OLLAMA_API_KEY'),
            'model' => env('OLLAMA_MODEL') ?: 'hermes3:70b',
            'base_url' => env('OLLAMA_BASE_URL') ?: 'http://192.168.1.252:11435',
        ],
        'steam' => [
            'enabled' => env('FEATURE_STEAM_WORKSHOP', false),
            'priority' => 100,
            'timeout_seconds' => 20,
            'secret' => env('STEAM_WEB_API_KEY'),
            'model' => null,
            'app_id' => (int) env('STEAM_PZ_APP_ID', 108600),
            'base_url' => 'https://api.steampowered.com',
        ],
        'curseforge' => [
            'enabled' => env('FEATURE_CURSEFORGE', false),
            'priority' => 100,
            'timeout_seconds' => 25,
            'secret' => env('CURSEFORGE_API_KEY'),
            'model' => null,
            'base_url' => 'https://api.curseforge.com',
        ],
    ],
];
