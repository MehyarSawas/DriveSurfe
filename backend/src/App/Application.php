<?php declare(strict_types=1);

namespace DriveSurfe\App;

use DI\Container;
use DI\ContainerBuilder;
use DriveSurfe\Drive\KDrive\KDriveClient;
use DriveSurfe\Middleware\AuthMiddleware;
use DriveSurfe\Routes\ActionRoutes;
use DriveSurfe\Routes\AuthRoutes;
use DriveSurfe\Routes\FileRoutes;
use DriveSurfe\Routes\SessionRoutes;
use DriveSurfe\Service\SessionService;
use GuzzleHttp\Client;
use Slim\Factory\AppFactory;
use Slim\App;

final class Application
{
    private App $slim;

    public function __construct()
    {
        $container = $this->buildContainer();
        AppFactory::setContainer($container);
        $this->slim = AppFactory::create();
        $this->registerMiddleware();
        $this->registerRoutes($container);
    }

    public function run(): void
    {
        $this->slim->run();
    }

    private function buildContainer(): Container
    {
        $builder = new ContainerBuilder();
        $builder->addDefinitions([
            SessionService::class => fn() => new SessionService(
                $_ENV['SESSION_KEY'] ?? throw new \RuntimeException('SESSION_KEY must be set in .env')
            ),
            Client::class => fn() => new Client(['timeout' => 30]),
            KDriveClient::class => fn(Container $c) => new KDriveClient($c->get(Client::class)),
            AuthMiddleware::class => fn(Container $c) => new AuthMiddleware($c->get(SessionService::class)),
        ]);

        return $builder->build();
    }

    private function registerMiddleware(): void
    {
        $isDev = ($_ENV['APP_ENV'] ?? 'production') === 'development';
        $this->slim->addErrorMiddleware(
            displayErrorDetails: $isDev,
            logErrors: true,
            logErrorDetails: true
        );
        $this->slim->addBodyParsingMiddleware();

        // Security + CORS headers
        $this->slim->add(function ($request, $handler) {
            $response = $handler->handle($request);

            $appUrl = $_ENV['APP_URL'] ?? null;
            if (!$appUrl) {
                throw new \RuntimeException('APP_URL must be set in .env');
            }
            $origin = rtrim(parse_url($appUrl, PHP_URL_SCHEME) . '://' . parse_url($appUrl, PHP_URL_HOST), '/');

            return $response
                ->withHeader('Access-Control-Allow-Origin', $origin)
                ->withHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Registration-Token')
                ->withHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
                ->withHeader('Access-Control-Allow-Credentials', 'true')
                ->withHeader('X-Content-Type-Options', 'nosniff')
                ->withHeader('X-Frame-Options', 'DENY')
                ->withHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
                ->withHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
                ->withHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
        });
    }

    private function registerRoutes(Container $container): void
    {
        $authRoutes    = new AuthRoutes($container);
        $fileRoutes    = new FileRoutes($container);
        $actionRoutes  = new ActionRoutes($container);
        $sessionRoutes = new SessionRoutes($container);

        $this->slim->group('/api', function ($group) use ($authRoutes, $fileRoutes, $actionRoutes, $sessionRoutes) {
            $authRoutes->register($group);
            $fileRoutes->register($group);
            $actionRoutes->register($group);
            $sessionRoutes->register($group);
        });
    }
}
