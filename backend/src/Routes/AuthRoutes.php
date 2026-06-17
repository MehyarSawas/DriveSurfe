<?php declare(strict_types=1);

namespace DriveSurfe\Routes;

use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\Routing\RouteCollectorProxy;

final class AuthRoutes
{
    public function register(RouteCollectorProxy $group): void
    {
        $group->get('/auth/me', function (Request $req, Response $res): Response {
            $configured = !empty($_ENV['KDRIVE_TOKEN']);
            $res->getBody()->write(json_encode(
                ['authenticated' => $configured, 'drive' => $configured ? 'kdrive' : null],
                JSON_THROW_ON_ERROR
            ));
            return $res->withHeader('Content-Type', 'application/json');
        });

        $group->post('/auth/logout', function (Request $req, Response $res): Response {
            $res->getBody()->write(json_encode(['ok' => true], JSON_THROW_ON_ERROR));
            return $res->withHeader('Content-Type', 'application/json');
        });
    }
}
