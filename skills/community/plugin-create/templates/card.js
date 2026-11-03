(() => {
  const { React, Button, Checkbox, Input, mount } = window.scholarseedUI;
  const element = React.createElement;
  const labels = {
    zh: { save: "保存草稿", confirm: "确认", revise: "调整后继续", finish: "结束本轮", saved: "草稿已保存", dirty: "有未保存的修改", failed: "保存失败，选择仍保留", pending: "等待回答", submitting: "等待宿主确认", resolved: "已确认", cancelled: "已取消", stale: "交互已过期", unknown: "结果待核实" },
    en: { save: "Save draft", confirm: "Confirm", revise: "Continue with revision", finish: "Finish round", saved: "Draft saved", dirty: "Unsaved changes", failed: "Save failed; choices retained", pending: "Waiting for answer", submitting: "Waiting for host", resolved: "Confirmed", cancelled: "Cancelled", stale: "Expired interaction", unknown: "Outcome unknown" }
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
        setFeedback("failed");
      } finally {
        setSaving(false);
      }
    }

    React.useEffect(() => {
      if (editing.current !== saved.current || !Object.hasOwn(state.draft ?? {}, "selected")) return;
      current.current = initial();
      setValues(current.current);
    }, [state.draft]);

    const actions = state.data.actions ?? ["confirm"];
    return element("section", { className: "grid gap-[var(--vds-space-3)]", "aria-label": state.data.title },
      element("h3", null, state.data.title),
      element("p", null, state.data.description),
      ...(state.data.choices ?? []).map(choice => element(Checkbox, {
        key: choice.id, checked: values.selected.includes(choice.id), disabled: !pending,
        onCheckedChange: () => choose(choice.id)
      }, element("span", null, choice.label,
        choice.description && element("span", { className: "block text-[var(--vds-text-secondary)]" }, choice.description)))),
      ...(state.data.fields ?? []).map(field => element(Input, {
        key: field.id, label: field.label, placeholder: field.placeholder,
        value: values.fields[field.id], disabled: !pending,
        onChange: event => edit({ ...current.current, fields: { ...current.current.fields, [field.id]: event.target.value } })
      })),
      feedback && element("p", { role: feedback === "failed" ? "alert" : "status" }, text[feedback]),
      element("p", { role: "status" }, text[state.status] ?? state.status),
      element("div", { className: "flex flex-wrap justify-end gap-[var(--vds-space-2)]" },
        element(Button, { disabled: !pending || saving, onClick: save }, text.save),
        ...actions.map(action => element(Button, {
          key: action, disabled: !pending || saving || values.selected.length === 0,
          onClick: () => window.plugin.submit(action, structuredClone(current.current))
        }, text[action] ?? action)))
    );
  }
  mount(state => element(Card, { state }));
})();
