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
    public function listMedia(?string $cursor = null, ?int $after = null, ?int $before = null): array
    {
        $driveId = $this->getDriveId();
        $params = [
            'order_by' => 'last_modified_at',
            'order'    => 'desc',
            // Max page size — Infomaniak rate-limits ~60 req/min per token,
            // so fewer/larger pages beat many small ones.
            'limit'    => 1000,
            'depth'    => 'unlimited',
            'with'     => 'is_favorite',
            'type'     => 'file',
        ];
        // kDrive date filtering, exactly as Infomaniak's own Android app sends
        // it: modified_at=custom&modified_after=X&modified_before=Y
        if ($after !== null || $before !== null) {
            $params['modified_at'] = 'custom';
            if ($after !== null)  $params['modified_after']  = $after;
            if ($before !== null) $params['modified_before'] = $before;
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

    private static function isMediaFile(array $f): bool
    {
        static $mediaExt = ['jpg','jpeg','png','gif','webp','heic','heif','avif','mp4','mov','m4v','webm','avi','mkv'];
        return str_starts_with($f['mime_type'], 'image/')
            || str_starts_with($f['mime_type'], 'video/')
            || in_array($f['extension'], $mediaExt, true);
    }

    /** Unix seconds of the oldest file on the drive (null if empty). Clamped to
     *  year 2000 as a guard against corrupt epoch-adjacent timestamps.
     *  Retries once after a pause on 429 (Infomaniak limits ~60 req/min). */
    public function getOldestMediaDate(): ?int
    {
        $driveId = $this->getDriveId();
        $params = [
            'order_by' => 'last_modified_at',
            'order'    => 'asc',
            'limit'    => 5, // kDrive enforces a minimum limit of 5
            'depth'    => 'unlimited',
            'type'     => 'file',
        ];
        // get() itself honors retry_after on 429s
        $data = $this->get("{$driveId}/files/search", $params, self::API_V3);
        $first = $data['data'][0] ?? null;
        if (!$first) return null;
        $ts = (int) ($first['last_modified_at'] ?? $first['created_at'] ?? 0);
        if ($ts <= 0) return null;
        return max($ts, 946684800); // clamp to 2000-01-01
    }

    /**
     * Month covers for the timeline. Infomaniak rate-limits ~60 requests/min
     * per token, so probing per-month (120+ calls) is not viable — instead we
     * probe per-YEAR with limit=1000 (the API max): one response carries up to
     * a year of newest-first files, from which every month of that year and
     * its newest-media cover are derived. A 10-year drive costs ~11 requests.
     * Years with >1000 files may miss their oldest months (accepted tradeoff).
     */
    private const MONTHS_CACHE_FILE = __DIR__ . '/../../../cache/media_months.json';
    private const MONTHS_CACHE_TTL  = 900; // 15 min — probes cost ~1 request per year of history

    public function listMediaMonths(bool $debug = false): array
    {
        // Serve from cache when fresh — protects the ~1000 req/hour API quota
        // from repeated probing across page reloads.
        if (!$debug && is_file(self::MONTHS_CACHE_FILE)
            && time() - (int) filemtime(self::MONTHS_CACHE_FILE) < self::MONTHS_CACHE_TTL) {
            $cached = json_decode((string) file_get_contents(self::MONTHS_CACHE_FILE), true);
            if (is_array($cached)) return $cached;
        }

        $driveId = $this->getDriveId();
        $token   = $this->getToken();
        $diag    = ['oldest' => null, 'years' => 0, 'fulfilled' => 0, 'rejected' => [], 'samples' => []];
        $oldest  = $this->getOldestMediaDate();
        $diag['oldest'] = $oldest !== null ? date('c', $oldest) : null;
        if ($oldest === null) return $debug ? ['months' => [], 'debug' => $diag] : [];

        $years = [];
        for ($y = (int) date('Y'); $y >= (int) date('Y', $oldest) && count($years) < 30; $y--) {
            $years[] = [
                'year'   => $y,
                'after'  => mktime(0, 0, 0, 1, 1, $y),
                'before' => mktime(23, 59, 59, 12, 31, $y),
            ];
        }
        $diag['years'] = count($years);

        $responses = [];
        $rejected  = [];
        $makeRequests = function () use ($years, $driveId, $token) {
            foreach ($years as $i => $r) {
                yield $i => fn() => $this->http->getAsync(
                    self::API_V3 . "/{$driveId}/files/search",
                    [
                        'headers' => ['Authorization' => "Bearer {$token}"],
                        'query' => [
                            'order_by'        => 'last_modified_at',
                            'order'           => 'desc',
                            'limit'           => 1000,
                            'depth'           => 'unlimited',
                            'type'            => 'file',
                            // Exactly as Infomaniak's Android app sends it
                            'modified_at'     => 'custom',
                            'modified_after'  => $r['after'],
                            'modified_before' => $r['before'],
                        ],
                    ]
                );
            }
        };
        $pool = new \GuzzleHttp\Pool($this->http, $makeRequests(), [
            'concurrency' => 3,
            'fulfilled'   => function ($response, $i) use (&$responses) { $responses[$i] = $response; },
            'rejected'    => function ($reason, $i) use (&$rejected) {
                $msg = $reason instanceof \Throwable ? $reason->getMessage() : (string) $reason;
                // Guzzle truncates response bodies in messages — append the full
                // upstream error so validation failures (422) are diagnosable.
                if ($reason instanceof \GuzzleHttp\Exception\BadResponseException) {
                    $msg .= ' | body: ' . substr((string) $reason->getResponse()->getBody(), 0, 500);
                }
                $rejected[$i] = substr($msg, 0, 900);
            },
        ]);
        $pool->promise()->wait();
        $diag['fulfilled'] = count($responses);
        $diag['rejected']  = array_slice($rejected, 0, 3, true);

        $months = [];
        foreach ($years as $i => $r) {
            if (!isset($responses[$i])) continue;
            try {
                $data = json_decode((string) $responses[$i]->getBody(), true, 512, JSON_THROW_ON_ERROR);
            } catch (\JsonException) {
                continue;
            }
            if ($debug && count($diag['samples']) < 2) {
                $raw = array_slice($data['data'] ?? [], 0, 2);
                $diag['samples'][] = [
                    'year'   => $r['year'],
                    'result' => $data['result'] ?? null,
                    'count'  => count($data['data'] ?? []),
                    'items'  => array_map(fn($x) => [
                        'name' => $x['name'] ?? null,
                        'mime' => $x['mime_type'] ?? null,
                        'last_modified_at' => $x['last_modified_at'] ?? null,
                    ], $raw),
                ];
            }
            $seen = [];
            foreach ($this->normalizeFiles($data['data'] ?? []) as $f) {
                if (!self::isMediaFile($f)) continue;
                $ts = $f['modified_at'] ? strtotime($f['modified_at']) : false;
                // Guard: only trust files whose date falls inside the probed year
                if ($ts === false || $ts < $r['after'] || $ts > $r['before']) continue;
                $key = date('Y-m', $ts);
                if (isset($seen[$key])) continue;
                $seen[$key] = true;
                $months[] = [
                    'key'   => $key,
                    'year'  => (int) substr($key, 0, 4),
                    'month' => (int) substr($key, 5, 2),
                    'cover' => $f,
                ];
            }
        }
        // Files arrive newest-first per year and years iterate desc, so
        // $months is already globally newest-first.
        if (!$debug && $months !== []) {
            @mkdir(dirname(self::MONTHS_CACHE_FILE), 0775, true);
            $tmp = self::MONTHS_CACHE_FILE . '.tmp.' . bin2hex(random_bytes(4));
            if (@file_put_contents($tmp, json_encode($months), LOCK_EX) !== false) {
                @rename($tmp, self::MONTHS_CACHE_FILE);
            }
        }
        return $debug ? ['months' => $months, 'debug' => $diag] : $months;
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

    public function listTrash(): array
    {
        $driveId = $this->getDriveId();
        $data = $this->get("{$driveId}/trash", ['per_page' => 100, 'with' => 'is_favorite']);
        return $this->normalizeFiles($data['data'] ?? [], true);
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
