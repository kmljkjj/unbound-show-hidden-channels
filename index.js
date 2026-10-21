(function () {
	'use strict';

	// ShowHiddenChannels - port Unbound v1.4.0
	// IMPORTANT : ce fichier doit rester UNE seule expression qui retourne l'objet
	// du plugin. Unbound evalue les bundles avec eval('(() => { return ' + bundle + ' })') :
	// un fichier CommonJS (require / module.exports) ou un commentaire AVANT
	// l'expression fait retourner undefined au loader, et start() n'est jamais appele.
	// (c'etait le bug des versions <= 1.3.0 : aucun toast, aucun effet)
	//
	// Logique portee de Lioncat6/revenge, c10udburst/vendetta et
	// yofukashino/tharkidetta (ShowHiddenChannels) vers l'API Unbound.

	var VERSION = '1.4.0';

	function resolveApi() {
		try {
			if (typeof unbound === 'object' && unbound && unbound.metro) return unbound;
		} catch (_) {}
		try {
			if (typeof window === 'object' && window && window.unbound && window.unbound.metro) return window.unbound;
		} catch (_) {}
		try {
			if (typeof globalThis === 'object' && globalThis.unbound && globalThis.unbound.metro) return globalThis.unbound;
		} catch (_) {}
		return null;
	}

	var api = resolveApi();
	var metro = api ? api.metro : null;
	var patcher = api ? api.patcher : null;
	var toasts = api ? api.toasts : null;

	var Patcher = null;
	try {
		if (patcher && typeof patcher.createPatcher === 'function') {
			Patcher = patcher.createPatcher('show-hidden-channels');
		}
	} catch (_) {}

	var state = { patches: [], addedIsHidden: null };

	function toast(content) {
		try {
			if (toasts && typeof toasts.showToast === 'function') {
				toasts.showToast({ title: 'ShowHiddenChannels', content: String(content) });
				return;
			}
		} catch (_) {}
		try { console.log('[ShowHiddenChannels] ' + content); } catch (_) {}
	}

	function firstResult(tries) {
		for (var i = 0; i < tries.length; i++) {
			try {
				var value = tries[i]();
				if (value != null) return value;
			} catch (_) {}
		}
		return null;
	}

	function samePerm(a, b) {
		if (a === b) return true;
		try {
			if (typeof BigInt === 'function') return BigInt(a) === BigInt(b);
		} catch (_) {}
		return String(a) === String(b);
	}

	function refreshChannelList(Dispatcher) {
		try {
			var handlers = Dispatcher && Dispatcher._actionHandlers;
			var graph = handlers && handlers._dependencyGraph;
			var nodes = graph && graph.nodes ? Object.values(graph.nodes) : [];
			for (var i = 0; i < nodes.length; i++) {
				var node = nodes[i];
				if (!node || !node.actionHandler) continue;
				try {
					if (node.name === 'PermissionStore') {
						var h = node.actionHandler.handleConnectionOpen || node.actionHandler.CONNECTION_OPEN;
						if (typeof h === 'function') h.call(node.actionHandler);
					} else if (node.name === 'ChannelListStore') {
						var h2 = node.actionHandler.handleReset || node.actionHandler.CONNECTION_OPEN;
						if (typeof h2 === 'function') h2.call(node.actionHandler);
					}
				} catch (_) {}
			}
		} catch (_) {}
	}

	function start() {
		if (!metro || !Patcher) {
			toast('ERREUR: API Unbound introuvable - v' + VERSION);
			return;
		}

		var PermissionStore = firstResult([
			function () { return metro.findStore && metro.findStore('Permission'); },
			function () { return metro.findByProps && metro.findByProps('getChannelPermissions', 'can'); },
			function () { return metro.findByProps && metro.findByProps('can', 'canWithPartialContext'); }
		]);

		if (!PermissionStore || typeof PermissionStore.can !== 'function') {
			toast('ERREUR: PermissionStore (can) introuvable - v' + VERSION);
			return;
		}

		var Constants = firstResult([
			function () { return metro.common && metro.common.Constants; },
			function () { return metro.findByProps && metro.findByProps('Permissions', 'ChannelTypes'); },
			function () { return metro.findByProps && metro.findByProps('VIEW_CHANNEL', 'SEND_MESSAGES'); }
		]);

		var perms = (Constants && Constants.Permissions) || null;
		var VIEW = perms && perms.VIEW_CHANNEL != null ? perms.VIEW_CHANNEL : 1024;
		var CONNECT = perms && perms.CONNECT != null ? perms.CONNECT : 1048576;
		try {
			if (typeof BigInt === 'function') {
				VIEW = BigInt(VIEW);
				CONNECT = BigInt(CONNECT);
			}
		} catch (_) {}

		var ChannelStore = firstResult([
			function () { return metro.findStore && metro.findStore('Channel'); },
			function () { return metro.findByProps && metro.findByProps('getChannel', 'getMutableGuildChannelsForGuild'); }
		]);

		var MessageActions = firstResult([
			function () { return metro.findByProps && metro.findByProps('jumpToMessage', '_sendMessage'); },
			function () { return metro.findByProps && metro.findByProps('fetchMessages', 'sendMessage'); }
		]);

		var UnreadStore = firstResult([
			function () { return metro.findByProps && metro.findByProps('isForumPostUnread'); }
		]);

		var Dispatcher = firstResult([
			function () { return metro.common && metro.common.Dispatcher; },
			function () { return metro.findByProps && metro.findByProps('_currentDispatchActionType', '_processingWaitQueue'); },
			function () { return metro.findByProps && metro.findByProps('dispatch', 'subscribe'); }
		]);

		// Reference au VRAI can(), capturee avant le patch : elle reste non-patchee
		// et permet de savoir quels salons sont reellement refuses par le serveur.
		var realCan = PermissionStore.can.bind(PermissionStore);

		function realCanView(channel) {
			if (!channel) return true;
			try { return !!realCan(VIEW, channel); } catch (_) { return true; }
		}

		function resolveChannel(target) {
			if (!target || typeof target !== 'object') return null;
			if (target.guild_id != null || (target.id != null && target.type != null)) return target;
			if (target.channel && typeof target.channel === 'object' &&
				(target.channel.id != null || target.channel.guild_id != null)) return target.channel;
			if (target.channelId != null && ChannelStore && typeof ChannelStore.getChannel === 'function') {
				try { return ChannelStore.getChannel(target.channelId); } catch (_) { return null; }
			}
			return null;
		}

		function channelRestricted(target) {
			var resolved = resolveChannel(target);
			if (!resolved) return false;
			return !realCanView(resolved);
		}

		// 1) PermissionStore.can : VIEW_CHANNEL -> true, CONNECT -> false,
		// uniquement pour les salons reellement refuses (verifies via le vrai can).
		state.patches.push(Patcher.after(PermissionStore, 'can', function (ctx) {
			try {
				var perm = ctx.args && ctx.args[0];
				var target = ctx.args && ctx.args[1];
				if (target == null || typeof target !== 'object') return ctx.result;
				if (!channelRestricted(target)) return ctx.result;
				if (samePerm(perm, VIEW)) return true;
				if (samePerm(perm, CONNECT)) return false;
			} catch (_) {}
			return ctx.result;
		}));

		// 2) canWithPartialContext : meme logique pour les contextes { guildId, channelId }.
		if (typeof PermissionStore.canWithPartialContext === 'function') {
			state.patches.push(Patcher.after(PermissionStore, 'canWithPartialContext', function (ctx) {
				try {
					var perm = ctx.args && ctx.args[0];
					var target = ctx.args && ctx.args[1];
					if (target == null || typeof target !== 'object') return ctx.result;
					if (!channelRestricted(target)) return ctx.result;
					if (samePerm(perm, VIEW)) return true;
					if (samePerm(perm, CONNECT)) return false;
				} catch (_) {}
				return ctx.result;
			}));
		}

		// 3) ChannelRecordBase.isHidden : marquer les salons reellement caches,
		// comme le fait le client Discord natif. Ajoute seulement s'il manque.
		try {
			if (metro.findByProps) {
				var owner = metro.findByProps('ChannelRecordBase');
				var ChannelRecordBase = owner && owner.ChannelRecordBase;
				if (ChannelRecordBase && ChannelRecordBase.prototype &&
					typeof ChannelRecordBase.prototype.isHidden !== 'function') {
					ChannelRecordBase.prototype.isHidden = function () {
						try {
							var t = this.type;
							if (t === 1 || t === 3) return false;
							return !realCanView(this);
						} catch (_) { return false; }
					};
					state.addedIsHidden = ChannelRecordBase;
				}
			}
		} catch (_) {}

		// 4) Ne jamais charger les messages d'un salon reellement cache (le serveur renverrait une erreur).
		if (MessageActions && typeof MessageActions.fetchMessages === 'function') {
			state.patches.push(Patcher.instead(MessageActions, 'fetchMessages', function (ctx) {
				try {
					var args = ctx.args || [];
					var cid = args[0] && args[0].channelId;
					if (cid != null && ChannelStore && typeof ChannelStore.getChannel === 'function') {
						var channel = ChannelStore.getChannel(cid);
						if (channel && !realCanView(channel)) return null;
					}
				} catch (_) {}
				return ctx.original.apply(ctx.this, ctx.args);
			}));
		}

		// 5) UnreadStore : pas de badges de non-lu sur les salons caches.
		if (UnreadStore) {
			var unreadMethods = ['getGuildChannelUnreadState', 'getMentionCount', 'getUnreadCount'];
			for (var i = 0; i < unreadMethods.length; i++) {
				try {
					(function (methodName) {
						if (typeof UnreadStore[methodName] !== 'function') return;
						state.patches.push(Patcher.after(UnreadStore, methodName, function (ctx) {
							try {
								var id = ctx.args && ctx.args[0];
								var cid = id && typeof id === 'object' && id.channelId != null ? id.channelId : id;
								if (cid == null || !ChannelStore || typeof ChannelStore.getChannel !== 'function') return ctx.result;
								var channel = ChannelStore.getChannel(cid);
								if (channel && !realCanView(channel)) {
									if (methodName === 'getGuildChannelUnreadState') {
										return { mentionCount: 0, hasNotableUnread: false };
									}
									return 0;
								}
							} catch (_) {}
							return ctx.result;
						}));
					})(unreadMethods[i]);
				} catch (_) {}
			}
		}

		// 6) Reconstruire la liste des salons pour que le changement soit visible.
		refreshChannelList(Dispatcher);

		toast('Actif v' + VERSION + ' - change de serveur puis reviens');
	}

	function stop() {
		for (var i = 0; i < state.patches.length; i++) {
			try { state.patches[i](); } catch (_) {}
		}
		state.patches.length = 0;
		try { if (Patcher) Patcher.unpatchAll(); } catch (_) {}

		if (state.addedIsHidden) {
			try { delete state.addedIsHidden.prototype.isHidden; } catch (_) {}
			state.addedIsHidden = null;
		}

		var dispatcher = null;
		try {
			dispatcher = (metro && metro.common && metro.common.Dispatcher) ||
				(metro && metro.findByProps &&
					metro.findByProps('_currentDispatchActionType', '_processingWaitQueue'));
		} catch (_) {}
		refreshChannelList(dispatcher);
		toast('Desactive');
	}

	return {
		start: start,
		stop: stop,
		default: { start: start, stop: stop }
	};
})()