<?php declare(strict_types=1);

namespace DriveSurfe\Routes;

use DI\Container;
use DriveSurfe\Middleware\AuthMiddleware;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\Routing\RouteCollectorProxy;

/**
 * Sidebar-pinned folders — stored server-side (flat file outside the web
 * root, like sessions.json) so pins are the same on every device.
 */
final class PinRoutes
{
    private const PINS_FILE = __DIR__ . '/../../pinned_folders.json';

    private AuthMiddleware $auth;

    public function __construct(private readonly Container $container)
    {
        $this->auth = $container->get(AuthMiddleware::class);
    }

    public function register(RouteCollectorProxy $group): void
    {
        $auth = $this->auth;

        $group->get('/pins', function (Request $req, Response $res): Response {
            return self::json($res, ['data' => self::load()]);
        })->add($auth);

        $group->post('/pins', function (Request $req, Response $res): Response {
            $body = (array) $req->getParsedBody();
            $id   = (string) ($body['id'] ?? '');
            $name = trim((string) ($body['name'] ?? ''));
            if (!preg_match('/^\d+$/', $id) || $name === '' || mb_strlen($name) > 255) {
                $res->getBody()->write(json_encode(['error' => 'Invalid pin'], JSON_THROW_ON_ERROR));
                return $res->withStatus(400)->withHeader('Content-Type', 'application/json');
            }
            $pins = array_values(array_filter(self::load(), fn($p) => $p['id'] !== $id));
            $pins[] = ['id' => $id, 'name' => $name];
            self::save($pins);
            return self::json($res, ['data' => $pins]);
        })->add($auth);

        $group->delete('/pins/{id}', function (Request $req, Response $res, array $args): Response {
            $pins = array_values(array_filter(self::load(), fn($p) => $p['id'] !== $args['id']));
            self::save($pins);
            return self::json($res, ['data' => $pins]);
        })->add($auth);
    }

    private static function load(): array
    {
        $f = self::PINS_FILE;
        if (!file_exists($f)) return [];
        $pins = json_decode((string) file_get_contents($f), true);
        return is_array($pins) ? $pins : [];
    }

    private static function save(array $pins): void
    {
        $tmp = self::PINS_FILE . '.tmp.' . bin2hex(random_bytes(4));
        file_put_contents($tmp, json_encode($pins, JSON_THROW_ON_ERROR), LOCK_EX);
        rename($tmp, self::PINS_FILE);
    }

    private static function json(Response $response, mixed $data): Response
    {
        $response->getBody()->write(json_encode($data, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE));
        return $response->withHeader('Content-Type', 'application/json');
    }
}
