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

        $group->get('/files', function (Request $req, Response $res) use ($drive): Response {
            $params = $req->getQueryParams();
            $result = $drive->listFiles($params['folderId'] ?? '5', [
                'sortBy'  => $params['sortBy']  ?? 'name',
                'sortDir' => $params['sortDir'] ?? 'asc',
                'cursor'  => $params['cursor']  ?? null,
            ]);
            return self::json($res, [
                'data'     => $result['files'],
                'cursor'   => $result['cursor'],
                'has_more' => $result['has_more'],
            ]);
        })->add($auth);

        $group->get('/files/{id}', function (Request $req, Response $res, array $args) use ($drive): Response {
            return self::json($res, ['data' => $drive->getFile($args['id'])]);
        })->add($auth);

        $group->get('/files/{id}/thumbnail', function (Request $req, Response $res, array $args) use ($drive): Response {
            $inTrash = ($req->getQueryParams()['context'] ?? '') === 'trash';
            $drive->proxyFile($args['id'], 'thumbnail', $inTrash);
            return $res;
        })->add($auth);

        $group->get('/files/{id}/preview', function (Request $req, Response $res, array $args) use ($drive): Response {
            $inTrash = ($req->getQueryParams()['context'] ?? '') === 'trash';
            $drive->proxyFile($args['id'], 'preview', $inTrash);
            return $res;
        })->add($auth);


        $group->get('/files/{id}/download', function (Request $req, Response $res, array $args) use ($drive): Response {
            $drive->proxyDownload($args['id']);
            return $res;
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

        $group->get('/favorites', function (Request $req, Response $res) use ($drive): Response {
            return self::json($res, ['data' => $drive->listFavorites()]);
        })->add($auth);

        $group->get('/usage', function (Request $req, Response $res) use ($drive): Response {
            return self::json($res, ['data' => $drive->getUsage()]);
        })->add($auth);

        $group->post('/folders', function (Request $req, Response $res) use ($drive): Response {
            $body     = (array) $req->getParsedBody();
            $parentId = $body['parent_id'] ?? '1';
            $name     = $body['name'] ?? 'New Folder';
            return self::json($res, ['data' => $drive->createFolder($parentId, $name)]);
        })->add($auth);

        $group->post('/files/{id}/restore', function (Request $req, Response $res, array $args) use ($drive): Response {
            $drive->restoreFile($args['id']);
            return self::json($res, ['data' => true]);
        })->add($auth);

        $group->post('/files/{id}/move', function (Request $req, Response $res, array $args) use ($drive): Response {
            $body   = (array) $req->getParsedBody();
            $destId = $body['destination_folder_id'] ?? '';
            $drive->moveFile($args['id'], $destId);
            return self::json($res, ['data' => true]);
        })->add($auth);

        $group->post('/files/{id}/rename', function (Request $req, Response $res, array $args) use ($drive): Response {
            $body = (array) $req->getParsedBody();
            $name = $body['name'] ?? '';
            return self::json($res, ['data' => $drive->renameFile($args['id'], $name)]);
        })->add($auth);
    }

    private static function json(Response $response, array $data): Response
    {
        $response->getBody()->write(json_encode($data, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE));
        return $response->withHeader('Content-Type', 'application/json');
    }
}
