<?php declare(strict_types=1);

use DriveSurfe\App\Application;

require_once __DIR__ . '/../vendor/autoload.php';

$dotenv = Dotenv\Dotenv::createImmutable(__DIR__ . '/..');
$dotenv->safeLoad();

$app = new Application();
$app->run();
