<?php declare(strict_types=1);

namespace DriveSurfe\Mail;

/**
 * One email attachment. Content is kept base64-encoded until a processor
 * actually asks for it, so a multi-attachment email only has one decoded
 * file in memory at a time.
 */
final class Attachment
{
    public function __construct(
        public readonly string $name,
        public readonly string $mimeType,
        public readonly int $size,
        public readonly bool $inline,
        private readonly string $base64,
    ) {}

    public function extension(): string
    {
        return mb_strtolower(pathinfo($this->name, PATHINFO_EXTENSION));
    }

    /** File name without its extension. */
    public function baseName(): string
    {
        $ext = pathinfo($this->name, PATHINFO_EXTENSION);
        return $ext === '' ? $this->name : mb_substr($this->name, 0, -(mb_strlen($ext) + 1));
    }

    public function content(): string
    {
        $bin = base64_decode($this->base64, true);
        if ($bin === false) {
            throw new \InvalidArgumentException("Attachment \"{$this->name}\" is not valid base64");
        }
        return $bin;
    }

    public function hasContent(): bool
    {
        return $this->base64 !== '';
    }
}
