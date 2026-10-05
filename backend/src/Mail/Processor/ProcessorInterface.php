<?php declare(strict_types=1);

namespace DriveSurfe\Mail\Processor;

use DriveSurfe\Mail\Email;

/**
 * A mail processor: runs against an inbound email once a processor record's
 * filter matches. Register new implementations in ProcessorRegistry::CLASSES.
 */
interface ProcessorInterface
{
    /** Stable key stored in processor records (never rename once in use). */
    public static function key(): string;

    public static function label(): string;

    public static function description(): string;

    /**
     * Settings fields for the UI. Each field:
     * `{key, type: text|template|folder|multiselect|checkbox, label, help?, placeholder?, default?, options?: [{value,label}], required?}`
     */
    public static function settingsSchema(): array;

    /**
     * Validate + normalize settings from the UI before they're saved.
     * @throws \InvalidArgumentException with a user-facing message
     */
    public static function normalizeSettings(array $settings): array;

    /**
     * @param bool $dryRun compute what would happen without side effects
     * @return array{status: 'ok'|'skipped'|'error', detail: string, files?: list<array>}
     */
    public function process(Email $email, array $settings, bool $dryRun = false): array;
}
