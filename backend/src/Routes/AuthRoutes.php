<?php declare(strict_types=1);

namespace DriveSurfe\Routes;

use DI\Container;
use DriveSurfe\Service\SessionService;
use lbuchs\WebAuthn\WebAuthn;
use lbuchs\WebAuthn\WebAuthnException;
use Psr\Http\Message\ResponseInterface as Response;
use Psr\Http\Message\ServerRequestInterface as Request;
use Slim\Routing\RouteCollectorProxy;

final class AuthRoutes
{
    private const PASSKEYS_FILE = __DIR__ . '/../../passkeys.json';

    private SessionService $session;

    public function __construct(private readonly Container $container)
    {
        $this->session = $container->get(SessionService::class);
    }

    public function register(RouteCollectorProxy $group): void
    {
        $session = $this->session;

        $group->get('/auth/me', function (Request $req, Response $res) use ($session): Response {
            $authenticated = (bool) ($session->get()['authenticated'] ?? false);
            $res->getBody()->write(json_encode(
                ['authenticated' => $authenticated, 'drive' => $authenticated ? 'kdrive' : null],
                JSON_THROW_ON_ERROR
            ));
            return $res->withHeader('Content-Type', 'application/json');
        });

        $group->post('/auth/logout', function (Request $req, Response $res) use ($session): Response {
            $session->destroy();
            $res->getBody()->write(json_encode(['ok' => true], JSON_THROW_ON_ERROR));
            return $res->withHeader('Content-Type', 'application/json');
        });

        $group->get('/auth/passkeys', function (Request $req, Response $res): Response {
            $passkeys = self::loadPasskeys();
            $res->getBody()->write(json_encode([
                'count' => count($passkeys),
                'names' => array_column($passkeys, 'name'),
            ], JSON_THROW_ON_ERROR));
            return $res->withHeader('Content-Type', 'application/json');
        });

        $group->get('/auth/passkey/register/options', function (Request $req, Response $res) use ($session): Response {
            $passkeys = self::loadPasskeys();
            $sessionData = $session->get();

            if (!empty($passkeys) && empty($sessionData['authenticated'])) {
                return self::jsonError($res, 'Passkey already registered. Log in first to add another device.', 403);
            }

            $webAuthn = self::makeWebAuthn();
            $excludeIds = array_map(fn($p) => base64_decode($p['id']), $passkeys);

            $createArgs = $webAuthn->getCreateArgs(
                random_bytes(16),
                'owner',
                'DriveSurfe Owner',
                60,
                true,
                'preferred',
                $excludeIds
            );

            $session->update(['webauthn_challenge' => base64_encode($webAuthn->getChallenge())]);

            $res->getBody()->write(json_encode($createArgs->publicKey, JSON_THROW_ON_ERROR));
            return $res->withHeader('Content-Type', 'application/json');
        });

        $group->post('/auth/passkey/register', function (Request $req, Response $res) use ($session): Response {
            $body = $req->getParsedBody() ?? [];
            $sessionData = $session->get();
            $challengeB64 = $sessionData['webauthn_challenge'] ?? null;

            if (!$challengeB64) {
                return self::jsonError($res, 'No registration in progress', 400);
            }
            $challenge = base64_decode($challengeB64);

            try {
                $webAuthn = self::makeWebAuthn();
                $clientDataJSON    = self::b64urlDecode($body['response']['clientDataJSON'] ?? '');
                $attestationObject = self::b64urlDecode($body['response']['attestationObject'] ?? '');

                $credential = $webAuthn->processCreate(
                    $clientDataJSON,
                    $attestationObject,
                    $challenge,
                    'preferred',
                    true,
                    false
                );

                $credIdBin = $credential->credentialId;
                if ($credIdBin instanceof \lbuchs\WebAuthn\Binary\ByteBuffer) {
                    $credIdBin = $credIdBin->getBinaryString();
                }

                $passkeys   = self::loadPasskeys();
                $passkeys[] = [
                    'id'        => base64_encode((string) $credIdBin),
                    'publicKey' => $credential->publicKey,
                    'counter'   => (int) ($credential->signCount ?? 0),
                    'name'      => 'Device ' . (count($passkeys) + 1),
                ];
                self::savePasskeys($passkeys);
                $session->update(['webauthn_challenge' => null, 'authenticated' => true]);

                $res->getBody()->write(json_encode(['ok' => true], JSON_THROW_ON_ERROR));
                return $res->withHeader('Content-Type', 'application/json');
            } catch (WebAuthnException $e) {
                return self::jsonError($res, 'Registration failed: ' . $e->getMessage(), 400);
            }
        });

        $group->get('/auth/passkey/login/options', function (Request $req, Response $res) use ($session): Response {
            if (empty(self::loadPasskeys())) {
                return self::jsonError($res, 'No passkeys registered', 404);
            }

            $webAuthn = self::makeWebAuthn();
            // Empty allowedCredentials = browser discovers passkeys for the domain (resident key flow)
            $getArgs = $webAuthn->getGetArgs([], 60, true, false, false, false, 'preferred');

            $session->update(['webauthn_challenge' => base64_encode($webAuthn->getChallenge())]);

            $res->getBody()->write(json_encode($getArgs->publicKey, JSON_THROW_ON_ERROR));
            return $res->withHeader('Content-Type', 'application/json');
        });

        $group->post('/auth/passkey/login', function (Request $req, Response $res) use ($session): Response {
            $body         = $req->getParsedBody() ?? [];
            $sessionData  = $session->get();
            $challengeB64 = $sessionData['webauthn_challenge'] ?? null;

            if (!$challengeB64) {
                return self::jsonError($res, 'No login in progress', 400);
            }
            $challenge = base64_decode($challengeB64);

            $credentialIdBin = self::b64urlDecode($body['rawId'] ?? '');
            $passkeys        = self::loadPasskeys();

            $passkey    = null;
            $passkeyIdx = null;
            foreach ($passkeys as $idx => $p) {
                if (base64_decode($p['id']) === $credentialIdBin) {
                    $passkey    = $p;
                    $passkeyIdx = $idx;
                    break;
                }
            }

            if ($passkey === null) {
                return self::jsonError($res, 'Unknown credential', 400);
            }

            try {
                $webAuthn          = self::makeWebAuthn();
                $clientDataJSON    = self::b64urlDecode($body['response']['clientDataJSON'] ?? '');
                $authenticatorData = self::b64urlDecode($body['response']['authenticatorData'] ?? '');
                $signature         = self::b64urlDecode($body['response']['signature'] ?? '');

                $webAuthn->processGet(
                    $clientDataJSON,
                    $authenticatorData,
                    $signature,
                    $passkey['publicKey'],
                    $credentialIdBin,
                    $passkey['counter'],
                    'preferred'
                );

                // Update counter: bytes 33–36 of authenticatorData (big-endian uint32)
                if (strlen($authenticatorData) >= 37) {
                    $passkeys[$passkeyIdx]['counter'] = unpack('N', substr($authenticatorData, 33, 4))[1];
                    self::savePasskeys($passkeys);
                }

                $session->update(['webauthn_challenge' => null, 'authenticated' => true]);

                $res->getBody()->write(json_encode(['ok' => true], JSON_THROW_ON_ERROR));
                return $res->withHeader('Content-Type', 'application/json');
            } catch (WebAuthnException $e) {
                return self::jsonError($res, 'Authentication failed: ' . $e->getMessage(), 401);
            }
        });
    }

