<?php declare(strict_types=1);

namespace DriveSurfe\Drive\KDrive;

use DriveSurfe\Drive\DriveInterface;
use GuzzleHttp\Client;
use GuzzleHttp\Exception\GuzzleException;
use RuntimeException;

final class KDriveClient implements DriveInterface
{
    private const API_V2 = 'https://api.infomaniak.com/2/drive';
    private const API_V3 = 'https://api.infomaniak.com/3/drive';
    private const API_BASE = self::API_V2;

    public function __construct(private readonly Client $http) {}

    public function listFiles(string $folderId = '5', array $options = []): array
    {
        $driveId = $this->getDriveId();
        $sortBy  = $options['sortBy'] ?? 'name';
        $sortDir = $options['sortDir'] ?? 'asc';
        $cursor  = $options['cursor'] ?? null;

        $params = [
            'order_by'  => $sortBy,
            'order_for' => [$sortBy => $sortDir],
            'with'      => 'is_favorite',
            'limit'     => 50,
        ];
        if ($cursor) $params['cursor'] = $cursor;

        $data    = $this->get("{$driveId}/files/{$folderId}/files", $params, self::API_V3);
        $hasMore = $data['has_more'] ?? false;

        return [
            'files'    => $this->normalizeFiles($data['data'] ?? []),
            'cursor'   => $hasMore ? ($data['cursor'] ?? null) : null,
            'has_more' => $hasMore,
        ];
    }

    public function getFile(string $fileId): array
    {
        $driveId = $this->getDriveId();
        $data = $this->get("{$driveId}/files/{$fileId}");
        return $this->normalizeFile($data['data'] ?? []);
    }

    public function getFolderTree(): array
    {
        $driveId = $this->getDriveId();
        $dirs    = [];
        $cursor  = null;

        do {
            $params = ['type' => 'dir'];
            if ($cursor) $params['cursor'] = $cursor;
            $data   = $this->get("{$driveId}/files/5/files", $params, self::API_V3);
            $dirs   = array_merge($dirs, $data['data'] ?? []);
            $cursor = ($data['has_more'] ?? false) ? ($data['cursor'] ?? null) : null;
        } while ($cursor);

        return $this->buildTree($dirs, '5');
    }

    public function search(string $query, ?string $folderId = null, array $options = []): array
    {
        $driveId = $this->getDriveId();

        // V3 order_by only accepts last_modified_at or relevance
        $sortBy  = $options['sortBy'] ?? 'relevance';
        $sortDir = $options['sortDir'] ?? 'desc';
        $apiOrderBy = match ($sortBy) {
            'last_modified_at' => 'last_modified_at',
            default            => 'relevance',
        };

        $params = [
            'query'       => $query,
            'query_scope' => 'filename',
            'limit'       => 500,
            'with'        => 'is_favorite',
            'depth'       => 'unlimited',
            'order_by'    => $apiOrderBy,
            'order'       => $sortDir,
        ];
        if ($folderId !== null && $folderId !== '' && $folderId !== '1') {
            $params['directory_id'] = (int) $folderId;
        }
        if (isset($options['cursor']) && $options['cursor']) {
            $params['cursor'] = $options['cursor'];
        }

        $all = [];
        do {
            $data    = $this->get("{$driveId}/files/search", $params, self::API_V3);
            $all     = array_merge($all, $this->normalizeFiles($data['data'] ?? []));
            $hasMore = !empty($data['has_more']);
            $cursor  = $hasMore ? ($data['cursor'] ?? null) : null;
            if ($cursor) $params['cursor'] = $cursor;
        } while ($hasMore && $cursor);

        return ['data' => $all, 'has_more' => false, 'cursor' => null, 'capped' => false];
    }

    public function thumbnailUrl(string $fileId): string
    {
        $driveId = $this->getDriveId();
        return self::API_BASE . "/{$driveId}/files/{$fileId}/thumbnail";
    }

    public function previewUrl(string $fileId): string
    {
        $driveId = $this->getDriveId();
        return self::API_BASE . "/{$driveId}/files/{$fileId}/preview";
    }

    public function downloadStream(string $fileId): mixed
    {
        $driveId = $this->getDriveId();
        $token = $this->getToken();
        $response = $this->http->get(
            self::API_BASE . "/{$driveId}/files/{$fileId}/download",
            [
                'headers' => ['Authorization' => "Bearer {$token}"],
                'stream' => true,
            ]
        );
        return $response->getBody();
    }

    public function favorite(string $fileId): void
    {
        $driveId = $this->getDriveId();
        $this->post("{$driveId}/files/{$fileId}/favorite");
    }

    public function unfavorite(string $fileId): void
    {
        $driveId = $this->getDriveId();
        $this->deleteReq("{$driveId}/files/{$fileId}/favorite");
    }

    public function delete(string $fileId): void
    {
        $driveId = $this->getDriveId();
        $this->deleteReq("{$driveId}/files/{$fileId}");
    }

