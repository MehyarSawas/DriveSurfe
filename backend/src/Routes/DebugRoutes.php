<?php declare(strict_types=1);

namespace DriveSurfe\Routes;

use DI\Container;
use DriveSurfe\Middleware\AuthMiddleware;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\Routing\RouteCollectorProxy;

/**
 * Temporary diagnostic endpoint for the preview pinch-zoom investigation —
 * remove once that's resolved. Stores the single most recent debug capture
 * the frontend posts (overwritten on each POST, not appended) so it can be
 * pulled down from a desktop browser via the GET route instead of having to
 * move a file off a phone by hand. Body/shape is whatever the frontend sends
 * — this just persists and returns it verbatim, no validation.
 */
final class DebugRoutes
{
    private const LOG_FILE = __DIR__ . '/../../debug_log.json';

    private AuthMiddleware $auth;

    public function __construct(private readonly Container $container)
    {
        $this->auth = $container->get(AuthMiddleware::class);
    }

    public function register(RouteCollectorProxy $group): void
    {
        $auth = $this->auth;

        $group->post('/debug/log', function (Request $req, Response $res): Response {
            // The body-parsing middleware already consumed the raw stream for
            // a JSON content type (see Application's documented gotcha) — use
            // the parsed body, not getBody(), or this reads back empty.
            $body = json_encode($req->getParsedBody(), JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR);
            $tmp = self::LOG_FILE . '.tmp.' . bin2hex(random_bytes(4));
            file_put_contents($tmp, $body, LOCK_EX);
            rename($tmp, self::LOG_FILE);
            $res->getBody()->write(json_encode(['ok' => true]));
            return $res->withHeader('Content-Type', 'application/json');
        })->add($auth);

        $group->get('/debug/log', function (Request $req, Response $res): Response {
            if (!file_exists(self::LOG_FILE)) {
                return $res->withStatus(404);
            }
            $res->getBody()->write((string) file_get_contents(self::LOG_FILE));
            return $res
                ->withHeader('Content-Type', 'application/json')
                ->withHeader('Content-Disposition', 'attachment; filename="preview-debug-log.json"');
        })->add($auth);
    }
}
