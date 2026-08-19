// dsh-compaction-tool — browser (client) half.
//
// Registers a **"压缩 (Compaction)" section** into the `settings.section` list slot
// (the settings side-panel). The section shows and edits ALL compaction
// settings in one place:
//
//   - 压缩模型 (provider + model id) — a dropdown of available models (llm.models)
//   - 触发阈值 (0..1) — occupancy fraction that engages auto-compaction
//   - 保留最近消息 — recent tail retained verbatim (messages)
//   - 保留最近轮次 — fallback tail (turns)
//   - 最大输出 token — output cap for the summarization call
//   - 自动压缩 — toggle for the pressure-driven agent/pre-step hook
//
// All reads/writes go through the `connection.api.settings.*` wire face
// (describe / mutate). The model list comes from `api.llm.models` (host-scoped,
// no sessionId needed — the same catalog `session.models` serves per-session).
//
// The host half reads the `compaction` settings namespace LIVE on every
// compress_context / /compact / auto-hook call, so whichever values are
// currently set are the ones used — nothing is hardcoded.
//
// Defensive design: the entire apply() is wrapped in try/catch. A failure
// degrades to "no settings section" — it can never break the conversation UI
// or the command menu.
//
// This file ships via the package.json `dsh.client` declaration (discovered
// through `exports["./client"]`). It is a PURE UI plugin: no host behavior.

