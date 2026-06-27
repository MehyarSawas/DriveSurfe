<?php declare(strict_types=1);

namespace DriveSurfe\Drive;

interface DriveInterface
{
    public function listFiles(string $folderId, array $options = []): array;

    public function getFile(string $fileId): array;

    public function getFolderTree(): array;

    public function search(string $query, ?string $folderId = null, array $options = []): array;

    public function thumbnailUrl(string $fileId): string;

    public function previewUrl(string $fileId): string;

    public function downloadStream(string $fileId): mixed;

    public function favorite(string $fileId): void;

    public function unfavorite(string $fileId): void;

    public function delete(string $fileId): void;

    public function listTrash(): array;

    public function getUsage(): array;

    public function getFolderCount(string $folderId, string $depth = 'folder'): array;

    public function getFolderSize(string $folderId): int;
}
