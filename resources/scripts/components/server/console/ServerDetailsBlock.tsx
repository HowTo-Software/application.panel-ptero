import { translateUiText } from '@/i18n/uiTranslations';
import { getBrowserLocale } from '@/i18n/locale';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
    faClock,
    faCloudDownloadAlt,
    faCloudUploadAlt,
    faHdd,
    faMemory,
    faMicrochip,
    faWifi,
} from '@fortawesome/free-solid-svg-icons';
import { bytesToString, ip, mbToBytes } from '@/lib/formatters';
import { ServerContext } from '@/state/server';
import { SocketEvent, SocketRequest } from '@/components/server/events';
import UptimeDuration from '@/components/server/UptimeDuration';
import StatBlock from '@/components/server/console/StatBlock';
import useWebsocketEvent from '@/plugins/useWebsocketEvent';
import classNames from 'classnames';
import { capitalize } from '@/lib/strings';
import { parseResourceStats, ResourceStatKey, ResourceStats } from '@/components/server/console/resourceStats';
import useServerResourcePolling from '@/hooks/useServerResourcePolling';
import {
    AveragedMetric,
    averageNetworkRate,
    averageOf,
    formatDuration,
    loadHistory,
    recordSample,
    ResourceHistory,
    saveHistory,
} from '@/components/server/console/resourceAverages';

type Stats = ResourceStats;

const getBackgroundColor = (value: number, max: number | null): string | undefined => {
    const delta = !max ? 0 : value / max;

    if (delta > 0.8) {
        if (delta > 0.9) {
            return 'bg-red-500';
        }
        return 'bg-yellow-500';
    }

    return undefined;
};

const Limit = ({ limit, children }: { limit: string | null; children: React.ReactNode }) => (
    <>
        {children}
        <span className={'ml-1 text-gray-300 text-[70%] select-none'}>/ {limit || <>&infin;</>}</span>
    </>
);

const TooltipLines = ({ title, lines }: { title: string; lines: string[] }) => (
    <div className={'text-xs leading-5'}>
        <p className={'mb-0.5 font-semibold text-gray-50'}>{title}</p>
        {lines.map((line) => (
            <p key={line}>{line}</p>
        ))}
    </div>
);

const percentOf = (value: number, limit: number | null | undefined): string | null =>
    limit ? `${((value / limit) * 100).toFixed(0)}%` : null;

