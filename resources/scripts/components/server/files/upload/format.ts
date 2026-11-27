const BINARY_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

/**
 * Formats a byte count using binary units (the same convention the file manager already uses for
 * file sizes, e.g. "152.78 MiB").
 */
export const formatBytes = (bytes: number, decimals = 2): string => {
    if (!Number.isFinite(bytes) || bytes <= 0) {
        return '0 B';
    }

    const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BINARY_UNITS.length - 1);
    const value = bytes / Math.pow(1024, exponent);

    return `${exponent === 0 ? value : value.toFixed(decimals)} ${BINARY_UNITS[exponent]}`;
};

/**
 * Formats a transfer rate in MB/s. Network throughput is conventionally decimal (1 MB = 1,000,000
 * bytes), which is what bandwidth meters and speed tests report, so it is used here instead of MiB/s.
 */
export const formatSpeed = (bytesPerSecond: number): string => {
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
        return '0.00 MB/s';
    }

    return `${(bytesPerSecond / 1_000_000).toFixed(2)} MB/s`;
};

/**
 * Formats a remaining-time estimate. Returns a dash when no estimate can be made (no progress yet).
 */
export const formatEta = (seconds: number | null | undefined): string => {
    if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
        return '—';
    }

    const total = Math.ceil(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;

    if (hours > 0) {
        return `${hours}h ${String(minutes).padStart(2, '0')}m`;
    }
    if (minutes > 0) {
        return `${minutes}m ${String(secs).padStart(2, '0')}s`;
    }

    return `${secs}s`;
};

/**
 * Length of a string once encoded as UTF-8. Linux file names are limited to 255 *bytes*, not characters.
 */
export const utf8Length = (value: string): number => {
    let length = 0;

    for (const char of value) {
        const code = char.codePointAt(0) as number;
        length += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    }

    return length;
};
