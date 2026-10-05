<?php declare(strict_types=1);

namespace DriveSurfe\Mail;

/**
 * Normalized inbound email. Built from the (already signature-verified)
 * webhook payload — but every field is still treated as hostile input:
 * anyone on the internet can send the owner an email, so subject, sender
 * and attachment names are attacker-controlled even when the webhook
 * caller itself is trusted.
 */
final class Email
{
    private const MAX_ATTACHMENTS  = 50;
    private const MAX_SUBJECT      = 1000;
    private const MAX_BODY         = 1_000_000;
    private const MAX_RECIPIENTS   = 200;
    private const MAX_LABELS       = 100;
    private const MAX_NAME         = 255;

    /**
     * @param array{address:string,name:string} $from
     * @param list<array{address:string,name:string}> $to
     * @param list<array{address:string,name:string}> $cc
     * @param list<string> $labels
     * @param list<Attachment> $attachments
     */
    public function __construct(
        public readonly string $id,
        public readonly string $threadId,
        public readonly array $from,
        public readonly array $to,
        public readonly array $cc,
        public readonly string $subject,
        public readonly string $bodyText,
        public readonly \DateTimeImmutable $date,
        public readonly array $labels,
        public readonly array $attachments,
    ) {}

    /** @throws \InvalidArgumentException on any malformed field */
    public static function fromPayload(array $p): self
    {
        $id = self::str($p['id'] ?? '', 128);
        if (!preg_match('/^[A-Za-z0-9_\-.]{1,128}$/', $id)) {
            throw new \InvalidArgumentException('Invalid or missing message id');
        }
        $threadId = self::str($p['thread_id'] ?? '', 128);
        if ($threadId !== '' && !preg_match('/^[A-Za-z0-9_\-.]{1,128}$/', $threadId)) {
            throw new \InvalidArgumentException('Invalid thread id');
        }

        $from = self::parseAddresses($p['from'] ?? '')[0] ?? null;
        if ($from === null) {
            throw new \InvalidArgumentException('Missing sender');
        }

        try {
            $date = new \DateTimeImmutable(self::str($p['date'] ?? 'now', 64));
        } catch (\Exception) {
            throw new \InvalidArgumentException('Invalid date');
        }
        $tz = $_ENV['APP_TIMEZONE'] ?? '';
        if ($tz !== '') {
            try { $date = $date->setTimezone(new \DateTimeZone($tz)); } catch (\Exception) { /* bad env value — keep sender's offset */ }
        }

        $labels = [];
        foreach (array_slice(self::list($p['labels'] ?? []), 0, self::MAX_LABELS) as $l) {
            $l = self::str($l, self::MAX_NAME);
            if ($l !== '') $labels[] = $l;
        }

        $rawAttachments = self::list($p['attachments'] ?? []);
        if (count($rawAttachments) > self::MAX_ATTACHMENTS) {
            throw new \InvalidArgumentException('Too many attachments');
        }
        $attachments = [];
        foreach ($rawAttachments as $a) {
            if (!is_array($a)) throw new \InvalidArgumentException('Invalid attachment');
            $b64 = $a['content_base64'] ?? '';
            if (!is_string($b64) || ($b64 !== '' && !preg_match('/^[A-Za-z0-9+\/]*={0,2}$/', $b64))) {
                throw new \InvalidArgumentException('Invalid attachment content');
            }
            $name = self::fileName(self::str($a['name'] ?? '', 1000));
            $mime = strtolower(self::str($a['mime_type'] ?? '', 255));
            if (!preg_match('/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/', $mime)) {
                $mime = 'application/octet-stream';
            }
            // Size is derived from the content, never trusted from the payload.
            $size = $b64 === '' ? 0 : intdiv(strlen($b64), 4) * 3 - substr_count(substr($b64, -2), '=');
            $attachments[] = new Attachment($name, $mime, $size, (bool) ($a['inline'] ?? false), $b64);
        }

        return new self(
            id: $id,
            threadId: $threadId,
            from: $from,
            to: array_slice(self::parseAddresses($p['to'] ?? ''), 0, self::MAX_RECIPIENTS),
            cc: array_slice(self::parseAddresses($p['cc'] ?? ''), 0, self::MAX_RECIPIENTS),
            subject: self::str($p['subject'] ?? '', self::MAX_SUBJECT),
            bodyText: self::str($p['body_text'] ?? '', self::MAX_BODY, keepNewlines: true),
            date: $date,
            labels: $labels,
            attachments: $attachments,
        );
    }

