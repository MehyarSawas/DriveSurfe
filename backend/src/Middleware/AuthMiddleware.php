<?php declare(strict_types=1);

namespace DriveSurfe\Middleware;

use Psr\Http\Message\ResponseInterface;
use Psr\Http\Message\ServerRequestInterface;
use Psr\Http\Server\MiddlewareInterface;
use Psr\Http\Server\RequestHandlerInterface;
use Slim\Psr7\Response;

final class AuthMiddleware implements MiddlewareInterface
{
    public function process(ServerRequestInterface $request, RequestHandlerInterface $handler): ResponseInterface
    {
        if (empty($_ENV['KDRIVE_TOKEN'])) {
            $response = new Response();
            $response->getBody()->write(json_encode([
                'error' => 'Unauthenticated',
                'debug_token_set' => isset($_ENV['KDRIVE_TOKEN']),
                'debug_env_keys' => array_keys($_ENV),
            ], JSON_THROW_ON_ERROR));
            return $response->withStatus(401)->withHeader('Content-Type', 'application/json');
        }

        return $handler->handle($request);
    }
}
