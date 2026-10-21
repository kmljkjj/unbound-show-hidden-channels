/**
 * ShowHiddenChannels for Unbound v1.2.0
 * Format matches official Unbound docs: import + export default.
 * Logic from Lioncat6 / c10udburst / yofukashino mobile ports.
 */

import { metro, patcher } from '@unbound-app/api';

const Patcher = patcher.createPatcher('show-hidden-channels');

function findPermissions() {
	try {
		const store = metro.findStore('Permission');
		if (store && typeof store.can === 'function') return store;
	} catch (_) {}
	try {
		const m = metro.findByProps('getChannelPermissions', 'can');
		if (m && typeof m.can === 'function') return m;
	} catch (_) {}
	try {
		const m = metro.findByProps('can', 'canWithPartialContext');
		if (m && typeof m.can === 'function') return m;
	} catch (_) {}
	return null;
}

function findViewChannel() {
	try {
		const P = metro.common?.Constants?.Permissions;
		if (P?.VIEW_CHANNEL != null) return P.VIEW_CHANNEL;
	} catch (_) {}
	try {
		const c = metro.findByProps('Permissions', 'ChannelTypes');
		if (c?.Permissions?.VIEW_CHANNEL != null) return c.Permissions.VIEW_CHANNEL;
	} catch (_) {}
	try {
		const c = metro.findByProps('VIEW_CHANNEL', 'SEND_MESSAGES');
		if (c?.VIEW_CHANNEL != null) return c.VIEW_CHANNEL;
	} catch (_) {}
	try {
		return BigInt(1024);
	} catch (_) {
		return 1024;
	}
}

function samePerm(a, b) {
	if (a === b) return true;
	try {
		if (typeof a === 'bigint' || typeof b === 'bigint') return BigInt(a) === BigInt(b);
	} catch (_) {}
	return String(a) === String(b);
}

function findChannelStore() {
	try {
		const s = metro.findStore('Channel');
		if (s?.getChannel) return s;
	} catch (_) {}
	try {
		return metro.findByProps('getChannel', 'getMutableGuildChannelsForGuild');
	} catch (_) {}
	try {
		return metro.findByProps('getChannel');
	} catch (_) {}
	return null;
}

function getChannel(idOrCh) {
	if (!idOrCh) return null;
	if (typeof idOrCh === 'object' && idOrCh.id) return idOrCh;
	const store = findChannelStore();
	try {
		return store?.getChannel?.(idOrCh) ?? null;
	} catch (_) {
		return null;
	}
}

function isHidden(channelOrId) {
	try {
		const channel = getChannel(channelOrId);
		if (!channel) return false;
		if (channel.type === 1 || channel.type === 3 || channel.type === 4) return false;

		const Permissions = findPermissions();
		const VIEW = findViewChannel();
		if (!Permissions?.can || VIEW == null) return false;

		channel.realCheck = true;
		let hidden = false;
		try {
			hidden = !Permissions.can(VIEW, channel);
		} finally {
			try {
				delete channel.realCheck;
			} catch (_) {
				channel.realCheck = false;
			}
		}
		return hidden;
	} catch (_) {
		return false;
	}
}

function forceRefresh() {
	try {
		const Dispatcher =
			metro.common?.Dispatcher ||
			metro.findByProps('_currentDispatchActionType', '_processingWaitQueue');
		if (!Dispatcher) return;

		const nodes = Dispatcher._actionHandlers?._dependencyGraph?.nodes
			? Object.values(Dispatcher._actionHandlers._dependencyGraph.nodes)
			: [];

		for (const node of nodes) {
			try {
				if (node?.name === 'PermissionStore') {
					const h =
						node.actionHandler?.CONNECTION_OPEN ||
						node.actionHandler?.handleConnectionOpen;
					if (typeof h === 'function') h({});
				}
				if (node?.name === 'ChannelListStore') {
					const h =
						node.actionHandler?.CONNECTION_OPEN ||
						node.actionHandler?.handleReset;
					if (typeof h === 'function') h({});
				}
			} catch (_) {}
		}
	} catch (_) {}
}

export default {
	start() {
		const Permissions = findPermissions();
		const VIEW = findViewChannel();

		if (!Permissions?.can) {
			console.error('[ShowHiddenChannels] Permissions.can not found');
			return;
		}
		if (VIEW == null) {
			console.error('[ShowHiddenChannels] VIEW_CHANNEL not found');
			return;
		}

		console.log('[ShowHiddenChannels] patching can, VIEW=', String(VIEW));

		// Core patch used by every working mobile port
		Patcher.after(Permissions, 'can', ({ args, result }) => {
			try {
				const [permID, channel] = args;
				if (!channel || channel.realCheck) return result;
				if (samePerm(permID, VIEW)) return true;
			} catch (_) {}
			return result;
		});

		// Some builds check via canWithPartialContext
		if (typeof Permissions.canWithPartialContext === 'function') {
			Patcher.after(Permissions, 'canWithPartialContext', ({ args, result }) => {
				try {
					const [permID, channel] = args;
					if (!channel || channel.realCheck) return result;
					if (samePerm(permID, VIEW)) return true;
				} catch (_) {}
				return result;
			});
		}

		// Avoid 403 when opening hidden channels
		try {
			const MessageActions =
				metro.findByProps('jumpToMessage', '_sendMessage') ||
				metro.findByProps('fetchMessages', 'sendMessage');
			if (MessageActions?.fetchMessages) {
				Patcher.instead(MessageActions, 'fetchMessages', ({ args, original }) => {
					try {
						const p = args[0];
						const id = p?.channelId || p?.id || p;
						if (isHidden(id)) return;
					} catch (_) {}
					return original(...args);
				});
			}
		} catch (_) {}

		forceRefresh();
		console.log('[ShowHiddenChannels] started');
	},

	stop() {
		Patcher.unpatchAll();
		forceRefresh();
		console.log('[ShowHiddenChannels] stopped');
	},
};
