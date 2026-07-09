<?php declare(strict_types=1);

namespace DriveSurfe\Routes;

use DI\Container;
use DriveSurfe\Drive\KDrive\KDriveClient;
use DriveSurfe\Middleware\AuthMiddleware;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\Routing\RouteCollectorProxy;

final class ShareRoutes
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

        $group->get('/shares', function (Request $req, Response $res) use ($drive): Response {
            return self::json($res, ['data' => $drive->listShareLinks()]);
        })->add($auth);

        $group->get('/files/{id}/share', function (Request $req, Response $res, array $args) use ($drive): Response {
            if (!self::validFileId($args['id'])) return self::fileIdError($res);
            return self::json($res, ['data' => $drive->getShareLink($args['id'])]);
        })->add($auth);

        $group->post('/files/{id}/share', function (Request $req, Response $res, array $args) use ($drive): Response {
            if (!self::validFileId($args['id'])) return self::fileIdError($res);
            $body = (array) $req->getParsedBody();
            $options = self::extractShareOptions($body);
            $options['right'] = in_array($body['right'] ?? '', ['inherit', 'password', 'public'], true)
                ? $body['right']
                : 'public';
            return self::json($res, ['data' => $drive->createShareLink($args['id'], $options)]);
        })->add($auth);

        $group->put('/files/{id}/share', function (Request $req, Response $res, array $args) use ($drive): Response {
            if (!self::validFileId($args['id'])) return self::fileIdError($res);
            $body    = (array) $req->getParsedBody();
            $options = self::extractShareOptions($body);
            if (in_array($body['right'] ?? '', ['inherit', 'password', 'public'], true)) {
                $options['right'] = $body['right'];
            }
            return self::json($res, ['data' => $drive->updateShareLink($args['id'], $options)]);
        })->add($auth);

        $group->delete('/files/{id}/share', function (Request $req, Response $res, array $args) use ($drive): Response {
            if (!self::validFileId($args['id'])) return self::fileIdError($res);
            return self::json($res, ['data' => $drive->deleteShareLink($args['id'])]);
        })->add($auth);
    }

    private static function extractShareOptions(array $body): array
    {
        $options = [];
        foreach (['can_comment', 'can_download', 'can_edit', 'can_request_access', 'can_see_info', 'can_see_stats'] as $key) {
            if (isset($body[$key])) $options[$key] = (bool) $body[$key];
        }
        if (!empty($body['password'])) {
            $options['password'] = (string) $body['password'];
        }
        if (isset($body['valid_until']) && $body['valid_until'] !== null && $body['valid_until'] !== '') {
            $options['valid_until'] = (int) $body['valid_until'];
        }
        return $options;
    }

    private static function json(Response $response, array $data): Response
    {
        $response->getBody()->write(json_encode($data, JSON_THROW_ON_ERROR));
        return $response->withHeader('Content-Type', 'application/json');
    }
}
