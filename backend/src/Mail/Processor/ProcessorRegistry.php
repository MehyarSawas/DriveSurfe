<?php declare(strict_types=1);

namespace DriveSurfe\Mail\Processor;

use Psr\Container\ContainerInterface;

final class ProcessorRegistry
{
    /** @var list<class-string<ProcessorInterface>> */
    private const CLASSES = [
        DocumentsProcessor::class,
    ];

    public function __construct(private readonly ContainerInterface $container) {}

    /** @return class-string<ProcessorInterface>|null */
    public function classFor(string $key): ?string
    {
        foreach (self::CLASSES as $class) {
            if ($class::key() === $key) return $class;
        }
        return null;
    }

    public function create(string $key): ?ProcessorInterface
    {
        $class = $this->classFor($key);
        return $class ? $this->container->get($class) : null;
    }

    /** Processor types + their settings schema, for the settings UI. */
    public function describe(): array
    {
        return array_map(fn(string $c) => [
            'key'         => $c::key(),
            'label'       => $c::label(),
            'description' => $c::description(),
            'settings'    => $c::settingsSchema(),
        ], self::CLASSES);
    }
}
