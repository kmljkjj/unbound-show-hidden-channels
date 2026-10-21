/**
 * ShowHiddenChannels Unbound v1.3.0
 * - Toast on start so you KNOW the plugin ran
 * - Works with import OR global unbound
 * - Force VIEW_CHANNEL true (Lioncat6 / c10udburst style)
 */

var metro, patcher, toasts;

try {
	var api = require('@unbound-app/api');
	metro = api.metro;
	patcher = api.patcher;
	toasts = api.toasts;
} catch (_) {}

if ((!metro || !patcher) && typeof unbound !== 'undefined') {
	metro = unbound.metro;
	patcher = unbound.patcher;
	toasts = unbound.toasts;
}

var Patcher = patcher && patcher.createPatcher
	? patcher.createPatcher('show-hidden-channels')
	: null;

function toast(title, content) {
	try {
		if (toasts && toasts.showToast) {
			toasts.showToast({ title: title, content: content || '', duration: 4000 });
			return;
		}
	} catch (_) {}
	console.log('[ShowHiddenChannels]', title, content || '');
}

function findPermissions() {
	if (!metro) return null;
	var tries = [
		function () { return metro.findStore && metro.findStore('Permission'); },
		function () { return metro.findByProps('getChannelPermissions', 'can'); },
		function () { return metro.findByProps('can', 'canWithPartialContext'); },
		function () { return metro.findByProps('can'); },
	];
	for (var i = 0; i < tries.length; i++) {
		try {
			var m = tries[i]();
			if (m && typeof m.can === 'function') return m;
		} catch (_) {}
	}
	return null;
}

function findViewChannel() {
	if (!metro) return 1024;
	try {
		var P = metro.common && metro.common.Constants && metro.common.Constants.Permissions;
		if (P && P.VIEW_CHANNEL != null) return P.VIEW_CHANNEL;
	} catch (_) {}
	try {
		var c = metro.findByProps('Permissions', 'ChannelTypes');
		if (c && c.Permissions && c.Permissions.VIEW_CHANNEL != null) return c.Permissions.VIEW_CHANNEL;
	} catch (_) {}
	try {
		var c2 = metro.findByProps('VIEW_CHANNEL', 'SEND_MESSAGES');
		if (c2 && c2.VIEW_CHANNEL != null) return c2.VIEW_CHANNEL;
	} catch (_) {}
	try {
		return BigInt(1024);
	} catch (_) {
		return 1024;
	}
}

function isViewPerm(permID, VIEW) {
	if (permID === VIEW) return true;
	try {
		if (BigInt(permID) === BigInt(VIEW)) return true;
	} catch (_) {}
	return String(permID) === String(VIEW);
}

function forceRefresh() {
	if (!metro) return;
	try {
		var Dispatcher =
			(metro.common && metro.common.Dispatcher) ||
			metro.findByProps('_currentDispatchActionType', '_processingWaitQueue');
		if (!Dispatcher) return;
		var graph = Dispatcher._actionHandlers && Dispatcher._actionHandlers._dependencyGraph;
		var nodes = graph && graph.nodes ? Object.values(graph.nodes) : [];
		for (var i = 0; i < nodes.length; i++) {
			var node = nodes[i];
			if (!node || !node.actionHandler) continue;
			try {
				if (node.name === 'PermissionStore') {
					var h1 = node.actionHandler.CONNECTION_OPEN || node.actionHandler.handleConnectionOpen;
					if (typeof h1 === 'function') h1({});
				}
				if (node.name === 'ChannelListStore') {
					var h2 = node.actionHandler.CONNECTION_OPEN || node.actionHandler.handleReset;
					if (typeof h2 === 'function') h2({});
				}
			} catch (_) {}
		}
	} catch (_) {}
}

function start() {
	if (!metro || !Patcher) {
		toast('ShowHiddenChannels', 'ERREUR: API Unbound introuvable');
		return;
	}

	var Permissions = findPermissions();
	var VIEW = findViewChannel();

	if (!Permissions || typeof Permissions.can !== 'function') {
		toast('ShowHiddenChannels', 'ERREUR: Permissions.can introuvable');
		return;
	}

	Patcher.after(Permissions, 'can', function (ctx) {
		try {
			var args = ctx.args;
			var permID = args[0];
			var channel = args[1];
			if (channel && channel.realCheck) return ctx.result;
			if (isViewPerm(permID, VIEW)) return true;
		} catch (_) {}
		return ctx.result;
	});

	if (typeof Permissions.canWithPartialContext === 'function') {
		Patcher.after(Permissions, 'canWithPartialContext', function (ctx) {
			try {
				var args = ctx.args;
				if (args[1] && args[1].realCheck) return ctx.result;
				if (isViewPerm(args[0], VIEW)) return true;
			} catch (_) {}
			return ctx.result;
		});
	}

	forceRefresh();
	toast('ShowHiddenChannels', 'Actif v1.3.0 — change de serveur puis reviens');
}

function stop() {
	if (Patcher) Patcher.unpatchAll();
	forceRefresh();
	toast('ShowHiddenChannels', 'Desactive');
}

module.exports = { start: start, stop: stop };
module.exports.default = module.exports;
