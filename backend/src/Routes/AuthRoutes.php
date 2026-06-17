<?php declare(strict_types=1);

namespace DriveSurfe\Routes;

use DI\Container;
use DriveSurfe\Drive\KDrive\KDriveProvider;
use DriveSurfe\Service\SessionService;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\Routing\RouteCollectorProxy;

final class AuthRoutes
{
    private SessionService $session;

    public function __construct(private readonly Container $container)
    {
        $this->session = $container->get(SessionService::class);
    }

    public function register(RouteCollectorProxy $group): void
    {
        $session = $this->session;

        $group->get('/auth/kdrive/login', function (Request $req, Response $res) use ($session): Response {
            $provider = self::makeProvider();
            $url = $provider->getAuthorizationUrl();
            $session->set(['oauth_state' => $provider->getState()]);
            return $res->withHeader('Location', $url)->withStatus(302);
        });

$group->get('/auth/kdrive/callback', function (Request $req, Response $res) use ($session): Response {
            $params = $req->getQueryParams();
            $data   = $session->get();

            if (empty($params['code'])) {
                return self::jsonError($res, 'Missing authorization code', 400);
            }
            if (empty($params['state']) || $params['state'] !== ($data['oauth_state'] ?? '')) {
                return self::jsonError($res, 'Invalid state', 400);
            }

            $provider = self::makeProvider();
            $token    = $provider->getAccessToken('authorization_code', ['code' => $params['code']]);

            $session->set([
                'access_token'  => $token->getToken(),
                'refresh_token' => $token->getRefreshToken(),
                'expires_at'    => $token->getExpires(),
            ]);

            return $res->withHeader('Location', $_ENV['APP_URL'] ?? '/')->withStatus(302);
        });

        $group->post('/auth/logout', function (Request $req, Response $res) use ($session): Response {
            $session->destroy();
            $res->getBody()->write(json_encode(['ok' => true], JSON_THROW_ON_ERROR));
            return $res->withHeader('Content-Type', 'application/json');
        });

        $group->get('/auth/me', function (Request $req, Response $res) use ($session): Response {
            if (!$session->isAuthenticated()) {
                $res->getBody()->write(json_encode(['authenticated' => false], JSON_THROW_ON_ERROR));
                return $res->withHeader('Content-Type', 'application/json');
            }
            $res->getBody()->write(json_encode(['authenticated' => true, 'drive' => 'kdrive'], JSON_THROW_ON_ERROR));
            return $res->withHeader('Content-Type', 'application/json');
        });
    }

    private static function makeProvider(): KDriveProvider
    {
        return new KDriveProvider([
            'clientId'     => $_ENV['KDRIVE_CLIENT_ID'] ?? '',
            'clientSecret' => $_ENV['KDRIVE_CLIENT_SECRET'] ?? '',
            'redirectUri'  => $_ENV['KDRIVE_REDIRECT_URI'] ?? '',
        ]);
    }

    private static function jsonError(Response $response, string $message, int $status): Response
    {
        $response->getBody()->write(json_encode(['error' => $message], JSON_THROW_ON_ERROR));
        return $response->withStatus($status)->withHeader('Content-Type', 'application/json');
    }
}
