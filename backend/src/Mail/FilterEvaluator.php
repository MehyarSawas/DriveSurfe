<?php declare(strict_types=1);

namespace DriveSurfe\Mail;

/**
 * Processor filters: a flat list of conditions, each joined to the previous
 * one with AND / OR. AND binds tighter than OR (standard precedence), so
 * `a AND b OR c` means `(a AND b) OR c`. An empty filter matches every email.
 *
 * List-valued fields (recipients, labels, attachment names) match a positive
 * operator if ANY element matches, and a negative operator (not_equals,
 * not_contains) only if NO element matches. String comparisons are
 * case-insensitive.
 */
final class FilterEvaluator
{
    public const MAX_CONDITIONS = 25;

    /** field key => [label, type] — type: string | list | number | date */
    public const FIELDS = [
        'from'                 => ['Sender address', 'string'],
        'from_name'            => ['Sender name', 'string'],
        'from_domain'          => ['Sender domain', 'string'],
        'to'                   => ['To', 'list'],
        'cc'                   => ['Cc', 'list'],
        'recipient'            => ['Any recipient (To + Cc)', 'list'],
        'subject'              => ['Subject', 'string'],
        'body'                 => ['Body text', 'string'],
        'label'                => ['Gmail label', 'list'],
        'attachment_name'      => ['Attachment name', 'list'],
        'attachment_extension' => ['Attachment extension', 'list'],
        'attachment_count'     => ['Attachment count', 'number'],
        'date'                 => ['Received date', 'date'],
    ];

    /** operator key => [label, applicable types, needs value] */
    public const OPERATORS = [
        'equals'        => ['equals', ['string', 'list', 'number', 'date'], true],
        'not_equals'    => ['does not equal', ['string', 'list', 'number', 'date'], true],
        'contains'      => ['contains', ['string', 'list'], true],
        'not_contains'  => ['does not contain', ['string', 'list'], true],
        'starts_with'   => ['starts with', ['string', 'list'], true],
        'ends_with'     => ['ends with', ['string', 'list'], true],
        'matches'       => ['matches regex', ['string', 'list'], true],
        'greater'       => ['greater than', ['number', 'date'], true],
        'greater_equal' => ['greater or equal', ['number', 'date'], true],
        'smaller'       => ['smaller than', ['number', 'date'], true],
        'smaller_equal' => ['smaller or equal', ['number', 'date'], true],
        'is_empty'      => ['is empty', ['string', 'list'], false],
        'is_not_empty'  => ['is not empty', ['string', 'list'], false],
    ];

    /** Metadata for the settings UI. */
    public static function describe(): array
    {
        $fields = [];
        foreach (self::FIELDS as $key => [$label, $type]) {
            $fields[] = ['key' => $key, 'label' => $label, 'type' => $type];
        }
        $operators = [];
        foreach (self::OPERATORS as $key => [$label, $types, $needsValue]) {
            $operators[] = ['key' => $key, 'label' => $label, 'types' => $types, 'needs_value' => $needsValue];
        }
        return ['fields' => $fields, 'operators' => $operators];
    }

    /**
     * Validate + normalize a filter coming from the settings UI.
     * @throws \InvalidArgumentException
     */
    public static function normalize(mixed $filter): array
    {
        $conditions = is_array($filter) ? ($filter['conditions'] ?? []) : [];
        if (!is_array($conditions)) throw new \InvalidArgumentException('Invalid filter');
        if (count($conditions) > self::MAX_CONDITIONS) {
            throw new \InvalidArgumentException('Too many filter conditions (max ' . self::MAX_CONDITIONS . ')');
        }

        $out = [];
        foreach (array_values($conditions) as $i => $c) {
            if (!is_array($c)) throw new \InvalidArgumentException('Invalid filter condition');
            $field = (string) ($c['field'] ?? '');
            $op    = (string) ($c['operator'] ?? '');
            $join  = ($c['join'] ?? 'and') === 'or' ? 'or' : 'and';
            $value = trim((string) ($c['value'] ?? ''));
            $n = $i + 1;

            if (!isset(self::FIELDS[$field])) throw new \InvalidArgumentException("Condition {$n}: unknown field");
            if (!isset(self::OPERATORS[$op])) throw new \InvalidArgumentException("Condition {$n}: unknown operator");
            $type = self::FIELDS[$field][1];
            [, $types, $needsValue] = self::OPERATORS[$op];
            if (!in_array($type, $types, true)) {
                throw new \InvalidArgumentException("Condition {$n}: operator not valid for this field");
            }
            if (!$needsValue) {
                $value = '';
            } else {
                if ($value === '') throw new \InvalidArgumentException("Condition {$n}: value is required");
                if (mb_strlen($value) > 500) throw new \InvalidArgumentException("Condition {$n}: value too long");
                if ($type === 'number' && !is_numeric($value)) {
                    throw new \InvalidArgumentException("Condition {$n}: value must be a number");
                }
                if ($type === 'date' && self::toTimestamp($value) === null) {
                    throw new \InvalidArgumentException("Condition {$n}: value must be a date (e.g. 2026-01-31)");
                }
                if ($op === 'matches' && @preg_match(self::regex($value), '') === false) {
                    throw new \InvalidArgumentException("Condition {$n}: invalid regular expression");
                }
            }
            $out[] = ['join' => $i === 0 ? 'and' : $join, 'field' => $field, 'operator' => $op, 'value' => $value];
        }
        return ['conditions' => $out];
    }

