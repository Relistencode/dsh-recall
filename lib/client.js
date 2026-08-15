// Browser half of dsh-recall: a custom ToolView for the `recall` tool.
//
// While the tool runs, the row shows a sweeping light over "回忆中…" (the
// tool is invisible/autonomous by design — the user just sees a quiet recall
// animation). When it settles, the row collapses to a single quiet status
// line ("回忆完成" / error) — the agent surfaces the actual results in its
// reply, so the UI stays minimal and costs no model context.
//
// This file is served verbatim by the host's client-modules bundle route and
// executed through the lazy CJS module table. No bundler/transpiler runs on
// it — plain ES2017-ish JS.
window.__ModuleLoader__.load({
	id: "dsh-recall",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");

		// ── styles ──────────────────────────────────────────────────────────────
		var CSS_ID = "dsh-recall/styles";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"" + CSS_ID + "\"]") === null) {
			var tag = document.createElement("style");
			tag.dataset.plugin = "dsh-recall";
			tag.dataset.pluginCss = CSS_ID;
			tag.textContent = [
				".rcl-row{display:flex;align-items:center;gap:8px;min-height:24px;padding:2px 0;color:var(--dsw-alias-label-secondary,#646a73);font-size:14px;line-height:24px;position:relative;overflow:hidden}",
				".rcl-icon{flex:none;width:16px;height:16px;color:var(--dsw-alias-label-tertiary,#8f959e)}",
				".rcl-text{flex:auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
				// 回忆中：文字上一道光波扫过（与官方工具行 sweep 同风格，纯 CSS）
				".rcl-recalling .rcl-text::after{content:\"\";position:absolute;top:0;bottom:0;width:140px;background:linear-gradient(90deg,transparent 0%,color-mix(in srgb,var(--dsw-alias-bg-base) 45%,transparent) 55%,transparent 100%);pointer-events:none;animation:1.8s ease-out infinite rcl-sweep}",
				"@keyframes rcl-sweep{0%{left:-140px}90%,to{left:100%}}",
				".rcl-done{color:var(--dsw-alias-label-tertiary,#8f959e)}",
				".rcl-error{color:var(--dsw-alias-state-error-primary,#d54941)}",
			].join("");
			// The style tag must be inserted into the DOM for the CSS to apply.
			document.head.appendChild(tag);
		}

		// ── i18n ────────────────────────────────────────────────────────────────
		var NS = "recall";
		var zh = {
			"recalling": "回忆中…",
			"done": "回忆完成",
			"failed": "回忆失败",
		};
		var en = {
			"recalling": "Recalling…",
			"done": "Recall complete",
			"failed": "Recall failed",
		};

		var tRef = null;

		// ── component ───────────────────────────────────────────────────────────
		function h(type, props) {
			var args = [type, props];
			for (var i = 2; i < arguments.length; i++) args.push(arguments[i]);
			return React.createElement.apply(React, args);
		}

		// tool.call.toolview owner props: { callId, toolName, block, cwd, openFile, inspect } + t
		function RecallToolView(props) {
			// The slot shell may or may not inject `t`; fall back to the apply-time
			// bound translator.
			var t = (props && props.t) || tRef;
			var block = props && props.block;
			var settled = !!block && block.kind === "tool-result";
			var isError = settled && !!block.isError;
			var errorText = "";
			if (isError && block.error) {
				errorText = String(block.error.name || "") + (block.error.code ? ": " + block.error.code : "");
			}
			var icon = h("svg", { className: "rcl-icon", viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
				h("path", { d: "M8 2a5 5 0 1 0 4.9 6.5", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round" }),
				h("path", { d: "M8 5v3l2 1.5", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" }));
			var cls = "rcl-row" + (settled ? (isError ? " rcl-error" : " rcl-done") : " rcl-recalling");
			var text = settled ? (isError ? t("failed") + (errorText !== "" ? " · " + errorText : "") : t("done")) : t("recalling");
			return h("div", { className: cls },
				icon,
				h("span", { className: "rcl-text" }, text));
		}

		// ── plugin face ─────────────────────────────────────────────────────────
		var inject = ["slots", "locale"];
		async function apply(ctx) {
			ctx.locale.register(NS, { zh, en });
			tRef = ctx.locale.bind(NS);
			ctx.slots.inject("tool.call.toolview", function* () {
				yield ctx.slots.register({
					name: "tool.call.toolview",
					key: "recall",
					locale: NS,
				}, RecallToolView);
			});
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
