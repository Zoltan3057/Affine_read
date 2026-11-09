// 描述了一个文档数据源（Document Source） 的抽象。它通常用于协作编辑（如 Yjs/Automerge 这类 CRDT 库）或分布式同步场景，定义了本地与远端（或存储层）之间同步文档数据的约定。
export interface DocSource {
  /**
   * for debug
   */
  name: string;

  pull(
    docId: string,
    state: Uint8Array
  ):
    | Promise<{ data: Uint8Array; state?: Uint8Array } | null>
    | { data: Uint8Array; state?: Uint8Array }
    | null;
  push(docId: string, data: Uint8Array): Promise<void> | void;

  /**
   * Subscribe to updates from peer
   *
   * @param cb callback to handle updates
   * @param disconnect callback to handle disconnect, reason can be something like 'network-error'
   *
   * @returns unsubscribe function
   */
  subscribe(
    cb: (docId: string, data: Uint8Array) => void,
    disconnect: (reason: string) => void
  ): Promise<() => void> | (() => void);
}