    public static function matches(array $filter, Email $email): bool
    {
        $conditions = $filter['conditions'] ?? [];
        if (!$conditions) return true;

        // Split into OR-separated groups of AND-ed conditions.
        $groups = [[]];
        foreach ($conditions as $i => $c) {
            if ($i > 0 && ($c['join'] ?? 'and') === 'or') $groups[] = [];
            $groups[count($groups) - 1][] = $c;
        }
        foreach ($groups as $group) {
            $all = true;
            foreach ($group as $c) {
                if (!self::evaluate($c, $email)) { $all = false; break; }
            }
            if ($all) return true;
        }
        return false;
    }

    private static function evaluate(array $c, Email $email): bool
    {
        $field = $c['field'] ?? '';
        $op    = $c['operator'] ?? '';
        $value = (string) ($c['value'] ?? '');
        if (!isset(self::FIELDS[$field], self::OPERATORS[$op])) return false;
        $type   = self::FIELDS[$field][1];
        $actual = self::fieldValue($field, $email);

        if ($type === 'number' || $type === 'date') {
            $a = (float) $actual;
            $b = $type === 'number' ? (float) $value : self::toTimestamp($value);
            if ($b === null) return false;
            if ($type === 'date' && in_array($op, ['equals', 'not_equals'], true)) {
                // Day granularity for date equality — "received on 2026-03-01".
                $tz   = $email->date->getTimezone();
                $same = (new \DateTimeImmutable('@' . (int) $a))->setTimezone($tz)->format('Y-m-d')
                    === (new \DateTimeImmutable('@' . (int) $b))->setTimezone($tz)->format('Y-m-d');
                return $op === 'equals' ? $same : !$same;
            }
            return match ($op) {
                'equals'        => $a == $b,
                'not_equals'    => $a != $b,
                'greater'       => $a > $b,
                'greater_equal' => $a >= $b,
                'smaller'       => $a < $b,
                'smaller_equal' => $a <= $b,
                default         => false,
            };
        }

        $values = array_map(fn($v) => mb_strtolower((string) $v), is_array($actual) ? $actual : [$actual]);
        $nonEmpty = array_values(array_filter($values, fn($v) => $v !== ''));

        if ($op === 'is_empty')     return $nonEmpty === [];
        if ($op === 'is_not_empty') return $nonEmpty !== [];

        $needle = mb_strtolower($value);
        $test = match ($op) {
            'equals', 'not_equals'     => fn(string $v) => $v === $needle,
            'contains', 'not_contains' => fn(string $v) => str_contains($v, $needle),
            'starts_with'              => fn(string $v) => str_starts_with($v, $needle),
            'ends_with'                => fn(string $v) => str_ends_with($v, $needle),
            'matches'                  => fn(string $v) => @preg_match(self::regex($value), $v) === 1,
            default                    => fn(string $v) => false,
        };
        $any = false;
        foreach ($values as $v) {
            if ($test($v)) { $any = true; break; }
        }
        return in_array($op, ['not_equals', 'not_contains'], true) ? !$any : $any;
    }

    private static function fieldValue(string $field, Email $email): string|array|int
    {
        $addresses = fn(array $list) => array_map(fn($a) => $a['address'], $list);
        return match ($field) {
            'from'                 => $email->from['address'],
            'from_name'            => $email->from['name'],
            'from_domain'          => $email->senderDomain(),
            'to'                   => $addresses($email->to),
            'cc'                   => $addresses($email->cc),
            'recipient'            => $addresses([...$email->to, ...$email->cc]),
            'subject'              => $email->subject,
            'body'                 => $email->bodyText,
            'label'                => $email->labels,
            'attachment_name'      => array_map(fn(Attachment $a) => $a->name, $email->attachments),
            'attachment_extension' => array_map(fn(Attachment $a) => $a->extension(), $email->attachments),
            'attachment_count'     => count($email->attachments),
            'date'                 => $email->date->getTimestamp(),
            default                => '',
        };
    }

    /** User patterns are entered without delimiters; always case-insensitive + UTF-8. */
    private static function regex(string $pattern): string
    {
        return '~' . str_replace('~', '\~', $pattern) . '~iu';
    }

    private static function toTimestamp(string $value): ?float
    {
        $ts = strtotime($value);
        return $ts === false ? null : (float) $ts;
    }
}