    public function createFolder(string $parentId, string $name): array
    {
        $driveId = $this->getDriveId();
        $data = $this->post("{$driveId}/files/{$parentId}/directory", [
            'name' => $name,
        ], self::API_V3);
        return $this->normalizeFile($data['data'] ?? []);
    }

    public function restoreFile(string $fileId): void
    {
        $driveId = $this->getDriveId();
        $this->post("{$driveId}/trash/{$fileId}/restore");
    }

    public function moveFile(string $fileId, string $destinationFolderId, string $strategy = 'override'): void
    {
        $driveId  = $this->getDriveId();
        $conflict = $strategy === 'skip' ? 'error' : 'rename';
        $this->post("{$driveId}/files/{$fileId}/move/{$destinationFolderId}", ['conflict' => $conflict], self::API_V3);
    }

    public function copyFile(string $fileId, string $destinationFolderId): array
    {
        $driveId = $this->getDriveId();
        $data = $this->post("{$driveId}/files/{$fileId}/duplicate", [], self::API_V3);
        $copy = $data['data'] ?? [];
        if (!empty($copy['id']) && (string)$copy['id'] !== (string)$destinationFolderId) {
            $this->post("{$driveId}/files/{$copy['id']}/move/{$destinationFolderId}", ['conflict' => 'rename'], self::API_V3);
        }
        return $copy;
    }

    public function uploadFile(string $parentId, string $filename, string $mimeType, string $binary): array
    {
        $driveId = $this->getDriveId();
        $token   = $this->getToken();
        $url = self::API_V3 . "/{$driveId}/upload?" . http_build_query([
            'directory_id' => (int) $parentId,
            'file_name'    => $filename,
            'conflict'     => 'rename',
            'total_size'   => strlen($binary),
        ]);

        try {
            $response = $this->http->post($url, [
                'headers' => [
                    'Authorization' => "Bearer {$token}",
                    'Content-Type'  => $mimeType,
                ],
                'timeout' => 300,
                'body'    => $binary,
            ]);
        } catch (\GuzzleHttp\Exception\GuzzleException $e) {
            throw new \RuntimeException('Upload to storage failed: ' . $e->getMessage(), 0, $e);
        }

        $body = (string) $response->getBody();
        $data = json_decode($body, true, 512, JSON_THROW_ON_ERROR);
        if (($data['result'] ?? '') === 'error') {
            throw new \RuntimeException('Storage API error: ' . ($data['error']['description'] ?? $body));
        }
        return $this->normalizeFile($data['data'] ?? []);
    }

    public function renameFile(string $fileId, string $name): array
    {
        $driveId = $this->getDriveId();
        $data = $this->post("{$driveId}/files/{$fileId}/rename", ['name' => $name]);
        return isset($data['data']) ? $this->normalizeFile($data['data']) : [];
    }

    /**
     * One page of ALL media files under the drive (recursive), newest first.
     * Uses the V3 search endpoint without a text query — server-side ordering
     * by last_modified_at desc; media filtering (image/video) happens here
     * since search has no reliable mime filter. A page can therefore yield
     * fewer (even zero) items than `limit` while has_more is still true —
     * callers must keep paginating by cursor.
     */
    public function listMedia(?string $cursor = null, string $order = 'desc'): array
    {
        $driveId = $this->getDriveId();
        $params = [
            'order_by' => 'last_modified_at',
            // asc = oldest first, desc = newest first — the only order_by the
            // search endpoint supports server-side is last_modified_at.
            'order'    => $order === 'asc' ? 'asc' : 'desc',
            // Max page size — Infomaniak rate-limits per rolling window, so
            // fewer/larger pages beat many small ones.
            'limit'    => 1000,
            'depth'    => 'unlimited',
            'with'     => 'is_favorite',
            // Server-side filter to images + videos (same as the kDrive app's
            // Gallery: types[]=image&types[]=video) so pages are dense with
            // media instead of mostly documents.
            'types'    => ['image', 'video'],
        ];
        // NO date params here, deliberately: on this endpoint modified_after
        // is floored at the drive-creation date (422 below it) and
        // modified_before returns empty once it points into the past — both
        // verified against production. History is only reachable via plain
        // cursor pagination; period views filter client-side.
        $timelineFolder = $this->getTimelineFolderId();
        if ($timelineFolder !== null) {
            $params['directory_id'] = (int) $timelineFolder;
        }
        if ($cursor) $params['cursor'] = $cursor;

        $data  = $this->get("{$driveId}/files/search", $params, self::API_V3);
        $files = $this->normalizeFiles($data['data'] ?? []);

        $media = array_values(array_filter($files, fn(array $f) => self::isMediaFile($f)));

        $hasMore = $data['has_more'] ?? false;
        return [
            'files'    => $media,
            'cursor'   => $hasMore ? ($data['cursor'] ?? null) : null,
            'has_more' => $hasMore,
        ];
    }

