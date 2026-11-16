<?php

namespace Pterodactyl\Http\Requests\Api\Client\Servers\HowToo;

use Pterodactyl\Models\Permission;
use Pterodactyl\Contracts\Http\ClientPermissionsRequest;
use Pterodactyl\Http\Requests\Api\Client\ClientApiRequest;
use Pterodactyl\Services\HowToo\ZomboidWorkshopConfigService;

class WorkshopUpdateRequest extends ClientApiRequest implements ClientPermissionsRequest
{
    public function authorize(): bool
    {
        if (!parent::authorize()) {
            return false;
        }

        if ($this->input('action') === 'restart') {
            return $this->user()->can(Permission::ACTION_CONTROL_RESTART, $this->route()->parameter('server'));
        }

        return true;
    }

    public function permission(): string
    {
        return Permission::ACTION_INTEGRATION_WORKSHOP_UPDATE;
    }

    public function rules(): array
    {
        return [
            'workshop_items' => 'present|array|max:500',
            'workshop_items.*' => ['required', 'string', 'regex:/^\d{1,20}$/'],
            'mods' => 'present|array|max:500',
            'mods.*' => ['required', 'string', 'regex:' . ZomboidWorkshopConfigService::MOD_ID_PATTERN],
            'workshop_mods' => 'sometimes|array|max:500',
            'workshop_mods.*' => 'present|array|max:500',
            'workshop_mods.*.*' => ['required', 'string', 'regex:' . ZomboidWorkshopConfigService::MOD_ID_PATTERN],
            'revision' => ['required', 'string', 'regex:/^[a-f0-9]{64}$/'],
            'action' => 'required|string|in:save,restart',
        ];
    }
}
