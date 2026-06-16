<?php declare(strict_types=1);

namespace DriveSurfe\Service;

use RuntimeException;

final class SessionService
{
    private const COOKIE_NAME = 'ds_session';
    private const COOKIE_TTL = 86400 * 7; // 7 days

    public function __construct(private readonly string $key) {}

    public function get(): array
    {
        $cookie = $_COOKIE[self::COOKIE_NAME] ?? null;
        if (!$cookie) {
            return [];
        }

        $decrypted = $this->decrypt($cookie);
        if ($decrypted === null) {
            return [];
        }

        try {
            return json_decode($decrypted, true, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException) {
            return [];
        }
    }

    public function set(array $data): void
    {
        $payload = json_encode($data, JSON_THROW_ON_ERROR);
        $encrypted = $this->encrypt($payload);

        setcookie(
            self::COOKIE_NAME,
            $encrypted,
            [
                'expires' => time() + self::COOKIE_TTL,
                'path' => '/',
                'httponly' => true,
                'samesite' => 'Lax',
                'secure' => isset($_SERVER['HTTPS']),
            ]
        );
    }

    public function update(array $merge): void
    {
        $current = $this->get();
        $this->set(array_merge($current, $merge));
    }

    public function destroy(): void
    {
        setcookie(self::COOKIE_NAME, '', [
            'expires' => time() - 3600,
            'path' => '/',
            'httponly' => true,
            'samesite' => 'Lax',
            'secure' => isset($_SERVER['HTTPS']),
        ]);
    }

    public function isAuthenticated(): bool
    {
        $session = $this->get();
        return !empty($session['access_token']);
    }

    private function encrypt(string $data): string
    {
        $iv = random_bytes(16);
        $key = hash('sha256', $this->key, true);
        $encrypted = openssl_encrypt($data, 'AES-256-CBC', $key, 0, $iv);
        $hmac = hash_hmac('sha256', $encrypted, $key, true);
        return base64_encode($iv . $hmac . $encrypted);
    }

    private function decrypt(string $data): ?string
    {
        $decoded = base64_decode($data, true);
        if ($decoded === false || strlen($decoded) < 48) {
            return null;
        }

        $key = hash('sha256', $this->key, true);
        $iv = substr($decoded, 0, 16);
        $hmac = substr($decoded, 16, 32);
        $encrypted = substr($decoded, 48);

        $expectedHmac = hash_hmac('sha256', $encrypted, $key, true);
        if (!hash_equals($expectedHmac, $hmac)) {
            return null;
        }

        $result = openssl_decrypt($encrypted, 'AES-256-CBC', $key, 0, $iv);
        return $result === false ? null : $result;
    }
}