    /** Lightweight view for logs and the API — never includes body or file content. */
    public function summary(): array
    {
        return [
            'id'          => $this->id,
            'from'        => $this->from['address'],
            'subject'     => mb_substr($this->subject, 0, 200),
            'date'        => $this->date->format(\DateTimeInterface::ATOM),
            'attachments' => array_map(fn(Attachment $a) => ['name' => $a->name, 'size' => $a->size], $this->attachments),
        ];
    }

    public function senderDomain(): string
    {
        $at = strrpos($this->from['address'], '@');
        return $at === false ? '' : substr($this->from['address'], $at + 1);
    }

    public function senderUser(): string
    {
        $at = strrpos($this->from['address'], '@');
        return $at === false ? $this->from['address'] : substr($this->from['address'], 0, $at);
    }

    /**
     * Accepts `"Name" <a@b.c>, other@d.e` strings or arrays of such strings.
     * @return list<array{address:string,name:string}>
     */
    private static function parseAddresses(mixed $value): array
    {
        $parts = [];
        foreach (is_array($value) ? $value : [$value] as $v) {
            if (!is_string($v)) continue;
            $v = self::str($v, 20_000);
            // Split on commas that aren't inside quotes or <...>.
            $buf = ''; $inQuote = false; $inAngle = false;
            $len = strlen($v);
            for ($i = 0; $i < $len; $i++) {
                $c = $v[$i];
                if ($c === '"' && !$inAngle) $inQuote = !$inQuote;
                elseif ($c === '<' && !$inQuote) $inAngle = true;
                elseif ($c === '>' && !$inQuote) $inAngle = false;
                if ($c === ',' && !$inQuote && !$inAngle) { $parts[] = $buf; $buf = ''; continue; }
                $buf .= $c;
            }
            $parts[] = $buf;
        }

        $out = [];
        foreach ($parts as $part) {
            $part = trim($part);
            if ($part === '') continue;
            if (preg_match('/^(.*)<([^<>]+)>\s*$/s', $part, $m)) {
                $name = trim($m[1], " \t\"'");
                $addr = trim($m[2]);
            } else {
                $name = '';
                $addr = trim($part, " \t\"'");
            }
            $addr = mb_strtolower($addr);
            if (!preg_match('/^[^\s@<>"]{1,128}@[^\s@<>"]{1,255}$/', $addr)) continue;
            $out[] = ['address' => $addr, 'name' => mb_substr($name, 0, self::MAX_NAME)];
        }
        return $out;
    }

    /** Strip path components and control characters from an attachment name. */
    private static function fileName(string $name): string
    {
        $name = str_replace('\\', '/', $name);
        $name = basename($name);
        $name = trim(preg_replace('/[\x00-\x1F\x7F]+/u', '', $name) ?? '', " .");
        if ($name === '') $name = 'attachment';
        if (mb_strlen($name) > 200) {
            $ext  = pathinfo($name, PATHINFO_EXTENSION);
            $keep = 200 - ($ext === '' ? 0 : mb_strlen($ext) + 1);
            $name = mb_substr($name, 0, $keep) . ($ext === '' ? '' : ".{$ext}");
        }
        return $name;
    }

    private static function str(mixed $v, int $max, bool $keepNewlines = false): string
    {
        if (!is_string($v) && !is_int($v) && !is_float($v)) return '';
        $s = (string) $v;
        if (!mb_check_encoding($s, 'UTF-8')) {
            $s = mb_convert_encoding($s, 'UTF-8', 'UTF-8');
        }
        $s = $keepNewlines
            ? (preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', '', $s) ?? '')
            : (preg_replace('/[\x00-\x1F\x7F]+/u', ' ', $s) ?? '');
        return mb_substr(trim($s), 0, $max);
    }

    private static function list(mixed $v): array
    {
        return is_array($v) ? array_values($v) : [];
    }
}
