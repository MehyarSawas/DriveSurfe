<?php declare(strict_types=1);

namespace DriveSurfe\App;

use DI\Container;
use DI\ContainerBuilder;
use DriveSurfe\Drive\KDrive\KDriveClient;
use DriveSurfe\Middleware\AuthMiddleware;
use DriveSurfe\Routes\ActionRoutes;
use DriveSurfe\Routes\AuthRoutes;
use DriveSurfe\Routes\FileRoutes;
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
                $_ENV['SESSION_KEY'] ?? 'fallback-key-change-me'
            ),
            Client::class => fn() => new Client(['timeout' => 30]),
            KDriveClient::class => fn(Container $c) => new KDriveClient($c->get(Client::class)),
            AuthMiddleware::class => fn(Container $c) => new AuthMiddleware($c->get(SessionService::class)),
        ]);

        return $builder->build();
    }

    private function registerMiddleware(): void
    {
        $this->slim->addErrorMiddleware(
            displayErrorDetails: true,
            logErrors: true,
            logErrorDetails: true
        );
        $this->slim->addBodyParsingMiddleware();

        // CORS
        $this->slim->add(function ($request, $handler) {
            $response = $handler->handle($request);
            return $response
                ->withHeader('Access-Control-Allow-Origin', $_ENV['APP_URL'] ?? '*')
                ->withHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Registration-Token')
                ->withHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
                ->withHeader('Access-Control-Allow-Credentials', 'true');
        });
    }

    private function registerRoutes(Container $container): void
    {
        $authRoutes = new AuthRoutes($container);
        $fileRoutes = new FileRoutes($container);
        $actionRoutes = new ActionRoutes($container);

        $this->slim->group('/api', function ($group) use ($authRoutes, $fileRoutes, $actionRoutes) {
            $authRoutes->register($group);
            $fileRoutes->register($group);
            $actionRoutes->register($group);
        });
    }
}
