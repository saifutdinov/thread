import { signal } from '@preact/signals';
import { remembered, remember } from './devices';
import type { NetworkMode } from './network-policy';

const saved = remembered('callNetworkMode');
export const networkMode = signal<NetworkMode>(saved === 'economy' || saved === 'normal' ? saved : 'auto');
export function rememberNetworkMode(mode: NetworkMode) { networkMode.value = mode; remember('callNetworkMode', mode); }
