const _CONVERSION_UNIT = 1024;
const _BYTE_UNITS = ['Bytes', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];

/**
 * Given a value in megabytes converts it back down into bytes.
 */
function mbToBytes(megabytes: number): number {
    return Math.floor(megabytes * _CONVERSION_UNIT * _CONVERSION_UNIT);
}

/**
 * Given an amount of bytes, converts them into a human readable string format
 * using "1024" as the divisor.
 */
function bytesToString(bytes: number, decimals = 2): string {
    const k = _CONVERSION_UNIT;

    if (bytes < 1) return '0 Bytes';

    decimals = Math.floor(Math.max(0, decimals));
    const rawIndex = Math.floor(Math.log(bytes) / Math.log(k));
    const i = Math.min(rawIndex, _BYTE_UNITS.length - 1);
    const value = Number((bytes / Math.pow(k, i)).toFixed(decimals));

    return `${value} ${_BYTE_UNITS[i]}`;
}

/**
 * Formats an IPv4 or IPv6 address.
 */
function ip(value: string): string {
    // Linear-time equivalent of /([a-f0-9:]+:+)+[a-f0-9]+/, which was vulnerable to catastrophic backtracking.
    return /[A-Fa-f0-9:]:[A-Fa-f0-9]/.test(value) ? `[${value}]` : value;
}

export { ip, mbToBytes, bytesToString };
