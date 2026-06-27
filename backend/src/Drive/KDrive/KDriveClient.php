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
            'query'    => $query,
            'limit'    => 1000,
            'with'     => 'is_favorite',
            'depth'    => 'unlimited',
            'order_by' => [$apiOrderBy],
            'order'    => $sortDir,
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

        return ['data' => $all, 'has_more' => false, 'cursor' => null];
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

    public function moveFile(string $fileId, string $destinationFolderId): void
    {
        $driveId = $this->getDriveId();
        // Response is a CancelResource {cancel_id, valid_until}, not file data
        $this->post("{$driveId}/files/{$fileId}/move/{$destinationFolderId}", ['conflict' => 'rename'], self::API_V3);
    }

    public function renameFile(string $fileId, string $name): array
    {
        $driveId = $this->getDriveId();
        $data = $this->post("{$driveId}/files/{$fileId}/rename", ['name' => $name]);
        return isset($data['data']) ? $this->normalizeFile($data['data']) : [];
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
            throw new RuntimeException("kDrive API error: " . $e->getMessage(), 0, $e);
        }
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
            throw new RuntimeException("kDrive API error: " . $e->getMessage(), 0, $e);
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
            throw new RuntimeException("kDrive API error: " . $e->getMessage(), 0, $e);
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
            throw new RuntimeException("kDrive API error: " . $e->getMessage(), 0, $e);
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
            'modified_at' => $f['last_modified_at'] ?? $f['created_at'] ?? null,
            'created_at' => $f['created_at'] ?? null,
            'is_dir' => ($f['type'] ?? '') === 'dir',
            'is_favorite' => $f['is_favorite'] ?? false,
            'parent_id' => (string) ($f['parent_id'] ?? '1'),
            'thumbnail_url' => $id ? "/api/files/{$id}/thumbnail{$ctx}" : null,
            'preview_url'   => $id ? "/api/files/{$id}/preview{$ctx}" : null,
            'extension' => strtolower(pathinfo($f['name'] ?? '', PATHINFO_EXTENSION)),
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