const ServerDetailsBlock = ({ className }: { className?: string }) => {
    const [stats, setStats] = useState<Stats>({ memory: 0, cpu: 0, disk: 0, uptime: 0, tx: 0, rx: 0 });
    const [resourceUnavailable, setResourceUnavailable] = useState(false);
    const lastSocketStatsAt = useRef<Partial<Record<ResourceStatKey, number>>>({});
    const hasLoggedRequestError = useRef(false);

    const status = ServerContext.useStoreState((state) => state.status.value);
    const connected = ServerContext.useStoreState((state) => state.socket.connected);
    const instance = ServerContext.useStoreState((state) => state.socket.instance);
    const serverUuid = ServerContext.useStoreState((state) => state.server.data!.uuid);
    const limits = ServerContext.useStoreState((state) => state.server.data!.limits);

    const [history, setHistory] = useState<ResourceHistory | null>(() => loadHistory(serverUuid));

    useEffect(() => {
        setHistory(loadHistory(serverUuid));
    }, [serverUuid]);

    // Every live sample of a running server feeds the averages shown on hover.
    useEffect(() => {
        if (status !== 'running' || stats.uptime <= 0) return;
        setHistory((current) => {
            const next = recordSample(current, stats, Date.now());
            saveHistory(serverUuid, next);
            return next;
        });
    }, [stats, status, serverUuid]);

    const textLimits = useMemo(
        () => ({
            cpu: limits?.cpu ? `${limits.cpu}%` : null,
            memory: limits?.memory ? bytesToString(mbToBytes(limits.memory)) : null,
            disk: limits?.disk ? bytesToString(mbToBytes(limits.disk)) : null,
        }),
        [limits]
    );

    const allocation = ServerContext.useStoreState((state) => {
        const match = state.server.data!.allocations.find((allocation) => allocation.isDefault);

        return !match ? 'n/a' : `${match.alias || ip(match.ip)}:${match.port}`;
    });

    useEffect(() => {
        lastSocketStatsAt.current = {};
    }, [serverUuid]);

    useServerResourcePolling(
        serverUuid,
        !connected,
        15000,
        (usage) => {
            hasLoggedRequestError.current = false;
            setResourceUnavailable(false);
            const patch = parseResourceStats(usage);
            const receivedAt = Date.now();

            setStats((current) => {
                const next = { ...current };
                (Object.keys(patch) as ResourceStatKey[]).forEach((key) => {
                    if (receivedAt - (lastSocketStatsAt.current[key] || 0) >= 20000) {
                        next[key] = patch[key]!;
                    }
                });

                return next;
            });
        },
        (error) => {
            const statusCode = (error as { response?: { status?: number } })?.response?.status;
            if (statusCode === 409 || statusCode === 503) setResourceUnavailable(true);
            if (!hasLoggedRequestError.current) {
                hasLoggedRequestError.current = true;
                const response = (
                    error as {
                        response?: { status?: number; data?: { errors?: Array<{ detail?: unknown }> } };
                    }
                )?.response;
                const detail = response?.data?.errors?.[0]?.detail;
                console.error('Unable to load server resource usage from the Panel API.', {
                    status: response?.status,
                    detail: typeof detail === 'string' ? detail : undefined,
                });
            }
        }
    );

    useEffect(() => {
        if (!connected || !instance) {
            return;
        }

        instance.send(SocketRequest.SEND_STATS);
    }, [instance, connected]);

    useWebsocketEvent(SocketEvent.STATS, (data) => {
        const patch = parseResourceStats(data);
        const receivedAt = Date.now();
        const keys = Object.keys(patch) as ResourceStatKey[];
        if (!keys.length) return;

        keys.forEach((key) => {
            lastSocketStatsAt.current[key] = receivedAt;
        });
        setResourceUnavailable(false);
        setStats((current) => ({ ...current, ...patch }));
    });

    const locale = getBrowserLocale() === 'pt' ? 'pt-BR' : 'en-US';
    const now = Date.now();
    const observed =
        history &&
        translateUiText('Observado por {{duration}}, desde {{time}} ({{count}} leituras).', {
            duration: formatDuration(now - history.observedSince),
            time: new Date(history.observedSince).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }),
            count: history.metrics.cpu.samples,
        });

    const averageTooltip = (
        metric: AveragedMetric,
        format: (value: number) => string,
        limit?: number | null
    ): React.ReactChild => {
        if (!history || status !== 'running') {
            return (
                <TooltipLines
                    title={translateUiText('Consumo médio')}
                    lines={[translateUiText('Sem dados: a média é calculada enquanto o servidor está ligado.')]}
                />
            );
        }
        const average = averageOf(history, metric, now);
        const ofLimit = percentOf(average, limit);

        return (
            <TooltipLines
                title={translateUiText('Consumo médio do servidor')}
                lines={[
                    `${translateUiText('Média:')} ${format(average)}${
                        ofLimit ? ` (${translateUiText('{{percent}} do limite', { percent: ofLimit })})` : ''
                    }`,
                    `${translateUiText('Pico:')} ${format(history.metrics[metric].peak)}`,
                    observed as string,
                ]}
            />
        );
    };

    const networkTooltip = (key: 'rx' | 'tx'): React.ReactChild => {
        const average = averageNetworkRate(stats, key);
        if (status !== 'running' || average === null) {
            return (
                <TooltipLines
                    title={translateUiText('Consumo médio')}
                    lines={[translateUiText('Sem dados: a média é calculada enquanto o servidor está ligado.')]}
                />
            );
        }
        const current = history?.[key === 'rx' ? 'rxRate' : 'txRate'];

        return (
            <TooltipLines
                title={translateUiText('Tráfego médio desde que o servidor ligou')}
                lines={[
                    `${translateUiText('Média:')} ${bytesToString(average)}/s (${formatDuration(stats.uptime)})`,
                    ...(current !== null && current !== undefined
                        ? [`${translateUiText('Agora:')} ${bytesToString(current)}/s`]
                        : []),
                    `${translateUiText('Total:')} ${bytesToString(stats[key])}`,
                ]}
            />
        );
    };

    return (
        <div className={classNames('min-w-0', className)}>
            {resourceUnavailable && (
                <p className={'mb-2 text-xs text-amber-300'} role={'status'}>
                    {translateUiText('Resource data temporarily unavailable')}
                </p>
            )}
            <StatBlock
                icon={faWifi}
                title={translateUiText('Address')}
                copyOnClick={allocation}
                iconColor={'#93c5fd'}
                iconBackground={'rgba(59, 130, 246, 0.14)'}
            >
                {allocation}
            </StatBlock>
            <StatBlock
                icon={faClock}
                title={translateUiText('Uptime')}
                color={getBackgroundColor(status === 'running' ? 0 : status !== 'offline' ? 9 : 10, 10)}
                iconColor={status === 'offline' ? '#fca5a5' : '#86efac'}
                iconBackground={status === 'offline' ? 'rgba(239, 68, 68, 0.14)' : 'rgba(34, 197, 94, 0.14)'}
            >
                {status === null ? (
                    'Offline'
                ) : stats.uptime > 0 ? (
                    <UptimeDuration uptime={stats.uptime / 1000} />
                ) : (
                    capitalize(status)
                )}
            </StatBlock>
            <StatBlock
                icon={faMicrochip}
                title={translateUiText('CPU Load')}
                color={getBackgroundColor(stats.cpu, limits.cpu)}
                tooltip={averageTooltip('cpu', (value) => `${value.toFixed(2)}%`, limits.cpu)}
                iconColor={'#c4b5fd'}
                iconBackground={'rgba(139, 92, 246, 0.14)'}
            >
                {status === 'offline' ? (
                    <span className={'text-gray-400'}>{translateUiText('Offline')}</span>
                ) : (
                    <Limit limit={textLimits.cpu}>{stats.cpu.toFixed(2)}%</Limit>
                )}
            </StatBlock>
            <StatBlock
                icon={faMemory}
                title={translateUiText('Memory')}
                color={getBackgroundColor(stats.memory / 1024, limits.memory * 1024)}
                tooltip={averageTooltip('memory', bytesToString, limits.memory ? mbToBytes(limits.memory) : null)}
                iconColor={'#67e8f9'}
                iconBackground={'rgba(6, 182, 212, 0.14)'}
            >
                {status === 'offline' ? (
                    <span className={'text-gray-400'}>{translateUiText('Offline')}</span>
                ) : (
                    <Limit limit={textLimits.memory}>{bytesToString(stats.memory)}</Limit>
                )}
            </StatBlock>
            <StatBlock
                icon={faHdd}
                title={translateUiText('Disk')}
                color={getBackgroundColor(stats.disk / 1024, limits.disk * 1024)}
                tooltip={averageTooltip('disk', bytesToString, limits.disk ? mbToBytes(limits.disk) : null)}
                iconColor={'#fcd34d'}
                iconBackground={'rgba(245, 158, 11, 0.14)'}
            >
                <Limit limit={textLimits.disk}>{bytesToString(stats.disk)}</Limit>
            </StatBlock>
            <StatBlock
                icon={faCloudDownloadAlt}
                title={translateUiText('Network (Inbound)')}
                tooltip={networkTooltip('rx')}
                iconColor={'#6ee7b7'}
                iconBackground={'rgba(16, 185, 129, 0.14)'}
            >
                {status === 'offline' ? (
                    <span className={'text-gray-400'}>{translateUiText('Offline')}</span>
                ) : (
                    bytesToString(stats.rx)
                )}
            </StatBlock>
            <StatBlock
                icon={faCloudUploadAlt}
                title={translateUiText('Network (Outbound)')}
                tooltip={networkTooltip('tx')}
                iconColor={'#d8b4fe'}
                iconBackground={'rgba(168, 85, 247, 0.14)'}
            >
                {status === 'offline' ? (
                    <span className={'text-gray-400'}>{translateUiText('Offline')}</span>
                ) : (
                    bytesToString(stats.tx)
                )}
            </StatBlock>
        </div>
    );
};

export default ServerDetailsBlock;
