<?php declare(strict_types=1);

namespace DriveSurfe\Routes;

use DI\Container;
use DriveSurfe\Drive\KDrive\KDriveClient;
use DriveSurfe\Middleware\AuthMiddleware;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\Routing\RouteCollectorProxy;

final class FileRoutes
{
    private KDriveClient $drive;
    private AuthMiddleware $auth;

    public function __construct(private readonly Container $container)
    {
        $this->drive = $container->get(KDriveClient::class);
        $this->auth = $container->get(AuthMiddleware::class);
    }

    public function register(RouteCollectorProxy $group): void
    {
        $drive = $this->drive;
        $auth  = $this->auth;

        $group->get('/debug-raw', function (Request $req, Response $res) use ($drive): Response {
            $raw = $drive->rawListFiles('1');
            return self::json($res, $raw);
        });

        $group->get('/files', function (Request $req, Response $res) use ($drive): Response {
            $params   = $req->getQueryParams();
            $folderId = $params['folderId'] ?? '1';
            $files    = $drive->listFiles($folderId, [
                'sortBy'  => $params['sortBy'] ?? 'name',
                'sortDir' => $params['sortDir'] ?? 'asc',
                'type'    => $params['type'] ?? null,
            ]);
            return self::json($res, ['data' => $files]);
        })->add($auth);

        $group->get('/files/{id}', function (Request $req, Response $res, array $args) use ($drive): Response {
            return self::json($res, ['data' => $drive->getFile($args['id'])]);
        })->add($auth);

        $group->get('/files/{id}/thumbnail', function (Request $req, Response $res, array $args) use ($drive): Response {
            $drive->proxyFile($args['id'], 'thumbnail');
            return $res;
        })->add($auth);

        $group->get('/files/{id}/preview', function (Request $req, Response $res, array $args) use ($drive): Response {
            $drive->proxyFile($args['id'], 'preview');
            return $res;
        })->add($auth);

        $group->get('/files/{id}/download', function (Request $req, Response $res, array $args) use ($drive): Response {
            $stream = $drive->downloadStream($args['id']);
            $file   = $drive->getFile($args['id']);
            $name   = rawurlencode($file['name'] ?? 'download');
            return $res
                ->withHeader('Content-Type', 'application/octet-stream')
                ->withHeader('Content-Disposition', "attachment; filename*=UTF-8''{$name}")
                ->withBody(new \Slim\Psr7\Stream($stream));
        })->add($auth);

        $group->get('/folder-tree', function (Request $req, Response $res) use ($drive): Response {
            return self::json($res, ['data' => $drive->getFolderTree()]);
        })->add($auth);

        $group->get('/search', function (Request $req, Response $res) use ($drive): Response {
            $query = $req->getQueryParams()['q'] ?? '';
            return self::json($res, ['data' => $drive->search($query)]);
        })->add($auth);

        $group->get('/trash', function (Request $req, Response $res) use ($drive): Response {
            return self::json($res, ['data' => $drive->listTrash()]);
        })->add($auth);

        $group->get('/usage', function (Request $req, Response $res) use ($drive): Response {
            return self::json($res, ['data' => $drive->getUsage()]);
        })->add($auth);
    }

    private static function json(Response $response, array $data): Response
    {
        $response->getBody()->write(json_encode($data, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE));
        return $response->withHeader('Content-Type', 'application/json');
    }
}