    /**
     * TEMPORARY diagnostic: probe the search endpoint under several param
     * combinations to find out which one actually returns historical media.
     * Returns raw counts / errors — no caching, no filtering surprises.
     */
    public function diagnoseMedia(): array
    {
        $driveId = $this->getDriveId();
        $now     = time();
        $probe = function (string $label, array $extra) use ($driveId): array {
            $params = [
                'order_by' => 'last_modified_at',
                'order'    => 'desc',
                'limit'    => 5,
                'depth'    => 'unlimited',
                'types'    => ['image', 'video'],
            ] + $extra;
            try {
                $data  = $this->get("{$driveId}/files/search", $params, self::API_V3);
                $items = $data['data'] ?? [];
                $first = $items[0] ?? null;
                $last  = $items ? $items[count($items) - 1] : null;
                return [
                    'ok'         => true,
                    'count'      => count($items),
                    'has_more'   => $data['has_more'] ?? null,
                    'first_name' => $first['name'] ?? null,
                    'first_mod'  => $first['last_modified_at'] ?? null,
                    'last_mod'   => $last['last_modified_at'] ?? null,
                ];
            } catch (\Throwable $e) {
                return ['ok' => false, 'error' => substr($e->getMessage(), 0, 500)];
            }
        };

        return [
            'now'                   => $now,
            'A_baseline'            => $probe('baseline', []),
            'B_before_90d_custom'   => $probe('b90', ['modified_at' => 'custom', 'modified_before' => $now - 7776000]),
            'C_before_2015'         => $probe('b2015', ['modified_at' => 'custom', 'modified_before' => 1434326400]),
            'D_before_no_types'     => (function () use ($driveId, $now) {
                try {
                    $data = $this->get("{$driveId}/files/search", [
                        'order_by' => 'last_modified_at', 'order' => 'desc', 'limit' => 5,
                        'depth' => 'unlimited', 'type' => 'file',
                        'modified_at' => 'custom', 'modified_before' => 1434326400,
                    ], self::API_V3);
                    return ['ok' => true, 'count' => count($data['data'] ?? []), 'has_more' => $data['has_more'] ?? null];
                } catch (\Throwable $e) {
                    return ['ok' => false, 'error' => substr($e->getMessage(), 0, 500)];
                }
            })(),
            'E_last_year_preset'    => $probe('lastyear', ['modified_at' => 'last_year']),
        ];
    }

    private static function isMediaFile(array $f): bool
    {
        static $mediaExt = ['jpg','jpeg','png','gif','webp','heic','heif','avif','mp4','mov','m4v','webm','avi','mkv'];
        return str_starts_with($f['mime_type'], 'image/')
            || str_starts_with($f['mime_type'], 'video/')
            || in_array($f['extension'], $mediaExt, true);
    }

    /**
     * Timeline month covers, built as a persistent CURSOR-WALK index.
     *
     * Empirically (this drive), the search endpoint's modified_before returns
     * nothing once it points into the past beyond the newest weeks, and
     * modified_after is floored at the drive-creation date — so date params
     * cannot enumerate history at all. The only thing that reliably walks the
     * whole newest-first stream is plain cursor pagination.
     *
     * So: each call advances the walk by up to MONTHS_PAGES_PER_CALL pages
     * from a cursor persisted in a state file, merging every newly seen
     * Y-m month (its first/newest file = cover, plus the CURSOR of the page
     * it appeared on — month drill-down streams from that cursor). The
     * frontend polls until `complete`. Once complete, only the newest page is
     * rescanned (at most every MONTHS_HEAD_TTL) to pick up new uploads —
     * history behind the head never changes.
     */
    private const MONTHS_CACHE_DIR      = __DIR__ . '/../../../cache/months';
    private const MONTHS_HEAD_TTL       = 900; // 15 min — only the head of the stream changes
    private const MONTHS_PAGES_PER_CALL = 5;   // per poll — bounded by rate limit + PHP exec time
    private const MONTHS_TIME_BUDGET    = 8;   // s per poll — return partial fast instead of hanging

    /** State file path — versioned (v4: image-preferring covers) and keyed by
     *  the configured TIMELINE_FOLDER_ID, so changing the folder in .env
     *  automatically starts a fresh index instead of serving the old one. */
    private function monthsStateFile(): string
    {
        $folder = $this->getTimelineFolderId();
        return self::MONTHS_CACHE_DIR . '/v4-state' . ($folder !== null ? "-{$folder}" : '') . '.json';
    }

