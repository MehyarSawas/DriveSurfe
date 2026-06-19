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
                'has_passkeys' => count($passkeys) > 0,
            ], JSON_THROW_ON_ERROR));
            return $res->withHeader('Content-Type', 'application/json');
        });

        $group->get('/auth/passkey/register/options', function (Request $req, Response $res) use ($session): Response {
            $passkeys = self::loadPasskeys();
            $sessionData = $session->get();

            $authenticated = !empty($sessionData['authenticated']);

            if (!empty($passkeys) && !$authenticated) {
                // Allow adding another device with the registration token
                $token    = $_ENV['REGISTRATION_TOKEN'] ?? null;
                $provided = $req->getHeaderLine('X-Registration-Token') ?: null;
                if (empty($token) || !hash_equals($token, (string) $provided)) {
                    return self::jsonError($res, 'Log in first or provide the registration token to add another device.', 403);
                }
            }

            if (empty($passkeys) && !$authenticated) {
                // No passkeys yet and not logged in — require the one-time registration token
                $token    = $_ENV['REGISTRATION_TOKEN'] ?? null;
                $provided = $req->getHeaderLine('X-Registration-Token') ?: null;
                if (empty($token) || !hash_equals($token, (string) $provided)) {
                    return self::jsonError($res, 'Registration token required', 403);
                }
            }

            $webAuthn = self::makeWebAuthn();
            $excludeIds = array_map(fn($p) => base64_decode($p['id']), $passkeys);

            $userId = random_bytes(16);
            $createArgs = $webAuthn->getCreateArgs(
                $userId,
                'owner',
                'DriveSurfe Owner',
                60,
                true,
                'preferred',
                null,
                $excludeIds
            );

            $challengeBin = $webAuthn->getChallenge()->getBinaryString();
            $session->update(['webauthn_challenge' => base64_encode($challengeBin)]);

            $pk = $createArgs->publicKey;
            $payload = [
                'challenge'               => self::b64urlEncode($challengeBin),
                'rp'                      => ['id' => $pk->rp->id, 'name' => $pk->rp->name],
                'user'                    => [
                    'id'          => self::b64urlEncode($userId),
                    'name'        => $pk->user->name,
                    'displayName' => $pk->user->displayName,
                ],
                'pubKeyCredParams'        => $pk->pubKeyCredParams,
                'authenticatorSelection'  => $pk->authenticatorSelection,
                'timeout'                 => $pk->timeout,
                'attestation'             => $pk->attestation,
            ];
            if (!empty($pk->excludeCredentials)) {
                $payload['excludeCredentials'] = array_map(fn($c) => [
                    'type' => $c->type,
                    'id'   => self::b64urlEncode(
                        $c->id instanceof \lbuchs\WebAuthn\Binary\ByteBuffer
                            ? $c->id->getBinaryString()
                            : (string) $c->id
                    ),
                ], $pk->excludeCredentials);
            }

            $res->getBody()->write(json_encode($payload, JSON_THROW_ON_ERROR));
            return $res->withHeader('Content-Type', 'application/json');
        });

        $group->post('/auth/passkey/register', function (Request $req, Response $res) use ($session): Response {
            $body = $req->getParsedBody() ?? [];
            $sessionData = $session->get();
            $challengeB64 = $sessionData['webauthn_challenge'] ?? null;

            // Consume challenge immediately (single-use regardless of outcome)
            $session->update(['webauthn_challenge' => null]);

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
                    'publicKey' => $credential->credentialPublicKey,
                    'counter'   => (int) ($credential->signCount ?? 0),
                    'name'      => 'Device ' . (count($passkeys) + 1),
                ];
                self::savePasskeys($passkeys);
                $session->update(['authenticated' => true]);

                $res->getBody()->write(json_encode(['ok' => true], JSON_THROW_ON_ERROR));
                return $res->withHeader('Content-Type', 'application/json');
            } catch (WebAuthnException $e) {
                error_log('WebAuthn registration failed: ' . $e->getMessage());
                return self::jsonError($res, 'Registration failed. Please try again.', 400);
            }
        });

        $group->get('/auth/passkey/login/options', function (Request $req, Response $res) use ($session): Response {
            if (empty(self::loadPasskeys())) {
                return self::jsonError($res, 'No passkeys registered', 404);
            }

            $webAuthn = self::makeWebAuthn();
            // Empty allowedCredentials = browser discovers passkeys for the domain (resident key flow)
            $getArgs = $webAuthn->getGetArgs([], 60, true, false, false, false, true, 'preferred');

            $challengeBin = $webAuthn->getChallenge()->getBinaryString();
            $session->update(['webauthn_challenge' => base64_encode($challengeBin)]);

            $pk = $getArgs->publicKey;
            $payload = [
                'challenge'        => self::b64urlEncode($challengeBin),
                'timeout'          => $pk->timeout,
                'rpId'             => $pk->rpId,
                'userVerification' => $pk->userVerification,
                'allowCredentials' => [],
            ];

            $res->getBody()->write(json_encode($payload, JSON_THROW_ON_ERROR));
            return $res->withHeader('Content-Type', 'application/json');
        });

        $group->post('/auth/passkey/login', function (Request $req, Response $res) use ($session): Response {
            $body         = $req->getParsedBody() ?? [];
            $sessionData  = $session->get();
            $challengeB64 = $sessionData['webauthn_challenge'] ?? null;

            // Consume challenge immediately (single-use regardless of outcome)
            $session->update(['webauthn_challenge' => null]);

            if (!$challengeB64) {
                return self::jsonError($res, 'No login in progress', 400);
            }
            $challenge = base64_decode($challengeB64);

            $credentialIdBin = self::b64urlDecode($body['rawId'] ?? '');
            $passkeys        = self::loadPasskeys();

            $passkey    = null;
            $passkeyIdx = null;
            foreach ($passkeys as $idx => $p) {
                if (hash_equals(base64_decode($p['id']), $credentialIdBin)) {
                    $passkey    = $p;
                    $passkeyIdx = $idx;
                    break;
                }
            }

            if ($passkey === null) {
                return self::jsonError($res, 'Authentication failed', 401);
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
                    $challenge,
                    $passkey['counter'],
                    'preferred'
                );

                // Update sign counter: bytes 33–36 of authenticatorData (big-endian uint32)
                if (strlen($authenticatorData) >= 37) {
                    $newCounter = unpack('N', substr($authenticatorData, 33, 4))[1];
                    if ($newCounter > $passkey['counter']) {
                        $passkeys[$passkeyIdx]['counter'] = $newCounter;
                        self::savePasskeys($passkeys);
                    }
                }

                $session->update(['authenticated' => true]);

                $res->getBody()->write(json_encode(['ok' => true], JSON_THROW_ON_ERROR));
                return $res->withHeader('Content-Type', 'application/json');
            } catch (WebAuthnException $e) {
                error_log('WebAuthn login failed: ' . $e->getMessage());
                return self::jsonError($res, 'Authentication failed', 401);
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
        $json = json_encode($passkeys, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR);
        $tmp  = self::PASSKEYS_FILE . '.tmp.' . bin2hex(random_bytes(4));
        file_put_contents($tmp, $json, LOCK_EX);
        rename($tmp, self::PASSKEYS_FILE);
    }

    private static function b64urlEncode(string $binary): string
    {
        return rtrim(strtr(base64_encode($binary), '+/', '-_'), '=');
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
