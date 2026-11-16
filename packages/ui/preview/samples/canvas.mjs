export const canvasExamples = {
  Canvas: [
    { id: 'openui-interactive', label: 'OpenUI：备注与选择', data: {
      title: '研究参数（合成示例）', status: 'pending', document: {
        format: 'openui-lang', version: 1,
        source: 'root = Stack([heading, note, slider])\nheading = TextContent("本地调整不会调用模型", "default")\nnote = Input("note", "输入备注")\nslider = Slider("range", "continuous", 0, 100, 1, [50], "阈值")',
        initial_state: {}, interaction: { actions: ['rollback', 'cancel', 'submit'], output_schema: { type: 'object' } },
      },
    } },
    { id: 'openui-display', label: 'OpenUI：仅展示，不等待', data: {
      title: '只读说明', status: 'resolved', document: { format: 'openui-lang', version: 1,
        source: 'root = Stack([TextContent("只读画布：没有决策按钮，不挂起 Agent。", "default")])' },
    } },
    { id: 'html-interactive', label: 'HTML / JS：页面回调', data: {
      title: '自定义沙箱示例', status: 'pending', document: {
        format: 'html', version: 1,
        source: '<label>备注 <input id="note" aria-label="备注"></label><p id="status">本地修改不会调用模型。</p><script>const input = document.getElementById("note"); input.addEventListener("input", () => canvas.save({note: input.value})); canvas.register({onRestore(state){input.value=state.note??""},onRollback(){input.value="";return {note:""}},onCancel(){document.getElementById("status").textContent="已取消"},onSubmit(){return {note:input.value}}});</script>',
        initial_state: { note: '' }, interaction: { actions: ['rollback', 'cancel', 'submit'], output_schema: { type: 'object', properties: { note: { type: 'string' } }, required: ['note'], additionalProperties: false } },
      },
    } },
  ],
}