    /**
     * @param bool $refresh Head-page rescan (new uploads) + write — the app's
     *                      explicit Reload action.
     * @param bool $build   Advance the cursor walk + write — used ONLY by the
     *                      cron script (bin/build-months-cache.php).
     *
     * A plain call (both false) is strictly READ-ONLY: it serves whatever the
     * state file holds without touching the kDrive API or writing anything —
     * opening the timeline must never burn API quota or grow the cache.
     */
    public function listMediaMonths(bool $debug = false, bool $refresh = false, bool $build = false): array
    {
        $stateFile = $this->monthsStateFile();
        $state = ['months' => [], 'cursor' => null, 'complete' => false, 'updated_at' => 0];
        if (is_file($stateFile)) {
            $cached = json_decode((string) file_get_contents($stateFile), true);
            if (is_array($cached) && isset($cached['months']) && is_array($cached['months'])) {
                $state = array_merge($state, $cached);
            }
        }
        $diag = ['pages' => 0, 'rejected' => null];

        if ($build && !$state['complete']) {
            // Advance the walk under a hard TIME budget, not just a page count:
            // when kDrive starts 429ing, get()'s retry sleeps (~18s each) would
            // otherwise stack up inside one request and the call appears hung.
            // Better to return whatever we have quickly — the cron loop calls
            // again after a pause, giving the rolling rate window room to
            // recover. Partial progress is kept on error (resume from cursor).
            $deadline = time() + self::MONTHS_TIME_BUDGET;
            try {
                for ($i = 0; $i < self::MONTHS_PAGES_PER_CALL && time() < $deadline; $i++) {
                    $pageCursor = $state['cursor'];
                    $res = $this->listMedia($pageCursor);
                    $diag['pages']++;
                    $this->mergeMonths($state['months'], $res['files'], $pageCursor, false);
                    $state['cursor'] = $res['cursor'];
                    if (!($res['has_more'] ?? false) || !$res['cursor']) {
                        $state['complete'] = true;
                        break;
                    }
                }
            } catch (RuntimeException $e) {
                $diag['rejected'] = substr($e->getMessage(), 0, 600);
            }
            $state['updated_at'] = time();
            $this->saveMonthsState($state);
        } elseif ($refresh || ($build && time() - (int) $state['updated_at'] >= self::MONTHS_HEAD_TTL)) {
            // Rescan only the head page so new uploads show up (new months
            // appear; the newest months' covers track them). Reached via the
            // app's Reload action or the cron's head-refresh pass.
            try {
                $res = $this->listMedia(null);
                $diag['pages']++;
                $this->mergeMonths($state['months'], $res['files'], null, true);
                $state['updated_at'] = time();
                $this->saveMonthsState($state);
            } catch (RuntimeException $e) {
                $diag['rejected'] = substr($e->getMessage(), 0, 600); // serve stale
            }
        }

        $months = $state['months'];
        krsort($months); // 'YYYY-MM' string keys — reverse-sorted = newest first
        $result = [
            'months'   => array_values($months),
            'complete' => (bool) $state['complete'],
            'meta'     => [
                'updated_at' => (int) $state['updated_at'],
                'size_bytes' => is_file($stateFile) ? (int) filesize($stateFile) : 0,
                'count'      => count($months),
            ],
        ];
        if ($debug) {
            $result['debug'] = $diag + ['cursor' => $state['cursor']];
        }
        return $result;
    }

    /** Merge one page of newest-first files into the months map.
     *  Cover rule: the newest IMAGE of the month; a video only stands in
     *  while no image has been seen yet (files arrive newest-first, so the
     *  first image encountered is the newest one). On refresh (head rescan),
     *  the first file per month may replace the cover under the same rule. */
    private function mergeMonths(array &$months, array $files, ?string $pageCursor, bool $refreshCovers): void
    {
        $isImage = fn(array $f): bool =>
            str_starts_with($f['mime_type'] ?? '', 'image/')
            || in_array($f['extension'] ?? '', ['jpg','jpeg','png','gif','webp','heic','heif','avif'], true);

        $seenThisPage = [];
        foreach ($files as $f) {
            $ts = $f['modified_at'] ? strtotime($f['modified_at']) : false;
            if ($ts === false || $ts <= 0) continue;
            $key = date('Y-m', $ts);

            if (!isset($months[$key])) {
                $months[$key] = [
                    'key'    => $key,
                    'year'   => (int) substr($key, 0, 4),
                    'month'  => (int) substr($key, 5, 2),
                    'cover'  => $f, // newest file so far — upgraded to an image below
                    // Cursor of the page this month first appeared on (null =
                    // stream head) — month drill-down streams from here.
                    'cursor' => $pageCursor,
                ];
                continue;
            }

            if (!$isImage($f)) continue; // videos never replace an existing cover
            if (!$isImage($months[$key]['cover'])) {
                // Upgrade a video placeholder to the newest image of the month.
                $months[$key]['cover'] = $f;
                $seenThisPage[$key] = true;
            } elseif ($refreshCovers && !isset($seenThisPage[$key])) {
                // Head rescan: first image per month in this page = the newest
                // image of the month — it becomes the cover.
                $months[$key]['cover'] = $f;
                $seenThisPage[$key] = true;
            }
        }
    }

    private function saveMonthsState(array $state): void
    {
        @mkdir(self::MONTHS_CACHE_DIR, 0775, true);
        $stateFile = $this->monthsStateFile();
        $tmp = $stateFile . '.tmp.' . bin2hex(random_bytes(4));
        if (@file_put_contents($tmp, json_encode($state), LOCK_EX) !== false) {
            @rename($tmp, $stateFile);
        }
    }

