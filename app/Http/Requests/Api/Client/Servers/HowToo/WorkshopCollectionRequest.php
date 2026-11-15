<?php

namespace Pterodactyl\Http\Requests\Api\Client\Servers\HowToo;

class WorkshopCollectionRequest extends WorkshopReadRequest
{
    public function rules(): array
    {
        return [
            'link' => 'required|string|min:1|max:300',
        ];
    }
}
