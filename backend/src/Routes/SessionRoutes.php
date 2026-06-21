<?php declare(strict_types=1);

namespace DriveSurfe\Routes;

use DI\Container;
use DriveSurfe\Middleware\AuthMiddleware;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\Routing\RouteCollectorProxy;

final class SessionRoutes
{
    private const SESSIONS_FILE = __DIR__ . '/../../sessions.json';

    private AuthMiddleware $auth;

    public function __construct(private readonly Container $container)
    {
        $this->auth = $container->get(AuthMiddleware::class);
    }

    public function register(RouteCollectorProxy $group): void
    {
        $auth = $this->auth;

        $group->get('/sessions', function (Request $req, Response $res): Response {
            return self::json($res, self::load());
        })->add($auth);

        $group->post('/sessions', function (Request $req, Response $res): Response {
            $body = (array) $req->getParsedBody();
            $folderId = (string) ($body['folder_id'] ?? '');
            $sessions = array_values(array_filter(self::load(), fn($s) => $s['folder_id'] !== $folderId));
            $sessions[] = [
                'id'            => bin2hex(random_bytes(8)),
                'file_id'       => (string) ($body['file_id'] ?? ''),
                'file_name'     => (string) ($body['file_name'] ?? ''),
                'folder_id'     => $folderId,
                'folder_name'   => (string) ($body['folder_name'] ?? ''),
                'thumbnail_url' => $body['thumbnail_url'] ?? null,
                'saved_at'      => (new \DateTime())->format(\DateTime::ATOM),
            ];
            self::save($sessions);
            return self::json($res, ['ok' => true]);
        })->add($auth);

        $group->delete('/sessions/{id}', function (Request $req, Response $res, array $args): Response {
            $sessions = array_values(array_filter(self::load(), fn($s) => $s['id'] !== $args['id']));
            self::save($sessions);
            return self::json($res, ['ok' => true]);
        })->add($auth);
    }

    private static function load(): array
    {
        $f = self::SESSIONS_FILE;
        if (!file_exists($f)) return [];
        return json_decode(file_get_contents($f), true) ?? [];
    }

    private static function save(array $sessions): void
    {
        $tmp = self::SESSIONS_FILE . '.tmp.' . bin2hex(random_bytes(4));
        file_put_contents($tmp, json_encode($sessions, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR), LOCK_EX);
        rename($tmp, self::SESSIONS_FILE);
    }

    private static function json(Response $response, mixed $data): Response
    {
        $response->getBody()->write(json_encode($data, JSON_THROW_ON_ERROR));
        return $response->withHeader('Content-Type', 'application/json');
    }
}