    public function createShareLink(string $fileId, array $options): array
    {
        $driveId = $this->getDriveId();
        $body = array_filter($options, fn($v) => $v !== null);
        $data = $this->post("{$driveId}/files/{$fileId}/link", $body);
        return $this->normalizeShareLink($data['data'] ?? []);
    }

    public function updateShareLink(string $fileId, array $options): bool
    {
        $driveId = $this->getDriveId();
        $body = array_filter($options, fn($v) => $v !== null);
        $data = $this->put("{$driveId}/files/{$fileId}/link", $body);
        return (bool) ($data['data'] ?? false);
    }

    public function deleteShareLink(string $fileId): bool
    {
        $driveId = $this->getDriveId();
        $data = $this->deleteReq("{$driveId}/files/{$fileId}/link");
        return (bool) ($data['data'] ?? false);
    }

    /**
     * Returns null both when the file genuinely has no share link and when
     * the lookup fails for any other reason (kDrive returns an error result
     * rather than a clean "no link" signal) — acceptable here since this is
     * only ever used to answer "does this file currently have a share link".
     */
    public function getShareLink(string $fileId): ?array
    {
        $driveId = $this->getDriveId();
        try {
            $data = $this->get("{$driveId}/files/{$fileId}/link");
            return isset($data['data']) ? $this->normalizeShareLink($data['data']) : null;
        } catch (RuntimeException) {
            return null;
        }
    }

    /** Paginated list of every file/folder that currently has an active share link. */
    public function listShareLinks(): array
    {
        $driveId = $this->getDriveId();
        $all     = [];
        $cursor  = null;

        do {
            $params = ['with' => 'sharelink', 'limit' => 200];
            if ($cursor) $params['cursor'] = $cursor;
            $data   = $this->get("{$driveId}/files/links", $params, self::API_V3);
            $all    = array_merge($all, $data['data'] ?? []);
            $cursor = ($data['has_more'] ?? false) ? ($data['cursor'] ?? null) : null;
        } while ($cursor);

        return $this->normalizeFiles($all);
    }

    public function listFavorites(): array
    {
        $driveId = $this->getDriveId();
        $token   = $this->getToken();
        $files   = [];
        $cursor  = null;

        do {
            $query    = $cursor ? ['cursor' => $cursor] : [];
            $response = $this->http->get(
                "https://api.infomaniak.com/3/drive/{$driveId}/files/favorites",
                ['headers' => ['Authorization' => "Bearer {$token}"], 'query' => $query ?: null]
            );
            $data    = json_decode((string) $response->getBody(), true, 512, JSON_THROW_ON_ERROR);
            $files   = array_merge($files, $data['data'] ?? []);
            $cursor  = $data['has_more'] ? ($data['cursor'] ?? null) : null;
        } while ($cursor);

        return $this->normalizeFiles($files);
    }

    /**
     * ALL items in the trash. V2 is page-paginated (not cursor). We dedupe by
     * id and STOP as soon as a page adds no new items — critical because if
     * the endpoint ignores the `page` param it would otherwise return the same
     * page forever (hundreds of requests + massive duplicate data). Effective
     * page size is discovered from the first response; a hard page cap bounds
     * the worst case.
     */
    public function listTrash(string $sortBy = 'deleted_at', string $sortDir = 'desc'): array
    {
        $driveId  = $this->getDriveId();
        $all      = [];
        $seen     = [];
        $page     = 1;
        $pageSize = null;

        do {
            $data  = $this->get("{$driveId}/trash", ['per_page' => 200, 'page' => $page, 'with' => 'is_favorite']);
            $batch = $data['data'] ?? [];
            if ($pageSize === null) $pageSize = count($batch); // effective per_page

            $added = 0;
            foreach ($batch as $item) {
                $id = (string) ($item['id'] ?? '');
                if ($id === '' || isset($seen[$id])) continue;
                $seen[$id] = true;
                $all[]     = $item;
                $added++;
            }
            $page++;
            // Stop on: no new items (last page, or server ignored `page`),
            // a partial page (last page), or the safety cap.
        } while ($added > 0 && $pageSize > 0 && count($batch) === $pageSize && $page <= 60);

        $files = $this->normalizeFiles($all, true);
        return self::sortFiles($files, $sortBy, $sortDir);
    }

    /** Server-side sort for the fully-fetched trash list (the V2 trash
     *  endpoint has no reliable order param). */
    private static function sortFiles(array $files, string $sortBy, string $sortDir): array
    {
        $dir = $sortDir === 'desc' ? -1 : 1;
        usort($files, function (array $a, array $b) use ($sortBy, $dir): int {
            $cmp = match ($sortBy) {
                'size'             => ($a['size'] ?? 0) <=> ($b['size'] ?? 0),
                'last_modified_at' => (strtotime($a['modified_at'] ?? '') ?: 0) <=> (strtotime($b['modified_at'] ?? '') ?: 0),
                'deleted_at'       => (strtotime($a['deleted_at'] ?? '') ?: 0) <=> (strtotime($b['deleted_at'] ?? '') ?: 0),
                default            => strnatcasecmp($a['name'] ?? '', $b['name'] ?? ''),
            };
            return $cmp * $dir;
        });
        return $files;
    }

