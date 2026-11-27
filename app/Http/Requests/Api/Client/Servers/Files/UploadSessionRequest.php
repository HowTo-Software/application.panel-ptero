<?php

namespace Pterodactyl\Http\Requests\Api\Client\Servers\Files;

use Pterodactyl\Models\Permission;
use Pterodactyl\Http\Requests\Api\Client\ClientApiRequest;

class UploadSessionRequest extends ClientApiRequest
{
    public function permission(): string
    {
        return Permission::ACTION_FILE_CREATE;
    }

    public function rules(): array
    {
        return [
            'directory' => 'nullable|string|max:4096',
            'name' => 'required|string|max:255',
            'size' => 'required|integer|min:0',
            // File.lastModified from the browser (milliseconds). Part of the session identity so that
            // picking the very same file again resumes it, while an edited file with the same name and
            // size starts over.
            'mtime' => 'nullable|integer|min:0',
        ];
    }
}
