<?php declare(strict_types=1);

namespace DriveSurfe\Service;

/**
 * Flat-file JSON store with an exclusive lock around read-modify-write, so
 * concurrent requests (e.g. two webhook deliveries arriving together) can't
 * lose each other's updates. Writes are atomic (tmp file + rename), like the
 * other flat-file stores in this app.
 */
final class JsonFile
{
    public function __construct(private readonly string $path) {}

    public function read(array $default = []): array
    {
        if (!is_file($this->path)) return $default;
        $data = json_decode((string) file_get_contents($this->path), true);
        return is_array($data) ? $data : $default;
    }

    /**
     * @param callable(array): array $fn receives the current contents, returns the new contents
     * @return array the new contents
     */
    public function update(callable $fn, array $default = []): array
    {
        $lock = fopen($this->path . '.lock', 'c');
        if ($lock === false) {
            throw new \RuntimeException('Cannot open lock file for ' . basename($this->path));
        }
        try {
            flock($lock, LOCK_EX);
            $data = $fn($this->read($default));
            $tmp  = $this->path . '.tmp.' . bin2hex(random_bytes(4));
            file_put_contents($tmp, json_encode($data, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), LOCK_EX);
            rename($tmp, $this->path);
            return $data;
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }
}