    /** Permanently remove one item from the trash (irreversible). */
    public function deleteTrashFile(string $fileId): void
    {
        $driveId = $this->getDriveId();
        $this->deleteReq("{$driveId}/trash/{$fileId}");
    }

    /** Empty the whole trash (irreversible). */
    public function emptyTrash(): void
    {
        $driveId = $this->getDriveId();
        $this->deleteReq("{$driveId}/trash");
    }

    public function getUsage(): array
    {
        $driveId = $this->getDriveId();
        $data = $this->get("{$driveId}");
        $drive = $data['data'] ?? [];
        return [
            'used' => $drive['used_size'] ?? 0,
            'total' => $drive['size'] ?? 0,
        ];
    }

    public function getFolderCount(string $folderId, string $depth = 'folder'): array
    {
        $driveId = $this->getDriveId();
        $data = $this->get("{$driveId}/files/{$folderId}/count", ['depth' => $depth], self::API_V3);
        return $data['data'] ?? ['count' => 0, 'files' => 0, 'directories' => 0];
    }

    public function getFolderSize(string $folderId): int
    {
        $driveId = $this->getDriveId();
        $data = $this->get("{$driveId}/files/{$folderId}/sizes", ['depth' => 'unlimited'], self::API_V2);
        return (int) ($data['data']['size'] ?? 0);
    }

    public function proxyDownload(string $fileId): void
    {
        $driveId = $this->getDriveId();
        $token   = $this->getToken();

        $meta = $this->get("{$driveId}/files/{$fileId}");
        $name = rawurlencode($meta['data']['name'] ?? 'download');
        $mime = $meta['data']['mime_type'] ?? 'application/octet-stream';

        $requestHeaders = ['Authorization' => "Bearer {$token}"];
        $rangeHeader    = $_SERVER['HTTP_RANGE'] ?? null;
        if ($rangeHeader && preg_match('/^bytes=\d*-\d*$/', $rangeHeader)) {
            $requestHeaders['Range'] = $rangeHeader;
        }

        try {
            $response = $this->http->get(
                self::API_V2 . "/{$driveId}/files/{$fileId}/download",
                ['headers' => $requestHeaders, 'stream' => true, 'http_errors' => false]
            );
        } catch (\GuzzleHttp\Exception\GuzzleException $e) {
            http_response_code(502);
            exit;
        }

        $status = $response->getStatusCode();
        http_response_code($status);

        $safeMime = self::safeMimeType($mime);
        header("Content-Type: {$safeMime}");
        header("Content-Disposition: inline; filename*=UTF-8''{$name}");
        header("Accept-Ranges: bytes");
        header("Cache-Control: private, max-age=3600");

        if ($len = $response->getHeaderLine('Content-Length')) {
            header("Content-Length: {$len}");
        }
        if ($range = $response->getHeaderLine('Content-Range')) {
            header("Content-Range: {$range}");
        }

        $body = $response->getBody();
        while (!$body->eof()) {
            echo $body->read(65536);
            if (connection_aborted()) break;
        }
    }

    public function proxyFile(string $fileId, string $type = 'thumbnail', bool $inTrash = false, array $query = []): void
    {
        $driveId = $this->getDriveId();
        $token   = $this->getToken();
        $segment = $inTrash ? 'trash' : 'files';
        $url     = self::API_BASE . "/{$driveId}/{$segment}/{$fileId}/{$type}";
        if ($query) $url .= '?' . http_build_query($query);

        try {
            $response = $this->http->get($url, [
                'headers'     => ['Authorization' => "Bearer {$token}"],
                'stream'      => true,
                'http_errors' => false,
            ]);
        } catch (\GuzzleHttp\Exception\GuzzleException $e) {
            error_log("proxyFile exception [{$type}:{$fileId}]: " . $e->getMessage());
            http_response_code(502);
            exit;
        }

        $status      = $response->getStatusCode();
        $contentType = $response->getHeaderLine('Content-Type') ?: '';

        if ($status < 200 || $status >= 300 || !str_starts_with($contentType, 'image/')) {
            error_log("proxyFile non-image [{$type}:{$fileId}] status={$status} ct={$contentType}");
            http_response_code(404);
            exit;
        }

        header("Content-Type: " . self::safeMimeType($contentType));
        header("X-Content-Type-Options: nosniff");
        header("Cache-Control: private, max-age=3600");

        $body = $response->getBody();
        while (!$body->eof()) {
            echo $body->read(8192);
        }
    }

