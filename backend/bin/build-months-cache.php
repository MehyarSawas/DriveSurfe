#!/usr/bin/env php
<?php declare(strict_types=1);

/**
 * Builds/refreshes the timeline month-cover index (backend/cache/months/).
 *
 * Meant to run from cron, e.g. nightly:
 *   30 3 * * * /usr/bin/php /path/to/DriveSurfe/backend/bin/build-months-cache.php >> /path/to/months-cron.log 2>&1
 *
 * Each listMediaMonths() call advances the cursor walk a few pages (or, once
 * the index is complete, rescans the head page for new uploads). This script
 * simply keeps calling it with pacing until the walk reports complete, so by
 * morning the whole index is built and the app serves it instantly.
 */

if (PHP_SAPI !== 'cli') {
    fwrite(STDERR, "This script must be run from the command line.\n");
    exit(1);
}

require __DIR__ . '/../vendor/autoload.php';

Dotenv\Dotenv::createImmutable(__DIR__ . '/..')->safeLoad();

$client = new DriveSurfe\Drive\KDrive\KDriveClient(
    new GuzzleHttp\Client(['timeout' => 30])
);

const MAX_RUNTIME  = 3000; // s — stay under typical cron/PHP-CLI limits
const POLL_PAUSE   = 4;    // s between polls — keeps kDrive's rolling rate window breathing
const STALL_PAUSE  = 30;   // s after a poll with no forward progress (rate-limited)

$start     = time();
$lastCount = -1;
$first     = true;

while (time() - $start < MAX_RUNTIME) {
    try {
        // First call forces a head refresh (picks up new uploads even when the
        // index is already complete); later calls advance the walk if needed.
        $res   = $client->listMediaMonths(false, $first);
        $first = false;
    } catch (Throwable $e) {
        fwrite(STDERR, sprintf("[%s] ERROR %s\n", date('c'), $e->getMessage()));
        sleep(STALL_PAUSE);
        continue;
    }

    $count = count($res['months']);
    printf(
        "[%s] months=%d complete=%s size=%s\n",
        date('c'),
        $count,
        $res['complete'] ? 'yes' : 'no',
        number_format($res['meta']['size_bytes'] ?? 0)
    );

    if ($res['complete']) {
        printf("[%s] Done — index complete (%d months).\n", date('c'), $count);
        exit(0);
    }

    sleep($count > $lastCount ? POLL_PAUSE : STALL_PAUSE);
    $lastCount = $count;
}

fwrite(STDERR, sprintf("[%s] Stopped at max runtime — index not yet complete; next run resumes from the saved cursor.\n", date('c')));
exit(0);
