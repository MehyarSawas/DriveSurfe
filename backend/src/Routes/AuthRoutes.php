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
        $group->get('/auth/kdrive/login', $this->login(...));
        $group->get('/auth/kdrive/callback', $this->callback(...));
        $group->post('/auth/logout', $this->logout(...));
        $group->get('/auth/me', $this->me(...));
    }

    private function login(Request $request, Response $response): Response
    {
        $provider = $this->makeProvider();
        $url = $provider->getAuthorizationUrl();
        $this->session->set(['oauth_state' => $provider->getState()]);

        return $response->withHeader('Location', $url)->withStatus(302);
    }

    private function callback(Request $request, Response $response): Response
    {
        $params = $request->getQueryParams();
        $session = $this->session->get();

        if (empty($params['code'])) {
            return $this->jsonError($response, 'Missing authorization code', 400);
        }

        if (empty($params['state']) || $params['state'] !== ($session['oauth_state'] ?? '')) {
            return $this->jsonError($response, 'Invalid state', 400);
        }

        $provider = $this->makeProvider();
        $token = $provider->getAccessToken('authorization_code', ['code' => $params['code']]);

        $this->session->set([
            'access_token' => $token->getToken(),
            'refresh_token' => $token->getRefreshToken(),
            'expires_at' => $token->getExpires(),
        ]);

        $appUrl = $_ENV['APP_URL'] ?? '/';
        return $response->withHeader('Location', $appUrl)->withStatus(302);
    }

    private function logout(Request $request, Response $response): Response
    {
        $this->session->destroy();
        $response->getBody()->write(json_encode(['ok' => true], JSON_THROW_ON_ERROR));
        return $response->withHeader('Content-Type', 'application/json');
    }

    private function me(Request $request, Response $response): Response
    {
        if (!$this->session->isAuthenticated()) {
            $response->getBody()->write(json_encode(['authenticated' => false], JSON_THROW_ON_ERROR));
            return $response->withHeader('Content-Type', 'application/json');
        }

        $session = $this->session->get();
        $response->getBody()->write(json_encode([
            'authenticated' => true,
            'drive' => 'kdrive',
        ], JSON_THROW_ON_ERROR));
        return $response->withHeader('Content-Type', 'application/json');
    }

    private function makeProvider(): KDriveProvider
    {
        return new KDriveProvider([
            'clientId' => $_ENV['KDRIVE_CLIENT_ID'] ?? '',
            'clientSecret' => $_ENV['KDRIVE_CLIENT_SECRET'] ?? '',
            'redirectUri' => $_ENV['KDRIVE_REDIRECT_URI'] ?? '',
        ]);
    }

    private function jsonError(Response $response, string $message, int $status): Response
    {
        $response->getBody()->write(json_encode(['error' => $message], JSON_THROW_ON_ERROR));
        return $response->withStatus($status)->withHeader('Content-Type', 'application/json');
    }
}
