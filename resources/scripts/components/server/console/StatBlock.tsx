import React from 'react';
import Icon from '@/components/elements/Icon';
import { IconDefinition } from '@fortawesome/free-solid-svg-icons';
import classNames from 'classnames';
import styles from './style.module.css';
import CopyOnClick from '@/components/elements/CopyOnClick';
import Tooltip from '@/components/elements/tooltip/Tooltip';

interface StatBlockProps {
    title: string;
    copyOnClick?: string;
    color?: string | undefined;
    iconColor?: string;
    iconBackground?: string;
    icon: IconDefinition;
    /** Shown on hover/focus, e.g. the average usage of the current run. */
    tooltip?: React.ReactChild;
    children: React.ReactNode;
    className?: string;
}

export default ({
    title,
    copyOnClick,
    icon,
    color,
    iconColor,
    iconBackground,
    className,
    tooltip,
    children,
}: StatBlockProps) => {
    const block = (
        <div className={classNames(styles.stat_block, className)} tabIndex={tooltip ? 0 : undefined}>
            <div className={classNames(styles.status_bar, color || 'bg-gray-700')} />
            <div
                className={classNames(styles.icon, !iconBackground && (color || 'bg-gray-700'))}
                style={iconBackground ? { backgroundColor: iconBackground } : undefined}
            >
                <Icon
                    icon={icon}
                    className={classNames(!iconColor && 'text-gray-100')}
                    style={iconColor ? { color: iconColor } : undefined}
                />
            </div>
            <div className={'flex min-w-0 flex-col justify-center overflow-hidden w-full'}>
                <p
                    className={
                        'font-header font-medium leading-tight text-[10px] uppercase tracking-wide text-gray-400'
                    }
                >
                    {title}
                </p>
                <div className={'w-full truncate text-sm font-semibold leading-5 text-gray-50'}>{children}</div>
            </div>
        </div>
    );

    return (
        <CopyOnClick text={copyOnClick}>
            {tooltip ? (
                <Tooltip content={tooltip} placement={'right'} arrow>
                    {block}
                </Tooltip>
            ) : (
                block
            )}
        </CopyOnClick>
    );
};
