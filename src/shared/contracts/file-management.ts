/** 文件管理增强与 Host 之间传输的会话修改文件契约。 */

export interface SessionChangedFiles {
  /** 按工作区相对路径规范化后的文件路径。 */
  readonly paths: readonly string[]
}
