<?php declare(strict_types=1);

namespace DriveSurfe\Mail;

use DriveSurfe\Service\JsonFile;

/**
 * Security + idempotency state for the inbound mail webhook.
 *
 * - Authentication: HMAC-SHA256 over "{timestamp}.{raw body}" with
 *   MAIL_WEBHOOK_SECRET, sent as `X-DS-Signature: sha256=<hex>` alongside
 *   `X-DS-Timestamp: <unix seconds>`. Compared with hash_equals.
 * - Replay protection: timestamps older/newer than 5 minutes are rejected,
 *   and every accepted signature is remembered for 10 minutes and refused
 *   if seen again.
 * - Brute-force protection: failed signature checks are counted per client
 *   IP (REMOTE_ADDR only — forwarding headers are spoofable); 20 failures in
 *   15 minutes locks that IP out until the window rolls off.
 * - Idempotency: per Gmail message id, remembers which processors already
 *   succeeded, so a retried delivery never uploads the same file twice.
 *   Failed messages are retried with exponential backoff (2, 4, 8 … min,
 *   capped at 1 h).
 *
 * State lives in `backend/mail_webhook_state.json` (outside the web root).
 */
final class WebhookGuard
{
    private const STATE_FILE      = __DIR__ . '/../../mail_webhook_state.json';
    private const CLOCK_SKEW      = 300;
    private const NONCE_TTL       = 600;
    private const FAIL_WINDOW     = 900;
    private const FAIL_MAX        = 20;
    private const PROCESSING_TTL  = 900;   // a crashed run stops blocking retries after this
    private const MAX_ATTEMPTS    = 8;     // with backoff ≈ 3 h of retries before giving up
    private const BACKOFF_MAX     = 3600;
    private const MESSAGES_KEPT   = 5000;
    private const MIN_SECRET_LEN  = 32;

    private JsonFile $state;

    public function __construct()
    {
        $this->state = new JsonFile(self::STATE_FILE);
    }

    public static function secret(): ?string
    {
        $s = (string) ($_ENV['MAIL_WEBHOOK_SECRET'] ?? '');
        return strlen($s) >= self::MIN_SECRET_LEN ? $s : null;
    }

    public static function maxBytes(): int
    {
        $mb = (int) ($_ENV['MAIL_WEBHOOK_MAX_MB'] ?? 40);
        return max(1, min($mb, 95)) * 1024 * 1024; // stay under post_max_size=100M
    }

    public function isLockedOut(string $ip): bool
    {
        $cutoff = time() - self::FAIL_WINDOW;
        $fails  = $this->state->read()['failures'][self::ipKey($ip)] ?? [];
        return count(array_filter($fails, fn($t) => $t > $cutoff)) >= self::FAIL_MAX;
    }

    public function recordFailure(string $ip): void
    {
        $key = self::ipKey($ip);
        $this->state->update(function (array $s) use ($key) {
            $s = self::prune($s);
            $s['failures'][$key][] = time();
            return $s;
        });
    }

    public function verifySignature(string $rawBody, string $timestamp, string $signature): bool
    {
        $secret = self::secret();
        if ($secret === null) return false;
        if (!preg_match('/^\d{1,12}$/', $timestamp) || abs(time() - (int) $timestamp) > self::CLOCK_SKEW) {
            return false;
        }
        if (!preg_match('/^sha256=([a-f0-9]{64})$/i', $signature, $m)) return false;
        $expected = hash_hmac('sha256', $timestamp . '.' . $rawBody, $secret);
        return hash_equals($expected, strtolower($m[1]));
    }

    /** Remember a verified signature; false if it was already used (replay). */
    public function consumeNonce(string $signature): bool
    {
        $key   = hash('sha256', strtolower($signature));
        $fresh = false;
        $this->state->update(function (array $s) use ($key, &$fresh) {
            $s = self::prune($s);
            if (!isset($s['nonces'][$key])) {
                $s['nonces'][$key] = time();
                $fresh = true;
            }
            return $s;
        });
        return $fresh;
    }

    /**
     * Claim a message for processing.
     * @return array{state: 'claimed'|'done'|'processing'|'backoff'|'gave_up', done_ids: list<string>}
     */
    public function claim(string $messageId): array
    {
        $result = ['state' => 'claimed', 'done_ids' => []];
        $this->state->update(function (array $s) use ($messageId, &$result) {
            $s   = self::prune($s);
            $msg = $s['messages']['m:' . $messageId] ?? ['status' => 'new', 'attempts' => 0, 'done_ids' => []];
            $result['done_ids'] = $msg['done_ids'] ?? [];

            $attempts = (int) ($msg['attempts'] ?? 0);
            $since    = time() - (int) ($msg['at'] ?? 0);

            if ($msg['status'] === 'processing' && $since < self::PROCESSING_TTL) {
                $result['state'] = 'processing';
            } elseif ($msg['status'] === 'done') {
                $result['state'] = 'done';
            } elseif ($attempts >= self::MAX_ATTEMPTS) {
                $result['state'] = 'gave_up';
            } elseif ($msg['status'] === 'failed' && $since < min(self::BACKOFF_MAX, 60 * 2 ** $attempts)) {
                $result['state'] = 'backoff';
            } else {
                $msg['status']   = 'processing';
                $msg['attempts'] = ($msg['attempts'] ?? 0) + 1;
                $msg['at']       = time();
            }
            $s['messages']['m:' . $messageId] = $msg;
            return $s;
        });
        return $result;
    }

    /** @param list<string> $doneIds processors that succeeded (cumulative) */
    public function finish(string $messageId, bool $allOk, array $doneIds): void
    {
        $this->state->update(function (array $s) use ($messageId, $allOk, $doneIds) {
            $msg = $s['messages']['m:' . $messageId] ?? ['attempts' => 1];
            $msg['status']   = $allOk ? 'done' : 'failed';
            $msg['done_ids'] = array_values(array_unique($doneIds));
            $msg['at']       = time();
            $s['messages']['m:' . $messageId] = $msg;
            return $s;
        });
    }

    private static function prune(array $s): array
    {
        $now = time();
        $s['nonces'] = array_filter($s['nonces'] ?? [], fn($t) => $t > $now - self::NONCE_TTL);
        $failures = [];
        foreach ($s['failures'] ?? [] as $ip => $times) {
            $times = array_values(array_filter($times, fn($t) => $t > $now - self::FAIL_WINDOW));
            if ($times) $failures[$ip] = $times;
        }
        $s['failures'] = $failures;
        $messages = $s['messages'] ?? [];
        if (count($messages) > self::MESSAGES_KEPT) {
            uasort($messages, fn($a, $b) => ($b['at'] ?? 0) <=> ($a['at'] ?? 0));
            $messages = array_slice($messages, 0, self::MESSAGES_KEPT, true);
        }
        $s['messages'] = $messages;
        return $s;
    }

    private static function ipKey(string $ip): string
    {
        return substr(hash('sha256', $ip), 0, 16);
    }
}
