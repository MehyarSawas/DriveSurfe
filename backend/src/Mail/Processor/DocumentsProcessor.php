<?php declare(strict_types=1);

namespace DriveSurfe\Mail\Processor;

use DriveSurfe\Drive\KDrive\KDriveClient;
use DriveSurfe\Mail\Attachment;
use DriveSurfe\Mail\Email;
use DriveSurfe\Mail\TemplateRenderer;

/**
 * Saves an email's attachments to a kDrive folder. The folder path and the
 * optional file name are templates (see TemplateRenderer); missing folders
 * are created. kDrive's `conflict=rename` keeps existing files untouched.
 */
final class DocumentsProcessor implements ProcessorInterface
{
    /** format key => [label, extensions] */
    private const FORMATS = [
        'pdf'  => ['PDF', ['pdf']],
        'doc'  => ['Word (doc, docx)', ['doc', 'docx', 'docm', 'dot', 'dotx']],
        'xls'  => ['Excel (xls, xlsx)', ['xls', 'xlsx', 'xlsm', 'xlt', 'xltx']],
        'ppt'  => ['PowerPoint (ppt, pptx)', ['ppt', 'pptx', 'pptm']],
        'odf'  => ['OpenDocument (odt, ods, odp)', ['odt', 'ods', 'odp', 'odg']],
        'csv'  => ['CSV', ['csv', 'tsv']],
        'txt'  => ['Text (txt, md, rtf)', ['txt', 'md', 'rtf']],
        'xml'  => ['XML / e-invoice', ['xml']],
        'jpg'  => ['JPEG', ['jpg', 'jpeg', 'jfif']],
        'png'  => ['PNG', ['png']],
        'heic' => ['HEIC / HEIF', ['heic', 'heif']],
        'gif'  => ['GIF', ['gif']],
        'webp' => ['WebP', ['webp']],
        'tif'  => ['TIFF', ['tif', 'tiff']],
        'zip'  => ['Archives (zip, 7z, rar)', ['zip', '7z', 'rar', 'gz', 'tar']],
        'eml'  => ['Emails (eml, msg)', ['eml', 'msg']],
        'ics'  => ['Calendar (ics)', ['ics']],
        'json' => ['JSON', ['json']],
    ];

    public function __construct(private readonly KDriveClient $drive) {}

    public static function key(): string { return 'documents'; }

    public static function label(): string { return 'Save attachments'; }

    public static function description(): string
    {
        return 'Uploads the email\'s attachments to a folder in your drive.';
    }

    public static function settingsSchema(): array
    {
        return [
            [
                'key' => 'base_folder', 'type' => 'folder', 'label' => 'Base folder',
                'default' => ['id' => '5', 'name' => 'My Drive'],
                'help' => 'The path below is created inside this folder.',
            ],
            [
                'key' => 'path', 'type' => 'template', 'label' => 'Folder path',
                'placeholder' => 'Documents/{email:sender_domain}/{date:YYYY}',
                'help' => 'Use / for subfolders. Missing folders are created. Empty = base folder.',
            ],
            [
                'key' => 'file_name', 'type' => 'template', 'label' => 'File name (optional)',
                'placeholder' => '{date:DD-MM-YYYY}.{file:extension}',
                'help' => 'Empty keeps the original name. With several attachments, (1), (2), … is appended unless the name uses {file:name}, {file:original} or {file:index}.',
            ],
            [
                'key' => 'formats', 'type' => 'multiselect', 'label' => 'File formats',
                'options' => array_map(
                    fn($k, $v) => ['value' => $k, 'label' => $v[0]],
                    array_keys(self::FORMATS), self::FORMATS
                ),
                'help' => 'Only attachments of these formats are saved. None selected = all formats.',
            ],
            [
                'key' => 'skip_inline', 'type' => 'checkbox', 'label' => 'Skip inline images (signatures, logos)',
                'default' => true,
            ],
        ];
    }

