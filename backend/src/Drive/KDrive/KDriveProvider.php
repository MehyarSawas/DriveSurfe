<?php declare(strict_types=1);

namespace DriveSurfe\Drive\KDrive;

use League\OAuth2\Client\Provider\AbstractProvider;
use League\OAuth2\Client\Provider\GenericResourceOwner;
use League\OAuth2\Client\Token\AccessToken;
use Psr\Http\Message\ResponseInterface;

final class KDriveProvider extends AbstractProvider
{
    public function getBaseAuthorizationUrl(): string
    {
        return 'https://login.infomaniak.com/authorize';
    }

    public function getBaseAccessTokenUrl(array $params): string
    {
        return 'https://login.infomaniak.com/token';
    }

    public function getResourceOwnerDetailsUrl(AccessToken $token): string
    {
        return 'https://api.infomaniak.com/1/profile';
    }

    public function getDefaultScopes(): array
    {
        return ['openid', 'profile', 'email'];
    }

    protected function checkResponse(ResponseInterface $response, $data): void
    {
        if (!empty($data['error'])) {
            throw new \League\OAuth2\Client\Provider\Exception\IdentityProviderException(
                $data['error_description'] ?? $data['error'],
                $response->getStatusCode(),
                $data
            );
        }
    }

    protected function createResourceOwner(array $response, AccessToken $token): GenericResourceOwner
    {
        return new GenericResourceOwner($response['data'] ?? $response, 'id');
    }

    protected function getScopeSeparator(): string
    {
        return ' ';
    }
}
