<?php declare(strict_types=1);

namespace DriveSurfe\Routes;

use DI\Container;
use DriveSurfe\Drive\KDrive\KDriveClient;
use DriveSurfe\Middleware\AuthMiddleware;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\Routing\RouteCollectorProxy;

final class ActionRoutes
{
    private KDriveClient $drive;
    private AuthMiddleware $auth;

    public function __construct(private readonly Container $container)
    {
        $this->drive = $container->get(KDriveClient::class);
        $this->auth = $container->get(AuthMiddleware::class);
    }

    private static function validFileId(string $id): bool
    {
        return (bool) preg_match('/^\d+$/', $id);
    }

    private static function fileIdError(Response $res): Response
    {
        $res->getBody()->write(json_encode(['error' => 'Invalid file ID'], JSON_THROW_ON_ERROR));
        return $res->withStatus(400)->withHeader('Content-Type', 'application/json');
    }

    public function register(RouteCollectorProxy $group): void
    {
        $drive = $this->drive;
        $auth  = $this->auth;

        $group->post('/files/{id}/favorite', function (Request $req, Response $res, array $args) use ($drive): Response {
            if (!self::validFileId($args['id'])) return self::fileIdError($res);
            $drive->favorite($args['id']);
            return self::json($res, ['ok' => true]);
        })->add($auth);

        $group->delete('/files/{id}/favorite', function (Request $req, Response $res, array $args) use ($drive): Response {
            if (!self::validFileId($args['id'])) return self::fileIdError($res);
            $drive->unfavorite($args['id']);
            return self::json($res, ['ok' => true]);
        })->add($auth);

        $group->delete('/files/{id}', function (Request $req, Response $res, array $args) use ($drive): Response {
            if (!self::validFileId($args['id'])) return self::fileIdError($res);
            $drive->delete($args['id']);
            return self::json($res, ['ok' => true]);
        })->add($auth);
    }

    private static function json(Response $response, array $data): Response
    {
        $response->getBody()->write(json_encode($data, JSON_THROW_ON_ERROR));
        return $response->withHeader('Content-Type', 'application/json');
    }
}
