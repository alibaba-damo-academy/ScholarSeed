(() => {
  const { React, Button, Checkbox, Input, mount } = window.scholarseedUI;
  const element = React.createElement;
  const wrap = { minWidth: 0, maxWidth: "100%", overflowWrap: "anywhere" };
  const detailsStyle = {
    ...wrap,
    marginInlineStart: "var(--vds-space-3)",
    color: "var(--vds-text-secondary)"
  };
  const actionStyle = {
    ...wrap,
    height: "auto",
    minHeight: "var(--vds-control-height-md)",
    whiteSpace: "normal",
    textAlign: "center"
  };
  const labels = {
    zh: { evidence: "查看出处", saving: "正在保存草稿", save: "保存草稿", confirm: "确认所选项", revise: "调整所选项", finish: "提交所选项", saved: "草稿已保存", dirty: "有未保存的修改", saveFailed: "保存草稿失败，选择仍保留。可重试保存。", failed: "提交失败。请查看宿主提示。", submitting: "等待宿主确认", resolved: "已确认", cancelled: "已取消", stale: "交互已过期", unknown: "结果待核实" },
    en: { evidence: "View source", saving: "Saving draft", save: "Save draft", confirm: "Confirm selection", revise: "Revise selection", finish: "Submit selection", saved: "Draft saved", dirty: "Unsaved changes", saveFailed: "Draft save failed. Your choices are still here. You can retry saving.", failed: "Submission failed. See the host message.", submitting: "Waiting for host", resolved: "Confirmed", cancelled: "Cancelled", stale: "Expired interaction", unknown: "Outcome unknown" }
  };

  function Card({ state }) {
    const text = labels[state.language.startsWith("zh") ? "zh" : "en"];
    const initial = () => ({
      selected: structuredClone(state.draft?.selected ?? state.data.selected ?? []),
      ...((state.data.fields ?? []).length ? { fields: Object.fromEntries(state.data.fields.map(field => [field.id, state.draft?.fields?.[field.id] ?? field.value ?? ""])) } : {})
    });
    const [values, setValues] = React.useState(initial);
    const current = React.useRef(values);
    const editing = React.useRef(0);
    const saved = React.useRef(0);
    const [saving, setSaving] = React.useState(false);
    const [feedback, setFeedback] = React.useState("");
    const pending = state.status === "pending";

    function edit(next) {
      current.current = next;
      editing.current += 1;
      setValues(next);
      setFeedback("dirty");
    }

    function choose(identifier) {
      const selected = current.current.selected.includes(identifier)
        ? current.current.selected.filter(value => value !== identifier)
        : [...current.current.selected, identifier];
      edit({ ...current.current, selected });
    }

    async function save() {
      const revision = editing.current;
      const snapshot = structuredClone(current.current);
      setSaving(true);
      try {
        await window.plugin.save(snapshot);
        saved.current = revision;
        setFeedback(editing.current === revision ? "saved" : "dirty");
      } catch {
        setFeedback("saveFailed");
      } finally {
        setSaving(false);
      }
    }

    React.useEffect(() => {
      if (!Object.hasOwn(state.draft ?? {}, "selected")) return;
      if (state.status !== "resolved" && editing.current !== saved.current) return;
      current.current = initial();
      setValues(current.current);
    }, [state.draft, state.status]);

    const actions = state.data.actions ?? ["confirm"];
    const primaryAction = actions.includes("finish") ? "finish" : "confirm";
    return element("section", {
      className: "grid gap-[var(--vds-space-3)]", "aria-label": state.data.title, style: wrap
    },
      state.data.lead && element("h3", {
        style: { ...wrap, fontSize: "var(--vds-font-subhead)", lineHeight: "var(--vds-lh-subhead)", fontWeight: "var(--vds-fw-medium)" }
      }, state.data.lead),
      state.data.description && element("p", { style: detailsStyle }, state.data.description),
      ...(state.data.choices ?? []).map(choice => element("div", { key: choice.id, style: wrap },
        element(Checkbox, {
          checked: values.selected.includes(choice.id), disabled: !pending,
          onCheckedChange: () => choose(choice.id)
        }, element("span", { style: wrap }, choice.label)),
        choice.values?.length ? element("dl", {
          style: { ...detailsStyle, display: "flex", flexWrap: "wrap", gap: "var(--vds-space-2) var(--vds-space-4)" }
        }, choice.values.map((fact, index) => element("div", { key: index, style: wrap },
          element("dt", null, fact.label),
          element("dd", {
            style: { ...wrap, margin: 0, color: "var(--vds-text-primary)", fontVariantNumeric: "tabular-nums", fontWeight: "var(--vds-fw-medium)" }
          }, fact.value)))) : null,
        choice.description && element("p", { style: detailsStyle }, choice.description),
        choice.evidence && element("details", { style: detailsStyle },
          element("summary", null, text.evidence),
          element("p", null, choice.evidence)))),
      ...(state.data.fields ?? []).map(field => element(Input, {
        key: field.id, label: field.label, placeholder: field.placeholder,
        value: values.fields[field.id], disabled: !pending,
        onChange: event => edit({ ...current.current, fields: { ...current.current.fields, [field.id]: event.target.value } })
      })),
      pending && (saving || feedback) && element("p", {
        role: !saving && feedback === "saveFailed" ? "alert" : "status"
      }, text[saving ? "saving" : feedback]),
      !pending && element("p", { role: "status" }, text[state.status] ?? text.unknown),
      element("div", { className: "flex flex-wrap justify-end gap-[var(--vds-space-2)]" },
        element(Button, {
          variant: "secondary", size: "md", style: actionStyle,
          disabled: !pending || saving, onClick: save
        }, text.save),
        ...actions.map(action => element(Button, {
          key: action, variant: action === primaryAction ? "primary" : "secondary",
          size: "md", style: actionStyle, disabled: !pending || saving || values.selected.length === 0,
          onClick: () => window.plugin.submit(action, structuredClone(current.current))
        }, state.data.action_labels?.[action] ?? text[action] ?? action)))
    );
  }
  mount(state => element(Card, { state }));
})();
