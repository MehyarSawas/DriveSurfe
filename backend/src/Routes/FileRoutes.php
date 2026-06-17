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
        $auth = $this->auth;
        $self = $this;

        $group->group('', static function (RouteCollectorProxy $g) use ($self) {
            $g->get('/files', [$self, 'listFiles']);
            $g->get('/files/{id}', [$self, 'getFile']);
            $g->get('/files/{id}/thumbnail', [$self, 'thumbnail']);
            $g->get('/files/{id}/preview', [$self, 'preview']);
            $g->get('/files/{id}/download', [$self, 'download']);
            $g->get('/folder-tree', [$self, 'folderTree']);
            $g->get('/search', [$self, 'search']);
            $g->get('/trash', [$self, 'trash']);
            $g->get('/usage', [$self, 'usage']);
        })->add($auth);
    }

    public function listFiles(Request $request, Response $response): Response
    {
        $params = $request->getQueryParams();
        $folderId = $params['folderId'] ?? '1';
        $files = $this->drive->listFiles($folderId, [
            'sortBy' => $params['sortBy'] ?? 'name',
            'sortDir' => $params['sortDir'] ?? 'asc',
            'type' => $params['type'] ?? null,
        ]);
        return $this->json($response, ['data' => $files]);
    }

    public function getFile(Request $request, Response $response, array $args): Response
    {
        $file = $this->drive->getFile($args['id']);
        return $this->json($response, ['data' => $file]);
    }

    public function thumbnail(Request $request, Response $response, array $args): Response
    {
        $this->drive->proxyFile($args['id'], 'thumbnail');
        return $response;
    }

    public function preview(Request $request, Response $response, array $args): Response
    {
        $this->drive->proxyFile($args['id'], 'preview');
        return $response;
    }

    public function download(Request $request, Response $response, array $args): Response
    {
        $stream = $this->drive->downloadStream($args['id']);
        $file = $this->drive->getFile($args['id']);
        $name = rawurlencode($file['name'] ?? 'download');
        return $response
            ->withHeader('Content-Type', 'application/octet-stream')
            ->withHeader('Content-Disposition', "attachment; filename*=UTF-8''{$name}")
            ->withBody(new \Slim\Psr7\Stream($stream));
    }

    public function folderTree(Request $request, Response $response): Response
    {
        $tree = $this->drive->getFolderTree();
        return $this->json($response, ['data' => $tree]);
    }

    public function search(Request $request, Response $response): Response
    {
        $query = $request->getQueryParams()['q'] ?? '';
        $files = $this->drive->search($query);
        return $this->json($response, ['data' => $files]);
    }

    public function trash(Request $request, Response $response): Response
    {
        $files = $this->drive->listTrash();
        return $this->json($response, ['data' => $files]);
    }

    public function usage(Request $request, Response $response): Response
    {
        $usage = $this->drive->getUsage();
        return $this->json($response, ['data' => $usage]);
    }

    private function json(Response $response, array $data): Response
    {
        $response->getBody()->write(json_encode($data, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE));
        return $response->withHeader('Content-Type', 'application/json');
    }
}
