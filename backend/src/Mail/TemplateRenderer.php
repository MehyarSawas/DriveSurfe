<?php declare(strict_types=1);

namespace DriveSurfe\Mail;

/**
 * Renders `{namespace:arg}` placeholders in processor path / file-name
 * templates, e.g. `Documents/{email:sender_domain}/{date:YYYY}` or
 * `{date:DD-MM-YYYY}.{file:extension}`.
 *
 * Substituted values come from the email (attacker-controlled), so each
 * value is sanitized to a single safe name component: a subject like
 * "../../x" or "a/b" can never add or escape path segments. Path templates
 * are split on "/" BEFORE substitution — only the owner's literal slashes
 * create folders.
 */
final class TemplateRenderer
{
    private const MAX_SEGMENTS    = 15;
    private const MAX_SEGMENT_LEN = 150;
    private const MAX_VALUE_LEN   = 100;
    private const MAX_FILE_LEN    = 200;

    /** Moment-style date tokens → PHP date() format characters. Longest first. */
    private const DATE_TOKENS = [
        'YYYY' => 'Y', 'YY' => 'y',
        'MMMM' => 'F', 'MMM' => 'M', 'MM' => 'm', 'M' => 'n',
        'DDDD' => 'z', 'DD' => 'd', 'D' => 'j',
        'dddd' => 'l', 'ddd' => 'D',
        'HH' => 'H', 'H' => 'G', 'hh' => 'h', 'h' => 'g',
        'mm' => 'i', 'ss' => 's', 'A' => 'A', 'a' => 'a',
        'WW' => 'W', 'Q' => '',
    ];

    public function __construct(private readonly Email $email) {}

    /** Variable reference for the settings UI. */
    public static function variables(): array
    {
        return [
            ['token' => '{email:subject}',       'description' => 'Subject'],
            ['token' => '{email:sender}',        'description' => 'Sender address'],
            ['token' => '{email:sender_name}',   'description' => 'Sender display name'],
            ['token' => '{email:sender_user}',   'description' => 'Sender address part before @'],
            ['token' => '{email:sender_domain}', 'description' => 'Sender domain'],
            ['token' => '{email:to}',            'description' => 'First recipient address'],
            ['token' => '{email:label}',         'description' => 'First Gmail label'],
            ['token' => '{email:id}',            'description' => 'Gmail message id'],
            ['token' => '{date:YYYY-MM-DD}',     'description' => 'Received date (YYYY YY MMMM MMM MM DD D dddd ddd HH hh mm ss A Q WW)'],
            ['token' => '{now:YYYY-MM-DD}',      'description' => 'Processing date'],
            ['token' => '{file:name}',           'description' => 'Attachment name without extension (file name only)'],
            ['token' => '{file:extension}',      'description' => 'Attachment extension (file name only)'],
            ['token' => '{file:original}',       'description' => 'Full attachment name (file name only)'],
            ['token' => '{file:index}',          'description' => 'Attachment number 1, 2, … (file name only)'],
        ];
    }

    /**
     * Render a folder path template into sanitized segments.
     * @return list<string>
     */
    public function renderPath(string $template): array
    {
        $segments = [];
        foreach (explode('/', str_replace('\\', '/', $template)) as $raw) {
            $seg = self::cleanName($this->render($raw), self::MAX_SEGMENT_LEN);
            if ($seg === '' || $seg === '.' || $seg === '..') continue;
            $segments[] = $seg;
            if (count($segments) >= self::MAX_SEGMENTS) break;
        }
        return $segments;
    }

    /** Render a file-name template for one attachment. Empty string if the template renders empty. */
    public function renderFileName(string $template, Attachment $file, int $index): string
    {
        $name = $this->render(str_replace(['/', '\\'], '-', $template), $file, $index);
        return self::cleanName($name, self::MAX_FILE_LEN);
    }

    private function render(string $template, ?Attachment $file = null, int $index = 0): string
    {
        return preg_replace_callback(
            '/\{(email|date|now|file):?([^{}]*)\}/u',
            function (array $m) use ($file, $index): string {
                [, $ns, $arg] = $m;
                $value = match ($ns) {
                    'email' => $this->emailValue($arg),
                    'date'  => self::formatDate($this->email->date, $arg),
                    'now'   => self::formatDate(new \DateTimeImmutable('now', $this->email->date->getTimezone()), $arg),
                    'file'  => $file ? match ($arg) {
                        'name'      => $file->baseName(),
                        'extension' => $file->extension(),
                        'original'  => $file->name,
                        'index'     => (string) $index,
                        default     => null,
                    } : null,
                };
                // Unknown variables are left visible so a typo is noticeable in the result.
                return $value === null ? $m[0] : self::cleanValue($value);
            },
            $template
        ) ?? $template;
    }

    private function emailValue(string $key): ?string
    {
        $e = $this->email;
        return match ($key) {
            'subject'       => $e->subject,
            'sender'        => $e->from['address'],
            'sender_name'   => $e->from['name'] !== '' ? $e->from['name'] : $e->senderUser(),
            'sender_user'   => $e->senderUser(),
            'sender_domain' => $e->senderDomain(),
            'to'            => $e->to[0]['address'] ?? '',
            'label'         => $e->labels[0] ?? '',
            'id'            => $e->id,
            default         => null,
        };
    }

    private static function formatDate(\DateTimeImmutable $date, string $format): string
    {
        if ($format === '') $format = 'YYYY-MM-DD';
        $tokens = implode('|', array_map('preg_quote', array_keys(self::DATE_TOKENS)));
        return preg_replace_callback(
            '/\[([^\]]*)\]|' . $tokens . '/',
            function (array $m) use ($date): string {
                if (isset($m[1]) && $m[0][0] === '[') return $m[1]; // [literal] escape, like moment.js
                if ($m[0] === 'Q') return (string) intdiv((int) $date->format('n') + 2, 3);
                return $date->format(self::DATE_TOKENS[$m[0]]);
            },
            $format
        ) ?? '';
    }

    /** A substituted value: no slashes, no reserved characters, bounded length. */
    private static function cleanValue(string $v): string
    {
        $v = preg_replace('/[\/\\\\:*?"<>|\x00-\x1F\x7F]+/u', '-', $v) ?? '';
        $v = preg_replace('/\s+/u', ' ', $v) ?? '';
        return mb_substr(trim($v, " .-"), 0, self::MAX_VALUE_LEN);
    }

    /** A final folder / file name component. */
    private static function cleanName(string $v, int $max): string
    {
        $v = preg_replace('/[\\\\:*?"<>|\x00-\x1F\x7F]+/u', '-', $v) ?? '';
        $v = preg_replace('/\s+/u', ' ', $v) ?? '';
        return trim(mb_substr(trim($v, " ."), 0, $max), " ");
    }
}