window.__ModuleLoader__.load({
  id: "dsh-compaction-tool",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;

    const COMPACTION_NS = "compaction";

    /* ------------------------------------------------------------------ */
    /* Wire helpers (best-effort, never throw)                             */
    /* ------------------------------------------------------------------ */

    /** Read the current compaction settings from settings.describe (best-effort). */
    async function currentSettings(api) {
      try {
        const { result } = await api.settings.describe({});
        if (result.ok) {
          const ns = (result.value?.namespaces ?? []).find((n) => n.ns === COMPACTION_NS);
          if (ns?.value) return ns.value;
          // Namespace not registered — host plugin not loaded.
          return { _missing: true };
        }
      } catch { /* settings service absent */ }
      return null;
    }

    /** Write one field via settings.mutate (path-addressed, safe). */
    async function setField(api, field, value) {
      const { result } = await api.settings.mutate({
        ns: COMPACTION_NS,
        ops: [{ op: "set", path: [field], value }],
      });
      if (!result.ok) {
        const raw = result.error?.message ?? result.error?.code ?? "settings update failed";
        if (String(raw).includes("not registered")) {
          throw new Error("压缩设置命名空间未注册 — 请确认 host 插件 dsh-compaction-tool 已加载。重启 DSH 后重试。");
        }
        throw new Error(raw);
      }
      return result.value;
    }

    /** List selectable models via the host-scoped llm.models API (no sessionId needed). */
    async function modelRows(api) {
      const { result } = await api.llm.models({});
      if (!result.ok) throw new Error(result.error?.message ?? result.error?.code ?? "模型列表加载失败");
      const groups = result.value?.groups ?? [];
      const rows = [];
      for (const group of groups) {
        for (const model of group.models ?? []) {
          rows.push({
            id: `${group.id}/${model.id}`,
            label: model.name ?? model.id,
            detail: group.name ?? group.id,
          });
        }
      }
      return rows;
    }

    /** Split an opaque row id back into its provider/model pair. */
    function splitModelId(id) {
      const slash = id.indexOf("/");
      if (slash <= 0 || slash === id.length - 1) return null;
      return { provider: id.slice(0, slash), model: id.slice(slash + 1) };
    }

    /* ------------------------------------------------------------------ */
    /* React component (Chinese UI)                                        */
    /* ------------------------------------------------------------------ */

    function CompactionSection({ api, close }) {
      const [settings, setSettings] = React.useState(null);
      const [nsMissing, setNsMissing] = React.useState(false);
      const [rows, setRows] = React.useState([]);
      const [modelOpen, setModelOpen] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);

      // Load current settings on mount.
      React.useEffect(() => {
        let cancelled = false;
        currentSettings(api)
          .then((v) => {
            if (!cancelled) {
              setSettings(v);
              setNsMissing(!!v?._missing);
            }
          })
          .catch(() => {});
        return () => { cancelled = true; };
      }, [api]);

      // Load model list when the dropdown opens.
      React.useEffect(() => {
        if (!modelOpen) return;
        let cancelled = false;
        modelRows(api)
          .then((r) => { if (!cancelled) { setRows(r); setError(null); } })
          .catch((e) => { if (!cancelled) setError(e.message ?? String(e)); });
        return () => { cancelled = true; };
      }, [api, modelOpen]);

      async function write(field, value) {
        setBusy(true);
        setError(null);
        try {
          await setField(api, field, value);
          const updated = await currentSettings(api);
          if (updated) setSettings(updated);
        } catch (e) {
          setError(e.message ?? String(e));
        } finally {
          setBusy(false);
        }
      }

      function pickModel(row) {
        const parts = splitModelId(row.id);
        if (!parts) return;
        setBusy(true);
        setError(null);
        (async () => {
          try {
            await setField(api, "provider", parts.provider);
            await setField(api, "model", parts.model);
            const updated = await currentSettings(api);
            if (updated) setSettings(updated);
            setModelOpen(false);
          } catch (e) {
            setError(e.message ?? String(e));
          } finally {
            setBusy(false);
          }
        })();
      }

      const cur = settings ?? {};
      const currentModel = cur.model
        ? (cur.provider ? cur.provider + "/" : "") + cur.model
        : "（未设置 — 将使用主模型）";

      // Row styles (theme-aware).
      const rowStyle = {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "12px",
        padding: "10px 0",
        borderBottom: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.15))",
      };
      const labelStyle = {
        fontSize: "13px",
        color: "var(--dsw-alias-label-secondary, #ccc)",
        flexShrink: 0,
      };
      const descStyle = {
        fontSize: "11px",
        color: "var(--dsw-alias-label-tertiary, #888)",
        marginTop: "2px",
      };
      const controlStyle = {
        background: "var(--dsw-alias-interactive-bg, transparent)",
        border: "1px solid var(--dsw-alias-border-l3, #3a3a3a)",
        borderRadius: "6px",
        color: "var(--dsw-alias-label-primary, #eee)",
        padding: "4px 8px",
        fontSize: "13px",
        minWidth: "100px",
        maxWidth: "220px",
      };

      // If the host namespace is missing, show a setup hint.
      if (nsMissing) {
        return h(
          "div",
          { style: { padding: "20px" } },
          h("h2", { style: { fontSize: "15px", fontWeight: 600, margin: "0 0 8px 0" } }, "压缩设置"),
          h("p", { style: { fontSize: "13px", lineHeight: 1.6, color: "var(--dsw-alias-label-secondary, #ccc)" } },
            "host 插件 dsh-compaction-tool 的设置命名空间（compaction）未注册。"),
          h("ul", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #999)", paddingLeft: "20px", lineHeight: 1.8 } },
            h("li", null, "确认 dsh-compaction-tool 已安装到当前 profile 的 node_modules"),
            h("li", null, "确认 cordis.patch.yml 中该插件未被 disabled"),
            h("li", null, "重启 DSH（pnpm dsh web）后重新打开设置面板"),
          ),
        );
      }

      return h(
        "div",
        { style: { padding: "16px 20px", fontFamily: "inherit", color: "var(--dsw-alias-label-primary, #eee)" } },
        // Title
        h("h2", { style: { fontSize: "15px", fontWeight: 600, margin: "0 0 4px 0" } }, "上下文压缩"),
        h("p", { style: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #999)", margin: "0 0 16px 0" } },
          "将上下文压缩卸载到快速辅助模型。所有参数实时生效，无需重启。"),

        // Error banner
        error
          ? h("div", { style: { padding: "8px 12px", marginBottom: "12px", borderRadius: "6px", background: "rgba(229,87,87,0.12)", border: "1px solid rgba(229,87,87,0.3)", color: "#e57", fontSize: "12px" } }, error)
          : null,

        // Model selector
        h("div", { style: rowStyle },
          h("div", { style: { flex: "1" } },
            h("span", { style: labelStyle }, "压缩模型"),
            h("div", { style: descStyle }, "用于生成摘要的辅助模型"),
          ),
          h("div", { style: { position: "relative", display: "flex", justifyContent: "flex-end" } },
            h("button", {
              type: "button",
              style: { ...controlStyle, cursor: busy ? "wait" : "pointer", display: "inline-flex", alignItems: "center", gap: "6px", textAlign: "right" },
              onClick: () => setModelOpen((o) => !o),
              disabled: busy,
            },
              h("span", { style: { maxWidth: "180px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, currentModel),
              h("span", { style: { opacity: 0.5, fontSize: "10px" } }, modelOpen ? "▴" : "▾"),
            ),
            modelOpen
              ? h("div", {
                  style: {
                    position: "absolute", bottom: "calc(100% + 6px)", right: "0", zIndex: 100,
                    minWidth: "280px", maxHeight: "300px", overflow: "auto",
                    background: "var(--dsw-specific-menu, #1e1e1e)",
                    border: "1px solid var(--dsw-alias-border-inverted, #444)",
                    borderRadius: "8px", padding: "4px",
                    boxShadow: "var(--dsw-shadow-lv3, 0 4px 16px rgba(0,0,0,0.4))",
                  },
                },
                  rows.length === 0 && !error
                    ? h("div", { style: { padding: "10px", fontSize: "12px", color: "#999" } }, "加载模型列表…")
                    : error
                    ? h("div", { style: { padding: "10px", fontSize: "12px", color: "#e57" } }, error)
                    : rows.map((row) =>
                        h("button", {
                          key: row.id,
                          type: "button",
                          style: {
                            display: "flex", alignItems: "center", gap: "6px",
                            width: "100%", padding: "7px 10px", cursor: "pointer",
                            border: "none", borderRadius: "5px", background: "transparent",
                            color: "inherit", fontSize: "12px", textAlign: "left",
                          },
                          onMouseEnter: (e) => { e.currentTarget.style.background = "var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.06))"; },
                          onMouseLeave: (e) => { e.currentTarget.style.background = "transparent"; },
                          onClick: () => pickModel(row),
                        },
                          h("span", { style: { flex: "1", overflow: "hidden", textOverflow: "ellipsis" } }, row.label),
                          h("span", { style: { fontSize: "10px", opacity: 0.5, flexShrink: 0 } }, row.detail),
                        )
                      )
                )
              : null,
          ),
        ),

        // Threshold ratio
        h("div", { style: rowStyle },
          h("div", { style: { flex: "1" } },
            h("span", { style: labelStyle }, "触发阈值"),
            h("div", { style: descStyle }, "上下文占用超过此比例时触发自动压缩 (0–1)"),
          ),
          h("input", {
            type: "number", min: "0", max: "1", step: "0.05",
            value: cur.thresholdRatio ?? 0.8,
            style: { ...controlStyle, width: "90px", textAlign: "right" },
            onChange: (e) => { const v = parseFloat(e.target.value); if (!isNaN(v) && v >= 0 && v <= 1) write("thresholdRatio", v); },
            disabled: busy,
          }),
        ),

        // Keep last N messages
        h("div", { style: rowStyle },
          h("div", { style: { flex: "1" } },
            h("span", { style: labelStyle }, "保留最近消息数"),
            h("div", { style: descStyle }, "压缩后原样保留的最近消息条数"),
          ),
          h("input", {
            type: "number", min: "0", step: "1",
            value: cur.keepLastNMessages ?? 10,
            style: { ...controlStyle, width: "90px", textAlign: "right" },
            onChange: (e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v) && v >= 0) write("keepLastNMessages", v); },
            disabled: busy,
          }),
        ),

        // Keep last N turns
        h("div", { style: rowStyle },
          h("div", { style: { flex: "1" } },
            h("span", { style: labelStyle }, "保留最近轮次数"),
            h("div", { style: descStyle }, "当消息数未指定时按轮次保留（回退值）"),
          ),
          h("input", {
            type: "number", min: "0", step: "1",
            value: cur.keepLastNTurns ?? 3,
            style: { ...controlStyle, width: "90px", textAlign: "right" },
            onChange: (e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v) && v >= 0) write("keepLastNTurns", v); },
            disabled: busy,
          }),
        ),

        // Summary max tokens
        h("div", { style: rowStyle },
          h("div", { style: { flex: "1" } },
            h("span", { style: labelStyle }, "摘要最大 token"),
            h("div", { style: descStyle }, "摘要模型输出的 token 上限"),
          ),
          h("input", {
            type: "number", min: "1", step: "64",
            value: cur.summaryMaxTokens ?? 1024,
            style: { ...controlStyle, width: "110px", textAlign: "right" },
            onChange: (e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v) && v >= 1) write("summaryMaxTokens", v); },
            disabled: busy,
          }),
        ),

        // Auto-compaction toggle
        h("div", { style: rowStyle },
          h("div", { style: { flex: "1" } },
            h("span", { style: labelStyle }, "自动压缩"),
            h("div", { style: descStyle }, "压力驱动：每步前检查上下文占用，超过阈值时自动压缩"),
          ),
          h("label", { style: { display: "inline-flex", alignItems: "center", gap: "6px", cursor: "pointer" } },
            h("input", {
              type: "checkbox",
              checked: cur.autoCompaction ?? false,
              onChange: (e) => write("autoCompaction", e.target.checked),
              disabled: busy,
            }),
          ),
        ),

        // Busy indicator
        busy
          ? h("div", { style: { marginTop: "12px", fontSize: "11px", color: "var(--dsw-alias-label-tertiary, #888)" } }, "保存中…")
          : null,
      );
    }

    /* ------------------------------------------------------------------ */
    /* apply — register the settings.section entry                         */
    /* ------------------------------------------------------------------ */

    const inject = ["slots", "connection"];

    function apply(ctx) {
      try {
        const slots = ctx.get("slots");
        const connection = ctx.get("connection");
        if (!slots || typeof slots.inject !== "function" || typeof slots.register !== "function") return;
        if (!connection || !connection.api) return;
        const api = connection.api;

        // Register the "压缩" page into the settings section list.
        slots.inject("settings.section", () =>
          slots.register(
            {
              name: "settings.section",
              id: "compaction",
              order: 30,
              label: () => "压缩",
              inject: () => ({ api }),
            },
            CompactionSection
          )
        );
      } catch (error) {
        if (ctx && ctx.logger && typeof ctx.logger.warn === "function") {
          try { ctx.logger.warn("dsh-compaction-tool client: " + (error && error.message ? error.message : String(error))); } catch { /* ignore */ }
        }
      }
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
