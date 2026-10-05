<?php declare(strict_types=1);

namespace DriveSurfe\Mail;

use DriveSurfe\Mail\Processor\ProcessorRegistry;
use DriveSurfe\Service\JsonFile;

/**
 * Runs an email through the processor list: every enabled processor whose
 * filter matches is called, in list order, until one with `stop` set
 * matches. Real runs are recorded in `backend/mail_webhook_log.json`.
 */
final class MailPipeline
{
    private const LOG_FILE = __DIR__ . '/../../mail_webhook_log.json';
    private const LOG_MAX  = 100;

    public function __construct(
        private readonly ProcessorStore $store,
        private readonly ProcessorRegistry $registry,
    ) {}

    /**
     * @param list<array>|null $processors records to run (default: the saved list)
     * @param list<string> $skipIds processors that already succeeded for this email on an earlier delivery
     * @return list<array{processor_id:string,name:string,status:string,detail:string,files?:list<array>}>
     */
    public function run(Email $email, bool $dryRun = false, ?array $processors = null, array $skipIds = []): array
    {
        $results = [];
        foreach ($processors ?? $this->store->all() as $record) {
            if (empty($record['enabled']) && $processors === null) continue;
            if (!FilterEvaluator::matches($record['filter'] ?? [], $email)) continue;

            $id   = (string) ($record['id'] ?? '');
            $base = ['processor_id' => $id, 'name' => (string) ($record['name'] ?? '')];

            if ($id !== '' && in_array($id, $skipIds, true)) {
                $results[] = $base + ['status' => 'ok', 'detail' => 'Already processed on an earlier delivery'];
            } else {
                $processor = $this->registry->create((string) ($record['processor'] ?? ''));
                if ($processor === null) {
                    $results[] = $base + ['status' => 'error', 'detail' => 'Unknown processor type'];
                } else {
                    try {
                        $results[] = $base + $processor->process($email, $record['settings'] ?? [], $dryRun);
                    } catch (\Throwable $e) {
                        error_log("Mail processor {$id} failed: " . $e->getMessage());
                        $results[] = $base + ['status' => 'error', 'detail' => mb_substr($e->getMessage(), 0, 300)];
                    }
                }
            }

            if (!empty($record['stop'])) break;
        }

        if (!$dryRun) $this->log($email, $results);
        return $results;
    }

    public function recentLog(): array
    {
        return (new JsonFile(self::LOG_FILE))->read();
    }

    public function clearLog(): void
    {
        (new JsonFile(self::LOG_FILE))->update(fn() => []);
    }

    private function log(Email $email, array $results): void
    {
        $entry = [
            'at'      => (new \DateTimeImmutable())->format(\DateTimeInterface::ATOM),
            'email'   => $email->summary(),
            'results' => $results,
        ];
        (new JsonFile(self::LOG_FILE))->update(
            fn(array $log) => array_slice([$entry, ...$log], 0, self::LOG_MAX)
        );
    }
}
