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

        $group->get('/files', function (Request $req, Response $res) use ($drive): Response {
            $params    = $req->getQueryParams();
            $folderId  = $params['folderId'] ?? '5';
            if ($folderId !== '5' && !self::validFileId($folderId)) {
                return self::fileIdError($res);
            }
            $allowedSortBy  = ['name', 'size', 'last_modified_at', 'created_at', 'type'];
            $allowedSortDir = ['asc', 'desc'];
            $sortBy  = in_array($params['sortBy']  ?? '', $allowedSortBy,  true) ? $params['sortBy']  : 'name';
            $sortDir = in_array($params['sortDir'] ?? '', $allowedSortDir, true) ? $params['sortDir'] : 'asc';
            $result = $drive->listFiles($folderId, [
                'sortBy'  => $sortBy,
                'sortDir' => $sortDir,
                'cursor'  => $params['cursor'] ?? null,
            ]);
            return self::json($res, [
                'data'     => $result['files'],
                'cursor'   => $result['cursor'],
                'has_more' => $result['has_more'],
            ]);
        })->add($auth);

        $group->get('/files/{id}', function (Request $req, Response $res, array $args) use ($drive): Response {
            if (!self::validFileId($args['id'])) return self::fileIdError($res);
            return self::json($res, ['data' => $drive->getFile($args['id'])]);
        })->add($auth);

        $group->get('/files/{id}/stats', function (Request $req, Response $res, array $args) use ($drive): Response {
            if (!self::validFileId($args['id'])) return self::fileIdError($res);
            $direct = $drive->getFolderCount($args['id'], 'folder');
            $total  = $drive->getFolderCount($args['id'], 'unlimited');
            $size   = $drive->getFolderSize($args['id']);
            return self::json($res, ['data' => [
                'count'             => $direct['count'],
                'files'             => $direct['files'],
                'directories'       => $direct['directories'],
                'total_count'       => $total['count'],
                'total_files'       => $total['files'],
                'total_directories' => $total['directories'],
                'size'              => $size,
            ]]);
        })->add($auth);

        $group->get('/files/{id}/thumbnail', function (Request $req, Response $res, array $args) use ($drive): Response {
            if (!self::validFileId($args['id'])) return self::fileIdError($res);
            $inTrash = ($req->getQueryParams()['context'] ?? '') === 'trash';
            $drive->proxyFile($args['id'], 'thumbnail', $inTrash);
            return $res;
        })->add($auth);

        $group->get('/files/{id}/preview', function (Request $req, Response $res, array $args) use ($drive): Response {
            if (!self::validFileId($args['id'])) return self::fileIdError($res);
            $params = $req->getQueryParams();
            $inTrash = ($params['context'] ?? '') === 'trash';
            $query = ['quality' => 90];
            foreach (['width', 'height'] as $k) {
                $v = (int) ($params[$k] ?? 0);
                if ($v >= 10 && $v <= 10000) $query[$k] = $v;
            }
            $drive->proxyFile($args['id'], 'preview', $inTrash, $query);
            return $res;
        })->add($auth);

        $group->get('/files/{id}/download', function (Request $req, Response $res, array $args) use ($drive): Response {
            if (!self::validFileId($args['id'])) return self::fileIdError($res);
            $drive->proxyDownload($args['id']);
            return $res;
        })->add($auth);

        $group->get('/folder-tree', function (Request $req, Response $res) use ($drive): Response {
            try {
                return self::json($res, ['data' => $drive->getFolderTree()]);
            } catch (\Throwable $e) {
                error_log('folder-tree error: ' . $e->getMessage());
                return self::json($res, ['data' => ['id' => '5', 'name' => 'My Drive', 'children' => []]]);
            }
        })->add($auth);

        $group->get('/search', function (Request $req, Response $res) use ($drive): Response {
            $params   = $req->getQueryParams();
            $query    = $params['q'] ?? '';
            $folderId = $params['folderId'] ?? null;
            $options  = [
                'sortBy'  => $params['sortBy']  ?? 'relevance',
                'sortDir' => $params['sortDir'] ?? 'desc',
                'cursor'  => $params['cursor']  ?? null,
            ];
            $result = $drive->search($query, $folderId, $options);
            return self::json($res, $result);
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
            if (!self::validFileId($args['id'])) return self::fileIdError($res);
            $drive->restoreFile($args['id']);
            return self::json($res, ['data' => true]);
        })->add($auth);

        $group->post('/files/{id}/move', function (Request $req, Response $res, array $args) use ($drive): Response {
            if (!self::validFileId($args['id'])) return self::fileIdError($res);
            $body   = (array) $req->getParsedBody();
            $destId   = $body['destination_folder_id'] ?? '';
            $strategy = in_array($body['strategy'] ?? '', ['override', 'skip'], true) ? $body['strategy'] : 'override';
            if (!self::validFileId($destId)) return self::fileIdError($res);
            $drive->moveFile($args['id'], $destId, $strategy);
            return self::json($res, ['data' => true]);
        })->add($auth);

        $group->post('/files/{id}/rename', function (Request $req, Response $res, array $args) use ($drive): Response {
            if (!self::validFileId($args['id'])) return self::fileIdError($res);
            $body = (array) $req->getParsedBody();
            $name = trim($body['name'] ?? '');
            if ($name === '' || mb_strlen($name) > 255) {
                $res->getBody()->write(json_encode(['error' => 'Invalid name'], JSON_THROW_ON_ERROR));
                return $res->withStatus(400)->withHeader('Content-Type', 'application/json');
            }
            return self::json($res, ['data' => $drive->renameFile($args['id'], $name)]);
        })->add($auth);
    }

    private static function json(Response $response, array $data): Response
    {
        $response->getBody()->write(json_encode($data, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE));
        return $response->withHeader('Content-Type', 'application/json');
    }
}