    private static function toIso(mixed $ts): ?string
    {
        if ($ts === null || $ts === '') return null;
        if (is_numeric($ts)) return date('c', (int) $ts);
        return (string) $ts;
    }

    /** Full upstream error body (Guzzle truncates it in getMessage()) — vital
     *  for rate-limit context like remaining/reset. */
    private static function responseDetail(GuzzleException $e): string
    {
        if (!$e instanceof \GuzzleHttp\Exception\BadResponseException) return '';
        $body = (string) $e->getResponse()->getBody();
        return $body !== '' ? ' | upstream: ' . substr($body, 0, 600) : '';
    }

    private static function safeMimeType(string $mime): string
    {
        $allowed = [
            'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
            'image/heic', 'image/heif', 'image/avif',
            'video/mp4', 'video/quicktime', 'video/x-m4v', 'video/webm',
            'audio/mpeg', 'audio/mp4', 'audio/ogg',
            'application/pdf',
        ];
        $base = strtolower(explode(';', $mime)[0]);
        return in_array($base, $allowed, true) ? $base : 'application/octet-stream';
    }

    private function getDriveId(): string
    {
        $driveId = $_ENV['KDRIVE_DRIVE_ID'] ?? null;
        if (!$driveId) {
            throw new RuntimeException('KDRIVE_DRIVE_ID not set in .env');
        }
        return $driveId;
    }

    private function getToken(): string
    {
        return $_ENV['KDRIVE_TOKEN'] ?? throw new RuntimeException('KDRIVE_TOKEN not set in .env');
    }

    /** Optional root folder for the timeline (TIMELINE_FOLDER_ID in .env).
     *  When set, the media stream and month index only cover that folder
     *  (recursively) instead of the whole drive. Null = whole drive. */
    private function getTimelineFolderId(): ?string
    {
        $id = trim((string) ($_ENV['TIMELINE_FOLDER_ID'] ?? ''));
        return $id !== '' && preg_match('/^\d+$/', $id) ? $id : null;
    }

    private function get(string $path, array $query = [], ?string $baseUrl = null): array
    {
        $token = $this->getToken();
        $url = ($baseUrl ?? self::API_BASE) . ($path ? "/{$path}" : '');

        // kDrive throttles with SHORT rolling windows (observed retry_after of
        // ~18s) — one honored retry rides out most transient 429s.
        for ($attempt = 0; ; $attempt++) {
            try {
                $response = $this->http->get($url, [
                    'headers' => ['Authorization' => "Bearer {$token}"],
                    'query' => $query ?: null,
                ]);
                $body = (string) $response->getBody();
                try {
                    $data = json_decode($body, true, 512, JSON_THROW_ON_ERROR);
                } catch (\JsonException $e) {
                    throw new RuntimeException("kDrive API returned non-JSON response (HTTP {$response->getStatusCode()}): " . substr($body, 0, 200), 0, $e);
                }
                if (($data['result'] ?? '') === 'error') {
                    throw new RuntimeException('kDrive: ' . json_encode($data['error'] ?? 'unknown'));
                }
                return $data;
            } catch (GuzzleException $e) {
                $wait = $attempt === 0 ? self::retryAfterSeconds($e) : null;
                if ($wait !== null) {
                    sleep($wait);
                    continue;
                }
                throw new RuntimeException("kDrive API error: " . $e->getMessage() . self::responseDetail($e), 0, $e);
            }
        }
    }

    /** Seconds to wait before retrying a 429, from the upstream error body —
     *  null when the error isn't a retryable throttle or the wait is too long. */
    private static function retryAfterSeconds(GuzzleException $e): ?int
    {
        if (!$e instanceof \GuzzleHttp\Exception\BadResponseException) return null;
        if ($e->getResponse()->getStatusCode() !== 429) return null;
        $body = json_decode((string) $e->getResponse()->getBody(), true);
        $retryAfter = (int) ($body['error']['context']['retry_after'] ?? 10);
        return $retryAfter <= 25 ? $retryAfter + 1 : null;
    }

    private function post(string $path, array $body = [], ?string $baseUrl = null): array
    {
        $token = $this->getToken();
        try {
            $response = $this->http->post(($baseUrl ?? self::API_BASE) . "/{$path}", [
                'headers' => ['Authorization' => "Bearer {$token}", 'Content-Type' => 'application/json'],
                'json' => $body,
            ]);
            $data = json_decode((string) $response->getBody(), true, 512, JSON_THROW_ON_ERROR);
            if (($data['result'] ?? '') === 'error') {
                throw new RuntimeException('kDrive: ' . json_encode($data['error'] ?? 'unknown'));
            }
            return $data;
        } catch (GuzzleException $e) {
            throw new RuntimeException("kDrive API error: " . $e->getMessage() . self::responseDetail($e), 0, $e);
        }
    }