    private static function makeWebAuthn(): WebAuthn
    {
        $rpId = $_ENV['APP_RP_ID']
            ?? parse_url($_ENV['APP_URL'] ?? 'https://drive.msawas.com', PHP_URL_HOST)
            ?? 'drive.msawas.com';
        return new WebAuthn('DriveSurfe', $rpId);
    }

    private static function loadPasskeys(): array
    {
        if (!file_exists(self::PASSKEYS_FILE)) {
            return [];
        }
        return json_decode(file_get_contents(self::PASSKEYS_FILE), true, 512, JSON_THROW_ON_ERROR) ?? [];
    }

    private static function savePasskeys(array $passkeys): void
    {
        file_put_contents(self::PASSKEYS_FILE, json_encode($passkeys, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR));
    }

    private static function b64urlDecode(string $input): string
    {
        $base64  = strtr($input, '-_', '+/');
        $padded  = str_pad($base64, strlen($base64) + (4 - strlen($base64) % 4) % 4, '=');
        $decoded = base64_decode($padded, true);
        if ($decoded === false) {
            throw new \InvalidArgumentException('Invalid base64url input');
        }
        return $decoded;
    }

    private static function jsonError(Response $response, string $message, int $status): Response
    {
        $response->getBody()->write(json_encode(['error' => $message], JSON_THROW_ON_ERROR));
        return $response->withStatus($status)->withHeader('Content-Type', 'application/json');
    }
}
