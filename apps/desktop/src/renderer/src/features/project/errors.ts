/**
 * 外部根授权/撤销错误码的文案单一真源（proposal 47 §5.1）。
 *
 * `/api/content/roots` 的错误码有两个消费面：项目面板的「关联本地目录」与资料库
 * 导入弹窗的「关联原文件」。各自维护一张表会让其中一面漏码、把原始码直接甩给
 * 用户，所以这里只留一张。
 *
 * 不含 `source_not_found`：同一个码在「选的是目录」与「选的是文件」两条流里该说的
 * 话不一样，由各消费面自己给文案。
 */
export const ROOT_ERROR_TEXT: Record<string, string> = {
  mount_conflict: '资料库里已有同名条目，请改个挂载名',
  mount_required: '挂载名不能为空',
  invalid_mount: '挂载名不能包含路径分隔符',
  root_exists: '这个文件或文件夹已经关联过了',
  unknown_root: '这条关联已不在登记表里',
  root_already_revoked: '这条关联已经撤销过了',
  source_not_supported: '只能关联普通文件或文件夹',
  source_inside_project: '这个文件或文件夹已经在项目里，不需要关联',
  source_contains_project: '不能关联包含本项目的上级目录',
  source_overlap: '该目录已被父级关联覆盖',
  source_covers_links: '它的子目录已单独关联，请在资料库里关联该父目录以取代子关联'
}
