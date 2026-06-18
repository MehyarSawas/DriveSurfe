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

    public function listFiles(string $folderId = '1', array $options = []): array
    {
        $driveId  = $this->getDriveId();
        $sortBy   = $options['sortBy'] ?? 'name';
        $sortDir  = $options['sortDir'] ?? 'asc';
        $files    = [];
        $cursor   = null;

        do {
            $params = [
                'order_by'  => $sortBy,
                'order_for' => [$sortBy => $sortDir],
                'with'      => 'is_favorite',
            ];
            if ($cursor) $params['cursor'] = $cursor;

            $data   = $this->get("{$driveId}/files/{$folderId}/files", $params, self::API_V3);
            $files  = array_merge($files, $data['data'] ?? []);
            $cursor = ($data['has_more'] ?? false) ? ($data['cursor'] ?? null) : null;
        } while ($cursor);

        return $this->normalizeFiles($files);
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
            $data   = $this->get("{$driveId}/files/1/files", $params, self::API_V3);
            $dirs   = array_merge($dirs, $data['data'] ?? []);
            $cursor = ($data['has_more'] ?? false) ? ($data['cursor'] ?? null) : null;
        } while ($cursor);

        return $this->buildTree($dirs, '1');
    }

    public function search(string $query): array
    {
        $driveId = $this->getDriveId();
        $data = $this->get("{$driveId}/files/search", ['query' => $query, 'per_page' => 100, 'with' => 'is_favorite']);
        return $this->normalizeFiles($data['data'] ?? []);
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
        return $this->normalizeFiles($data['data'] ?? []);
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

    public function proxyDownload(string $fileId): void
    {
        $driveId = $this->getDriveId();
        $token   = $this->getToken();

        $meta = $this->get("{$driveId}/files/{$fileId}");
        $name = rawurlencode($meta['data']['name'] ?? 'download');
        $mime = $meta['data']['mime_type'] ?? 'application/octet-stream';

        try {
            $response = $this->http->get(
                self::API_BASE . "/{$driveId}/files/{$fileId}/download",
                ['headers' => ['Authorization' => "Bearer {$token}"], 'stream' => true]
            );
        } catch (\GuzzleHttp\Exception\BadResponseException $e) {
            http_response_code($e->getResponse()->getStatusCode());
            exit;
        }

        header("Content-Type: {$mime}");
        header("Content-Disposition: inline; filename*=UTF-8''{$name}");
        header("Accept-Ranges: bytes");
        if ($len = $response->getHeaderLine('Content-Length')) {
            header("Content-Length: {$len}");
        }
        header("Cache-Control: private, max-age=3600");

        $body = $response->getBody();
        while (!$body->eof()) {
            echo $body->read(65536);
        }
    }

    public function proxyFile(string $fileId, string $type = 'thumbnail'): void
    {
        $driveId = $this->getDriveId();
        $token = $this->getToken();
        $url = self::API_BASE . "/{$driveId}/files/{$fileId}/{$type}";

        try {
            $response = $this->http->get($url, [
                'headers' => ['Authorization' => "Bearer {$token}"],
                'stream' => true,
            ]);
        } catch (\GuzzleHttp\Exception\BadResponseException $e) {
            http_response_code($e->getResponse()->getStatusCode());
            exit;
        }

        $contentType = $response->getHeaderLine('Content-Type') ?: 'application/octet-stream';
        header("Content-Type: {$contentType}");
        header("Cache-Control: private, max-age=3600");

        $body = $response->getBody();
        while (!$body->eof()) {
            echo $body->read(8192);
        }
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
            $data = json_decode((string) $response->getBody(), true, 512, JSON_THROW_ON_ERROR);
            if (($data['result'] ?? '') === 'error') {
                throw new RuntimeException('kDrive: ' . json_encode($data['error'] ?? 'unknown'));
            }
            return $data;
        } catch (GuzzleException $e) {
            throw new RuntimeException("kDrive API error: " . $e->getMessage(), 0, $e);
        }
    }

    private function post(string $path, array $body = []): array
    {
        $token = $this->getToken();
        try {
            $response = $this->http->post(self::API_BASE . "/{$path}", [
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

    private function normalizeFiles(array $files): array
    {
        return array_map(fn($f) => $this->normalizeFile($f), $files);
    }

    private function normalizeFile(array $f): array
    {
        return [
            'id' => (string) ($f['id'] ?? ''),
            'name' => $f['name'] ?? '',
            'type' => $f['type'] ?? 'file',
            'mime_type' => $f['mime_type'] ?? '',
            'size' => $f['size'] ?? 0,
            'modified_at' => $f['last_modified_at'] ?? $f['created_at'] ?? null,
            'created_at' => $f['created_at'] ?? null,
            'is_dir' => ($f['type'] ?? '') === 'dir',
            'is_favorite' => $f['is_favorite'] ?? false,
            'parent_id' => (string) ($f['parent_id'] ?? '1'),
            'thumbnail_url' => isset($f['id']) ? "/api/files/{$f['id']}/thumbnail" : null,
            'preview_url' => isset($f['id']) ? "/api/files/{$f['id']}/preview" : null,
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
