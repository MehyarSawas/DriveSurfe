#!/usr/bin/env php
<?php declare(strict_types=1);

/**
 * Builds/refreshes the timeline month-cover index (backend/cache/months/).
 *
 * Meant to run from cron, e.g. nightly:
 *   30 3 * * * /usr/bin/php /path/to/DriveSurfe/backend/bin/build-months-cache.php >> /path/to/months-cron.log 2>&1
 *
 * Each listMediaMonths(true) call advances a full-rebuild walk a few pages.
 * This script keeps calling it with pacing until the walk reports complete —
 * i.e. the whole stream has been re-walked fresh and atomically swapped in, so
 * files deleted since the last run are gone. Run it on a short interval (e.g.
 * every 10 min) to keep the index current:
 *   *\/10 * * * * /usr/bin/php /path/to/DriveSurfe/backend/bin/build-months-cache.php >> /path/to/months-cron.log 2>&1
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

while (time() - $start < MAX_RUNTIME) {
    try {
        // advance=true — walk the full stream fresh into the build buffer; the
        // live index only swaps in once the walk completes. The web app never
        // advances the walk itself (read-only), only this script and Reload do.
        $res = $client->listMediaMonths(true);
    } catch (Throwable $e) {
        fwrite(STDERR, sprintf("[%s] ERROR %s\n", date('c'), $e->getMessage()));
        sleep(STALL_PAUSE);
        continue;
    }

    // Track the in-progress rebuild's month count for progress/pacing; the
    // live count only changes when a completed walk swaps in.
    $count = (int) ($res['meta']['build_count'] ?? 0);
    printf(
        "[%s] rebuilding=%d live=%d complete=%s size=%s\n",
        date('c'),
        $count,
        count($res['months']),
        $res['complete'] ? 'yes' : 'no',
        number_format($res['meta']['size_bytes'] ?? 0)
    );

    if ($res['complete']) {
        printf("[%s] Done — rebuild complete (%d months live).\n", date('c'), count($res['months']));
        exit(0);
    }

    sleep($count > $lastCount ? POLL_PAUSE : STALL_PAUSE);
    $lastCount = $count;
}

fwrite(STDERR, sprintf("[%s] Stopped at max runtime — index not yet complete; next run resumes from the saved cursor.\n", date('c')));
exit(0);