    public static function normalizeSettings(array $s): array
    {
        $folder   = is_array($s['base_folder'] ?? null) ? $s['base_folder'] : [];
        $folderId = (string) ($folder['id'] ?? '5');
        if (!preg_match('/^\d{1,20}$/', $folderId)) {
            throw new \InvalidArgumentException('Base folder is invalid');
        }
        $path     = trim((string) ($s['path'] ?? ''));
        $fileName = trim((string) ($s['file_name'] ?? ''));
        if (mb_strlen($path) > 500)     throw new \InvalidArgumentException('Folder path is too long');
        if (mb_strlen($fileName) > 255) throw new \InvalidArgumentException('File name is too long');

        $formats = array_values(array_unique(array_filter(
            array_map('strval', is_array($s['formats'] ?? null) ? $s['formats'] : []),
            fn($f) => isset(self::FORMATS[$f])
        )));

        return [
            'base_folder' => ['id' => $folderId, 'name' => mb_substr(trim((string) ($folder['name'] ?? '')), 0, 255) ?: ($folderId === '5' ? 'My Drive' : 'Folder')],
            'path'        => $path,
            'file_name'   => $fileName,
            'formats'     => $formats,
            'skip_inline' => (bool) ($s['skip_inline'] ?? true),
        ];
    }

    public function process(Email $email, array $settings, bool $dryRun = false): array
    {
        $settings = self::normalizeSettings($settings);
        $allowed  = [];
        foreach ($settings['formats'] as $f) $allowed = [...$allowed, ...self::FORMATS[$f][1]];

        $files = array_values(array_filter($email->attachments, function (Attachment $a) use ($settings, $allowed) {
            if ($settings['skip_inline'] && $a->inline) return false;
            return !$allowed || in_array($a->extension(), $allowed, true);
        }));
        if (!$files) {
            return ['status' => 'skipped', 'detail' => 'No matching attachments', 'files' => []];
        }

        $renderer = new TemplateRenderer($email);
        $segments = $renderer->renderPath($settings['path']);
        $pathText = rtrim($settings['base_folder']['name'] . '/' . implode('/', $segments), '/');

        $folderId = null;
        if (!$dryRun) {
            $folderId = $segments
                ? $this->drive->ensureFolderPath($settings['base_folder']['id'], $segments)
                : $settings['base_folder']['id'];
        }

        $results = [];
        $failed  = 0;
        // Suffix (1), (2), … only when the template would otherwise give every
        // attachment the same name — not when it already varies per file.
        $numbered = $settings['file_name'] !== '' && count($files) > 1
            && !preg_match('/\{file:(name|original|index)\}/', $settings['file_name']);
        foreach ($files as $i => $file) {
            $name = $this->targetName($renderer, $settings['file_name'], $file, $i + 1, $numbered);
            $entry = ['name' => $name, 'original' => $file->name, 'path' => $pathText, 'size' => $file->size];
            if (!$dryRun) {
                try {
                    if (!$file->hasContent()) throw new \RuntimeException('Attachment has no content');
                    $uploaded = $this->drive->uploadFile((string) $folderId, $name, $file->mimeType, $file->content());
                    $entry['id']   = $uploaded['id'] ?? null;
                    $entry['name'] = $uploaded['name'] ?? $name; // kDrive may have renamed on conflict
                } catch (\Throwable $e) {
                    $failed++;
                    $entry['error'] = mb_substr($e->getMessage(), 0, 300);
                }
            }
            $results[] = $entry;
        }

        $count = count($files);
        return [
            'status' => $failed === 0 ? 'ok' : 'error',
            'detail' => $dryRun
                ? "Would save {$count} file(s) to {$pathText}"
                : ($failed === 0
                    ? "Saved {$count} file(s) to {$pathText}"
                    : "{$failed} of {$count} upload(s) failed"),
            'files' => $results,
        ];
    }

    private function targetName(TemplateRenderer $r, string $template, Attachment $file, int $index, bool $numbered): string
    {
        if ($template === '') return $file->name;

        $name = $r->renderFileName($template, $file, $index);
        if ($name === '') return $file->name;

        // Keep the real extension so the file still opens — append it when
        // the template didn't produce it (e.g. "{date:YYYY-MM-DD}" alone).
        $ext = $file->extension();
        if ($ext !== '' && mb_strtolower(pathinfo($name, PATHINFO_EXTENSION)) !== $ext) {
            $name .= ".{$ext}";
        }
        if ($numbered) {
            $base = $ext === '' ? $name : mb_substr($name, 0, -(mb_strlen($ext) + 1));
            $name = "{$base} ({$index})" . ($ext === '' ? '' : ".{$ext}");
        }
        return $name;
    }
}
