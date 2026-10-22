(function () {
	'use strict';

	// ShowHiddenChannels - port Unbound v1.6.0
	// IMPORTANT : ce fichier doit rester UNE seule expression qui retourne l'objet
	// du plugin. Unbound evalue les bundles avec eval('(() => { return ' + bundle + ' })') :
	// un fichier CommonJS (require / module.exports) ou un commentaire AVANT
	// l'expression fait retourner undefined au loader, et start() n'est jamais appele.
	// (bug des versions <= 1.3.0)
	//
	// v1.5.0 :
	// - zero recalcul dans can() : le retournement VIEW_CHANNEL false->true exploite
	//   directement ctx.result (le vrai can vient de tourner). CONNECT et
	//   SEND_MESSAGES ne sont jamais modifies.
	// - cache de permissions par id de salon, rempli passivement par can() et
	//   invalide via un patch before sur Dispatcher.dispatch.
	// - filtres par type de salon : showText, showVoice, showStage, showForum,
	//   showDirectory (+ markHidden, blockUnreads, safety), persistes via storage.
	// - fetchMessages ET jumpToMessage bloques pour les salons reellement restreints.
	// - garde anti double-start, patches proteges (okPatch), toast de diagnostic,
	//   handle unbound.__showHiddenChannels.
	//
	// v1.6.0 :
	// - garde vocal : joinVoiceChannel et selectVoiceChannel bloques pour les
	//   salons restreints (toast explicatif) au lieu d'une erreur serveur 403.
	// - garde acknowledge (marquer comme lu) bloquee pour les salons restreints.
	// - invalidation du cache etendue : GUILD_ROLE_DELETE, GUILD_DELETE, THREAD_*,
	//   GUILD_MEMBER_ROLES_UPDATE, etc.
	// - diagnostics a deux niveaux : manques CRITIQUES seulement dans le toast
	//   (can, canWithPartialContext, dispatch), manques optionnels uniquement
	//   dans dump().optionalMissing (pas d'alerte inutile).
	// - setSetting confirme par un toast + getSetting(nom) dans le handle.

	var VERSION = '1.6.0';
	var STORE_KEY = 'show-hidden-channels';
	var SETTINGS_KEY = 'settings';

	var DEFAULT_SETTINGS = {
		showText: true,
		showVoice: true,
		showStage: true,
		showForum: true,
		showDirectory: true,
		markHidden: true,
		blockUnreads: true,
		safety: true
	};

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

	var state = {
		started: false,
		patches: [],
		addedIsHidden: null,
		permCache: {},
		settings: {},
		missing: [],
		optionalMissing: []
	};

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

	function getStore() {
		try {
			if (api && api.storage && typeof api.storage.getStore === 'function') {
				return api.storage.getStore(STORE_KEY);
			}
		} catch (_) {}
		return null;
	}

	function loadSettings() {
		var s = {};
		for (var k in DEFAULT_SETTINGS) s[k] = DEFAULT_SETTINGS[k];
		var raw = null;
		try {
			var store = getStore();
			if (store) {
				try {
					if (typeof store.get === 'function') raw = store.get(SETTINGS_KEY);
				} catch (_) {}
				if (raw == null) {
					try {
						if (SETTINGS_KEY in store) raw = store[SETTINGS_KEY];
					} catch (_) {}
				}
			}
		} catch (_) {}
		if (raw != null) {
			try {
				var parsed = (typeof raw === 'string') ? JSON.parse(raw) : raw;
				if (parsed && typeof parsed === 'object') {
					for (var k2 in DEFAULT_SETTINGS) {
						if (typeof parsed[k2] === 'boolean') s[k2] = parsed[k2];
					}
				}
			} catch (_) {}
		}
		state.settings = s;
		return s;
	}

	function saveSettings() {
		try {
			var store = getStore();
			if (!store) return;
			var raw = JSON.stringify(state.settings);
			try {
				if (typeof store.set === 'function') { store.set(SETTINGS_KEY, raw); return; }
			} catch (_) {}
			try { store[SETTINGS_KEY] = raw; } catch (_) {}
		} catch (_) {}
	}

	function setSetting(name, value) {
		try {
			if (!(name in DEFAULT_SETTINGS)) return false;
			if (typeof value !== 'boolean') return false;
			state.settings[name] = value;
			saveSettings();
			toast('Reglage ' + name + ' = ' + value);
			return true;
		} catch (_) {
			return false;
		}
	}

	function getSetting(name) {
		try {
			return (name in state.settings) ? state.settings[name] : undefined;
		} catch (_) {
			return undefined;
		}
	}

	function typeShown(channel) {
		try {
			var t = channel.type;
			if (t === 1 || t === 3) return false;
			if (t === 4) return true;
			if (t === 0 || t === 5 || t === 6 || t === 16) return !!state.settings.showText;
			if (t === 2) return !!state.settings.showVoice;
			if (t === 13) return !!state.settings.showStage;
			if (t === 15) return !!state.settings.showForum;
			if (t === 14) return !!state.settings.showDirectory;
			return true;
		} catch (_) {
			return true;
		}
	}

	function start() {
		if (state.started) {
			toast('Deja actif - v' + VERSION);
			return;
		}
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

		var VoiceModule = firstResult([
			function () { return metro.findByProps && metro.findByProps('joinVoiceChannel'); },
			function () { return metro.findByProps && metro.findByProps('selectVoiceChannel'); }
		]);

		var AckModule = firstResult([
			function () { return metro.findByProps && metro.findByProps('acknowledge'); }
		]);

		var UnreadStore = firstResult([
			function () { return metro.findByProps && metro.findByProps('isForumPostUnread'); }
		]);

		var Dispatcher = firstResult([
			function () { return metro.common && metro.common.Dispatcher; },
			function () { return metro.findByProps && metro.findByProps('_currentDispatchActionType', '_processingWaitQueue'); },
			function () { return metro.findByProps && metro.findByProps('dispatch', 'subscribe'); }
		]);

		loadSettings();
		state.permCache = {};
		state.missing = [];
		state.optionalMissing = [];

		// Reference au VRAI can(), capturee avant le patch : elle reste non-patchee
		// et sert de fallback quand le cache de permissions est froid.
		var realCan = PermissionStore.can.bind(PermissionStore);

		function realCanView(channel) {
			if (!channel) return true;
			try { return !!realCan(VIEW, channel); } catch (_) { return true; }
		}

		function isRestrictedCached(channel) {
			if (!channel || channel.id == null) return false;
			var id = String(channel.id);
			if (Object.prototype.hasOwnProperty.call(state.permCache, id)) {
				return !!state.permCache[id];
			}
			try {
				var restricted = !realCanView(channel);
				state.permCache[id] = restricted;
				return restricted;
			} catch (_) {
				return false;
			}
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

		// okPatch : patches proteges. optional=true : echec silencieux (compte
		// seulement dans dump().optionalMissing), sinon manque critique dans le toast.
		function okPatch(label, factory, optional) {
			try {
				var unpatch = factory();
				if (typeof unpatch === 'function') {
					state.patches.push(unpatch);
					return true;
				}
			} catch (_) {}
			if (optional) {
				state.optionalMissing.push(label);
			} else {
				state.missing.push(label);
			}
			return false;
		}

		// 1) PermissionStore.can : retournement VIEW_CHANNEL false -> true SANS aucun
		//    recalcul (ctx.result est deja le verdict du vrai can) + remplissage
		//    passif du cache de permissions. CONNECT/SEND jamais modifies.
		okPatch('PermissionStore.can', function () {
			return Patcher.after(PermissionStore, 'can', function (ctx) {
				try {
					var perm = ctx.args && ctx.args[0];
					var target = ctx.args && ctx.args[1];
					if (target == null || typeof target !== 'object') return ctx.result;
					if (!samePerm(perm, VIEW)) return ctx.result;
					var channel = resolveChannel(target);
					if (!channel || channel.id == null) return ctx.result;
					var id = String(channel.id);
					var restricted = (ctx.result === false);
					state.permCache[id] = restricted;
					if (restricted && typeShown(channel)) ctx.result = true;
				} catch (_) {}
				return ctx.result;
			});
		});

		// 2) canWithPartialContext : meme logique pour les contextes { guildId, channelId }.
		okPatch('PermissionStore.canWithPartialContext', function () {
			if (typeof PermissionStore.canWithPartialContext !== 'function') return null;
			return Patcher.after(PermissionStore, 'canWithPartialContext', function (ctx) {
				try {
					var perm = ctx.args && ctx.args[0];
					var target = ctx.args && ctx.args[1];
					if (target == null || typeof target !== 'object') return ctx.result;
					if (!samePerm(perm, VIEW)) return ctx.result;
					if (target.channelId == null) return ctx.result;
					if (!ChannelStore || typeof ChannelStore.getChannel !== 'function') return ctx.result;
					var channel = null;
					try { channel = ChannelStore.getChannel(target.channelId); } catch (_) {}
					if (!channel || channel.id == null) return ctx.result;
					state.permCache[String(channel.id)] = (ctx.result === false);
					if (ctx.result === false && typeShown(channel)) ctx.result = true;
				} catch (_) {}
				return ctx.result;
			});
		});

		// 3) Invalidation automatique du cache de permissions.
		var INVALIDATE = {
			GUILD_ROLE_UPDATE: 1,
			GUILD_ROLE_DELETE: 1,
			GUILD_MEMBER_UPDATE: 1,
			GUILD_MEMBER_ROLES_UPDATE: 1,
			CHANNEL_UPDATE: 1,
			CHANNEL_CREATE: 1,
			CHANNEL_DELETE: 1,
			CHANNEL_OVERWRITE_CREATE: 1,
			CHANNEL_OVERWRITE_UPDATE: 1,
			CHANNEL_OVERWRITE_DELETE: 1,
			THREAD_CREATE: 1,
			THREAD_UPDATE: 1,
			THREAD_DELETE: 1,
			GUILD_DELETE: 1,
			CONNECTION_OPEN: 1,
			USER_GUILD_SETTINGS_UPDATE: 1
		};
		okPatch('Dispatcher.dispatch', function () {
			if (!Dispatcher || typeof Dispatcher.dispatch !== 'function') return null;
			return Patcher.before(Dispatcher, 'dispatch', function (ctx) {
				try {
					var action = ctx.args && ctx.args[0];
					var type = action && action.type;
					if (type && INVALIDATE[type]) state.permCache = {};
				} catch (_) {}
			});
		});

		// 4) ChannelRecordBase.isHidden : marquer les salons reellement caches,
		//    comme le client natif. Ajout direct seulement s'il manque ; retire dans stop().
		try {
			if (metro.findByProps) {
				var owner = metro.findByProps('ChannelRecordBase');
				var ChannelRecordBase = owner && owner.ChannelRecordBase;
				if (ChannelRecordBase && ChannelRecordBase.prototype &&
					typeof ChannelRecordBase.prototype.isHidden !== 'function') {
					ChannelRecordBase.prototype.isHidden = function () {
						try {
							if (!state.settings.markHidden) return false;
							var t = this.type;
							if (t === 1 || t === 3) return false;
							return isRestrictedCached(this);
						} catch (_) { return false; }
					};
					state.addedIsHidden = ChannelRecordBase;
				}
			}
		} catch (_) {}

		// 5) Securite : jamais solliciter un salon reellement cache. Les gardes ne
		//    bloquent QUE si l'argument resout vers un salon restreint connu du
		//    ChannelStore (sans effet de bord sur les autres appels).
		function extractChannelId(args) {
			try {
				if (!args || !args.length) return null;
				var a = args[0];
				if (a != null && typeof a === 'object') {
					if (a.channelId != null) return a.channelId;
					if (a.channel && a.channel.id != null) return a.channel.id;
					return null;
				}
				if (typeof a === 'string' || typeof a === 'number') return a;
				return null;
			} catch (_) {
				return null;
			}
		}

		function guardAction(label, obj, method, onBlock) {
			okPatch(label, function () {
				if (!obj || typeof obj[method] !== 'function') return null;
				return Patcher.instead(obj, method, function (ctx) {
					try {
						if (!state.settings.safety) return ctx.original.apply(ctx.this, ctx.args);
						var cid = extractChannelId(ctx.args);
						if (cid != null && ChannelStore && typeof ChannelStore.getChannel === 'function') {
							var channel = ChannelStore.getChannel(cid);
							if (channel && isRestrictedCached(channel)) {
								if (typeof onBlock === 'function') {
									try { onBlock(channel); } catch (_) {}
								}
								return null;
							}
						}
					} catch (_) {}
					return ctx.original.apply(ctx.this, ctx.args);
				});
			}, true);
		}
		guardAction('MessageActions.fetchMessages', MessageActions, 'fetchMessages');
		guardAction('MessageActions.jumpToMessage', MessageActions, 'jumpToMessage');
		guardAction('VoiceModule.joinVoiceChannel', VoiceModule, 'joinVoiceChannel', function () {
			toast('Salon vocal restreint : connexion bloquee');
		});
		guardAction('VoiceModule.selectVoiceChannel', VoiceModule, 'selectVoiceChannel', function () {
			toast('Salon vocal restreint : connexion bloquee');
		});
		guardAction('AckModule.acknowledge', AckModule, 'acknowledge');

		// 6) UnreadStore : aucun badge de non-lu sur les salons reellement caches.
		var unreadMethods = ['getGuildChannelUnreadState', 'getMentionCount', 'getUnreadCount'];
		for (var i = 0; i < unreadMethods.length; i++) {
			(function (methodName) {
				okPatch('UnreadStore.' + methodName, function () {
					if (!UnreadStore || typeof UnreadStore[methodName] !== 'function') return null;
					return Patcher.after(UnreadStore, methodName, function (ctx) {
						try {
							if (!state.settings.blockUnreads) return ctx.result;
							var id = ctx.args && ctx.args[0];
							var cid = id && typeof id === 'object' && id.channelId != null ? id.channelId : id;
							if (cid == null || !ChannelStore || typeof ChannelStore.getChannel !== 'function') return ctx.result;
							var channel = ChannelStore.getChannel(cid);
							if (channel && isRestrictedCached(channel)) {
								if (methodName === 'getGuildChannelUnreadState') {
									ctx.result = { mentionCount: 0, hasNotableUnread: false };
								} else {
									ctx.result = 0;
								}
							}
						} catch (_) {}
						return ctx.result;
					});
				}, true);
			})(unreadMethods[i]);
		}

		// 7) Reconstruire la liste des salons pour que le changement soit visible.
		refreshChannelList(Dispatcher);

		state.started = true;

		var handle = {
			setSetting: setSetting,
			getSetting: getSetting,
			getSettings: function () { return state.settings; },
			getHiddenChannelIds: function () {
				var out = [];
				for (var id in state.permCache) {
					if (state.permCache[id]) out.push(id);
				}
				return out;
			},
			refresh: function () { refreshChannelList(Dispatcher); },
			dump: function () {
				return {
					version: VERSION,
					patchCount: state.patches.length,
					missing: state.missing.slice(),
					optionalMissing: state.optionalMissing.slice(),
					settings: state.settings,
					hiddenIds: handle.getHiddenChannelIds()
				};
			}
		};
		try { api.__showHiddenChannels = handle; } catch (_) {}

		var content = 'Actif v' + VERSION + ' - ' + state.patches.length + ' patches';
		if (state.missing.length) {
			content += ' (manque: ' + state.missing.join(', ') + ')';
		} else {
			content += ' - change de serveur puis reviens';
		}
		toast(content);
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

		state.permCache = {};
		state.missing = [];
		state.optionalMissing = [];
		state.started = false;

		try { if (api) delete api.__showHiddenChannels; } catch (_) {}

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