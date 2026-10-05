<?php declare(strict_types=1);

namespace DriveSurfe\Routes;

use DI\Container;
use DriveSurfe\Mail\Email;
use DriveSurfe\Mail\FilterEvaluator;
use DriveSurfe\Mail\MailPipeline;
use DriveSurfe\Mail\Processor\ProcessorRegistry;
use DriveSurfe\Mail\ProcessorStore;
use DriveSurfe\Mail\TemplateRenderer;
use DriveSurfe\Mail\WebhookGuard;
use DriveSurfe\Middleware\AuthMiddleware;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\Routing\RouteCollectorProxy;

/**
 * Inbound email webhook (`POST /api/hooks/gmail`, HMAC-signed — see
 * WebhookGuard) plus the owner-only settings API for mail processors.
 */
final class MailRoutes
{
    private AuthMiddleware $auth;

    public function __construct(private readonly Container $container)
    {
        $this->auth = $container->get(AuthMiddleware::class);
    }

    public function register(RouteCollectorProxy $group): void
    {
        $auth      = $this->auth;
        $container = $this->container;

        // ── Webhook ────────────────────────────────────────────────────────
        // Unauthenticated by session; authenticated by signature instead.
        // Every rejection is deliberately terse — no detail for an attacker.
        $group->post('/hooks/gmail', function (Request $req, Response $res) use ($container): Response {
            if (WebhookGuard::secret() === null) {
                return self::json($res, ['error' => 'Not found'], 404);
            }
            /** @var WebhookGuard $guard */
            $guard = $container->get(WebhookGuard::class);
            $ip    = (string) ($req->getServerParams()['REMOTE_ADDR'] ?? 'unknown');

            if ($guard->isLockedOut($ip)) {
                return self::json($res, ['error' => 'Too many requests'], 429)->withHeader('Retry-After', '900');
            }
            if (!str_starts_with(strtolower($req->getHeaderLine('Content-Type')), 'application/json')) {
                return self::json($res, ['error' => 'Unsupported media type'], 415);
            }
            $max = WebhookGuard::maxBytes();
            if ((int) $req->getHeaderLine('Content-Length') > $max) {
                return self::json($res, ['error' => 'Payload too large'], 413);
            }

            // Body-parsing middleware already consumed the stream — rewind
            // to get the exact bytes that were signed.
            $stream = $req->getBody();
            $stream->rewind();
            $raw = $stream->getContents();
            if (strlen($raw) > $max) {
                return self::json($res, ['error' => 'Payload too large'], 413);
            }

            $signature = $req->getHeaderLine('X-DS-Signature');
            if (!$guard->verifySignature($raw, $req->getHeaderLine('X-DS-Timestamp'), $signature)) {
                $guard->recordFailure($ip);
                return self::json($res, ['error' => 'Unauthorized'], 401);
            }
            if (!$guard->consumeNonce($signature)) {
                return self::json($res, ['error' => 'Replayed request'], 409);
            }

            // ── Authenticated from here on ──
            $payload = $req->getParsedBody();
            if (!is_array($payload)) {
                try {
                    $payload = json_decode($raw, true, 64, JSON_THROW_ON_ERROR);
                } catch (\JsonException) {
                    $payload = null;
                }
            }
            unset($raw);
            if (!is_array($payload)) {
                return self::json($res, ['error' => 'Invalid JSON'], 400);
            }
            try {
                $email = Email::fromPayload($payload);
            } catch (\InvalidArgumentException $e) {
                return self::json($res, ['error' => $e->getMessage()], 422);
            }
            unset($payload);

            $claim = $guard->claim($email->id);
            if ($claim['state'] === 'done') {
                return self::json($res, ['status' => 'duplicate']);
            }
            if ($claim['state'] === 'processing') {
                return self::json($res, ['status' => 'in_progress'], 409);
            }
            if ($claim['state'] === 'gave_up') {
                // 200 so the sender stops retrying; the failures are in the log.
                return self::json($res, ['status' => 'gave_up']);
            }

            // Uploads can outlast the caller's HTTP timeout — finish anyway so
            // a half-processed email isn't left behind.
            ignore_user_abort(true);
            @set_time_limit(300);

            /** @var MailPipeline $pipeline */
            $pipeline = $container->get(MailPipeline::class);
            $doneIds  = $claim['done_ids'];
            $allOk    = true;
            try {
                $results = $pipeline->run($email, false, null, $doneIds);
                foreach ($results as $r) {
                    if ($r['status'] === 'error') $allOk = false;
                    elseif ($r['processor_id'] !== '') $doneIds[] = $r['processor_id'];
                }
            } catch (\Throwable $e) {
                error_log('Mail webhook failed: ' . $e->getMessage());
                $results = [];
                $allOk   = false;
            }
            $guard->finish($email->id, $allOk, $doneIds);

            $summary = array_map(fn($r) => [
                'processor' => $r['name'], 'status' => $r['status'], 'detail' => $r['detail'],
            ], $results);
            // Non-2xx on failure so the sender retries; already-succeeded
            // processors are skipped on the retry.
            return self::json($res, ['status' => $allOk ? 'processed' : 'failed', 'results' => $summary], $allOk ? 200 : 502);
        });

        // ── Settings API (owner only) ──────────────────────────────────────
        $group->get('/mail/meta', function (Request $req, Response $res) use ($container): Response {
            return self::json($res, ['data' => [
                'processors' => $container->get(ProcessorRegistry::class)->describe(),
                'filter'     => FilterEvaluator::describe(),
                'variables'  => TemplateRenderer::variables(),
                'webhook'    => [
                    'configured' => WebhookGuard::secret() !== null,
                    'path'       => '/api/hooks/gmail',
                    'max_mb'     => intdiv(WebhookGuard::maxBytes(), 1024 * 1024),
                ],
            ]]);
        })->add($auth);

        $group->get('/mail/processors', function (Request $req, Response $res) use ($container): Response {
            return self::json($res, ['data' => $container->get(ProcessorStore::class)->all()]);
        })->add($auth);

        $group->post('/mail/processors', function (Request $req, Response $res) use ($container): Response {
            try {
                $record = $container->get(ProcessorStore::class)->create((array) $req->getParsedBody());
            } catch (\InvalidArgumentException $e) {
                return self::json($res, ['error' => $e->getMessage()], 400);
            }
            return self::json($res, ['data' => $record], 201);
        })->add($auth);

        $group->post('/mail/processors/reorder', function (Request $req, Response $res) use ($container): Response {
            $ids = (array) (((array) $req->getParsedBody())['ids'] ?? []);
            return self::json($res, ['data' => $container->get(ProcessorStore::class)->reorder($ids)]);
        })->add($auth);

        $group->post('/mail/processors/test', function (Request $req, Response $res) use ($container): Response {
            $body = (array) $req->getParsedBody();
            try {
                $email = Email::fromPayload(['id' => 'test'] + (array) ($body['email'] ?? []));
                $records = null;
                if (isset($body['processor']) && is_array($body['processor'])) {
                    // Unsaved draft from the editor — validate it like a save would.
                    $records = [['id' => ''] + $container->get(ProcessorStore::class)->normalize($body['processor'])];
                }
            } catch (\InvalidArgumentException $e) {
                return self::json($res, ['error' => $e->getMessage()], 400);
            }
            $results = $container->get(MailPipeline::class)->run($email, true, $records);
            return self::json($res, ['data' => $results]);
        })->add($auth);

        $group->put('/mail/processors/{id}', function (Request $req, Response $res, array $args) use ($container): Response {
            if (!preg_match('/^[a-f0-9]{16}$/', $args['id'])) {
                return self::json($res, ['error' => 'Invalid processor ID'], 400);
            }
            try {
                $record = $container->get(ProcessorStore::class)->update($args['id'], (array) $req->getParsedBody());
            } catch (\InvalidArgumentException $e) {
                return self::json($res, ['error' => $e->getMessage()], 400);
            }
            return $record
                ? self::json($res, ['data' => $record])
                : self::json($res, ['error' => 'Processor not found'], 404);
        })->add($auth);

        $group->delete('/mail/processors/{id}', function (Request $req, Response $res, array $args) use ($container): Response {
            if (!preg_match('/^[a-f0-9]{16}$/', $args['id'])) {
                return self::json($res, ['error' => 'Invalid processor ID'], 400);
            }
            $container->get(ProcessorStore::class)->delete($args['id']);
            return self::json($res, ['ok' => true]);
        })->add($auth);

        $group->get('/mail/log', function (Request $req, Response $res) use ($container): Response {
            return self::json($res, ['data' => $container->get(MailPipeline::class)->recentLog()]);
        })->add($auth);

        $group->delete('/mail/log', function (Request $req, Response $res) use ($container): Response {
            $container->get(MailPipeline::class)->clearLog();
            return self::json($res, ['ok' => true]);
        })->add($auth);
    }

    private static function json(Response $response, mixed $data, int $status = 200): Response
    {
        $response->getBody()->write(json_encode($data, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
        return $response->withStatus($status)->withHeader('Content-Type', 'application/json');
    }
}
