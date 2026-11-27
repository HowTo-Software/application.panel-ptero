<?php

namespace Pterodactyl\Enum;

enum JwtScope: string
{
    case Websocket = 'websocket';
    case FileUpload = 'file-upload';
    case FileUploadSession = 'upload-session';
    case FileDownload = 'file-download';
    case BackupDownload = 'backup-download';
    case ServerTransfer = 'transfer';
}
