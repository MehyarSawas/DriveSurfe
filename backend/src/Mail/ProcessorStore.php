<?php declare(strict_types=1);

namespace DriveSurfe\Mail;

use DriveSurfe\Mail\Processor\ProcessorRegistry;
use DriveSurfe\Service\JsonFile;

/**
 * Processor records, stored in `backend/mail_processors.json` (outside the
 * web root, gitignored). Array order is evaluation order.
 *
 * Record: {id, name, enabled, stop, processor, filter:{conditions:[...]}, settings:{...}, created_at, updated_at}
 */
final class ProcessorStore
{
    private const FILE = __DIR__ . '/../../mail_processors.json';
    private const MAX_PROCESSORS = 100;

    private JsonFile $file;

    public function __construct(private readonly ProcessorRegistry $registry)
    {
        $this->file = new JsonFile(self::FILE);
    }

    public function all(): array
    {
        return array_values($this->file->read());
    }

    public function find(string $id): ?array
    {
        foreach ($this->all() as $p) {
            if (($p['id'] ?? null) === $id) return $p;
        }
        return null;
    }

    /** @throws \InvalidArgumentException */
    public function create(array $input): array
    {
        $record = $this->normalize($input);
        $record['id']         = bin2hex(random_bytes(8));
        $record['created_at'] = $record['updated_at'];
        $this->file->update(function (array $all) use ($record) {
            if (count($all) >= self::MAX_PROCESSORS) {
                throw new \InvalidArgumentException('Too many processors (max ' . self::MAX_PROCESSORS . ')');
            }
            $all[] = $record;
            return array_values($all);
        });
        return $record;
    }

    /** @throws \InvalidArgumentException */
    public function update(string $id, array $input): ?array
    {
        $record = $this->normalize($input);
        $saved  = null;
        $this->file->update(function (array $all) use ($id, $record, &$saved) {
            foreach ($all as $i => $p) {
                if (($p['id'] ?? null) !== $id) continue;
                $saved = ['id' => $id, 'created_at' => $p['created_at'] ?? $record['updated_at']] + $record;
                $all[$i] = $saved;
            }
            return array_values($all);
        });
        return $saved;
    }

    public function delete(string $id): void
    {
        $this->file->update(fn(array $all) => array_values(array_filter($all, fn($p) => ($p['id'] ?? null) !== $id)));
    }

    /** Reorder by a list of ids; unknown ids are ignored, missing ones keep their relative order at the end. */
    public function reorder(array $ids): array
    {
        $ids = array_values(array_filter($ids, 'is_string'));
        return $this->file->update(function (array $all) use ($ids) {
            usort($all, function ($a, $b) use ($ids) {
                $ia = array_search($a['id'] ?? '', $ids, true);
                $ib = array_search($b['id'] ?? '', $ids, true);
                return ($ia === false ? PHP_INT_MAX : $ia) <=> ($ib === false ? PHP_INT_MAX : $ib);
            });
            return array_values($all);
        });
    }

    /**
     * Validate a record coming from the UI (also used for unsaved test runs).
     * @throws \InvalidArgumentException
     */
    public function normalize(array $in): array
    {
        $name = trim((string) ($in['name'] ?? ''));
        if ($name === '' || mb_strlen($name) > 100) {
            throw new \InvalidArgumentException('Name is required (max 100 characters)');
        }
        $key   = (string) ($in['processor'] ?? '');
        $class = $this->registry->classFor($key);
        if ($class === null) {
            throw new \InvalidArgumentException('Unknown processor type');
        }

        return [
            'name'       => $name,
            'enabled'    => (bool) ($in['enabled'] ?? true),
            'stop'       => (bool) ($in['stop'] ?? false),
            'processor'  => $key,
            'filter'     => FilterEvaluator::normalize($in['filter'] ?? []),
            'settings'   => $class::normalizeSettings(is_array($in['settings'] ?? null) ? $in['settings'] : []),
            'updated_at' => (new \DateTimeImmutable())->format(\DateTimeInterface::ATOM),
        ];
    }
}
