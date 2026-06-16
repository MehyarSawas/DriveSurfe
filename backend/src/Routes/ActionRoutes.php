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

    public function register(RouteCollectorProxy $group): void
    {
        $group->group('', function (RouteCollectorProxy $g) {
            $g->post('/files/{id}/favorite', $this->favorite(...));
            $g->delete('/files/{id}/favorite', $this->unfavorite(...));
            $g->delete('/files/{id}', $this->delete(...));
        })->add($this->auth);
    }

    private function favorite(Request $request, Response $response, array $args): Response
    {
        $this->drive->favorite($args['id']);
        return $this->json($response, ['ok' => true]);
    }

    private function unfavorite(Request $request, Response $response, array $args): Response
    {
        $this->drive->unfavorite($args['id']);
        return $this->json($response, ['ok' => true]);
    }

    private function delete(Request $request, Response $response, array $args): Response
    {
        $this->drive->delete($args['id']);
        return $this->json($response, ['ok' => true]);
    }

    private function json(Response $response, array $data): Response
    {
        $response->getBody()->write(json_encode($data, JSON_THROW_ON_ERROR));
        return $response->withHeader('Content-Type', 'application/json');
    }
}