    private function put(string $path, array $body = [], ?string $baseUrl = null): array
    {
        $token = $this->getToken();
        try {
            $response = $this->http->put(($baseUrl ?? self::API_BASE) . "/{$path}", [
                'headers' => ['Authorization' => "Bearer {$token}", 'Content-Type' => 'application/json'],
                'json' => $body ?: (object) [],
            ]);
            $data = json_decode((string) $response->getBody(), true, 512, JSON_THROW_ON_ERROR);
            if (($data['result'] ?? '') === 'error') {
                throw new RuntimeException('kDrive: ' . json_encode($data['error'] ?? 'unknown'));
            }
            return $data;
        } catch (GuzzleException $e) {
            throw new RuntimeException("kDrive API error: " . $e->getMessage() . self::responseDetail($e), 0, $e);
        }
    }

    private function patch(string $path, array $body = [], ?string $baseUrl = null): array
    {
        $token = $this->getToken();
        try {
            $response = $this->http->patch(($baseUrl ?? self::API_BASE) . "/{$path}", [
                'headers' => ['Authorization' => "Bearer {$token}", 'Content-Type' => 'application/json'],
                'json' => $body ?: null,
            ]);
            return json_decode((string) $response->getBody(), true, 512, JSON_THROW_ON_ERROR);
        } catch (GuzzleException $e) {
            throw new RuntimeException("kDrive API error: " . $e->getMessage() . self::responseDetail($e), 0, $e);
        }
    }

    private function deleteReq(string $path): array
    {
        $token = $this->getToken();
        try {
            $response = $this->http->delete(self::API_BASE . "/{$path}", [
                'headers' => ['Authorization' => "Bearer {$token}"],
            ]);
            $body = (string) $response->getBody();
            return $body ? json_decode($body, true, 512, JSON_THROW_ON_ERROR) : [];
        } catch (GuzzleException $e) {
            throw new RuntimeException("kDrive API error: " . $e->getMessage() . self::responseDetail($e), 0, $e);
        }
    }

    private function normalizeFiles(array $files, bool $inTrash = false): array
    {
        return array_map(fn($f) => $this->normalizeFile($f, $inTrash), $files);
    }

    private function normalizeFile(array $f, bool $inTrash = false): array
    {
        $id = (string) ($f['id'] ?? '');
        $ctx = $inTrash ? '?context=trash' : '';
        return [
            'id' => $id,
            'name' => $f['name'] ?? '',
            'type' => $f['type'] ?? 'file',
            'mime_type' => $f['mime_type'] ?? '',
            'size' => $f['size'] ?? 0,
            // kDrive sends unix seconds — normalize to ISO 8601 so JS Date /
            // Angular's date pipe parse them correctly (raw seconds get read
            // as milliseconds and land in January 1970).
            'modified_at' => self::toIso($f['last_modified_at'] ?? $f['created_at'] ?? null),
            'created_at' => self::toIso($f['created_at'] ?? null),
            'deleted_at' => self::toIso($f['deleted_at'] ?? null),
            'is_dir' => ($f['type'] ?? '') === 'dir',
            'is_favorite' => $f['is_favorite'] ?? false,
            'parent_id' => (string) ($f['parent_id'] ?? '1'),
            'thumbnail_url' => $id ? "/api/files/{$id}/thumbnail{$ctx}" : null,
            'preview_url'   => $id ? "/api/files/{$id}/preview{$ctx}" : null,
            'extension' => strtolower(pathinfo($f['name'] ?? '', PATHINFO_EXTENSION)),
            'share_link' => !empty($f['sharelink']) ? $this->normalizeShareLink($f['sharelink'] + ['file_id' => $id]) : null,
        ];
    }

    private function normalizeShareLink(array $sl): array
    {
        return [
            'url'            => $sl['url'] ?? null,
            'file_id'        => isset($sl['file_id']) ? (string) $sl['file_id'] : null,
            'right'          => $sl['right'] ?? 'inherit',
            'valid_until'    => $sl['valid_until'] ?? null,
            'created_at'     => $sl['created_at'] ?? null,
            'updated_at'     => $sl['updated_at'] ?? null,
            'access_blocked' => $sl['access_blocked'] ?? false,
            'views'          => $sl['views'] ?? null,
            // Passed through as-is: the exact sub-fields aren't fully
            // documented, so the frontend reads whichever can_* keys exist.
            'capabilities'   => $sl['capabilities'] ?? [],
        ];
    }

    private function buildTree(array $items, string $rootId): array
    {
        $map = [];
        foreach ($items as $item) {
            if (($item['type'] ?? '') === 'dir') {
                $map[(string) $item['id']] = [
                    'id' => (string) $item['id'],
                    'name' => $item['name'],
                    'parent_id' => (string) ($item['parent_id'] ?? $rootId),
                    'children' => [],
                ];
            }
        }

        $root = ['id' => $rootId, 'name' => 'My Drive', 'children' => []];
        foreach ($map as $id => $node) {
            $parentId = $node['parent_id'];
            if (isset($map[$parentId])) {
                $map[$parentId]['children'][] = &$map[$id];
            } else {
                $root['children'][] = &$map[$id];
            }
        }

        return $root;
    }
}
